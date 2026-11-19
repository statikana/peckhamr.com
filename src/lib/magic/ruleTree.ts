import { compileCard } from './compiler/index.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './runtime/faces.ts';
import { displayAbilityText } from './compiler/support.ts';
import type { ActivatedAbility, Amount, CostDef, EffectStep, ModalDef, SpellAbility, TargetSpec, UnsupportedAbility } from './ir.ts';
import { buildReconfigureUnattachAbility, getKeywordSpec } from './keywords.ts';
import { describeCost, effectiveAbilityManaCost } from './runtime/costs.ts';
import { hasChooseAllModesOptionalCost, isCastConditionMet } from './runtime/kicker.ts';
import { evaluateAmount, evaluateCondition as evaluateFilterCondition, type FilterContext } from './runtime/objectFilter.ts';
import { getCardFaces } from './scryfall.ts';
// --- Track P7 ---
import { activeTimedLayer1aForPermanent } from './runtime/layerCache.ts';
// --- End Track P7 ---
// --- Track P10 ---
import { resolveQuotedAbilityDefs } from './runtime/reflexiveManaAndActions.ts';
// --- End Track P10 ---
// --- Track P12 ---
import {
	AWAKEN_LAND_TARGET_SPEC,
	collectBackupGrantedAbilityGroups
} from './runtime/keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P18a ---
import { mutateTargetSpec } from './runtime/keywordsWave6.ts';
// --- End Track P18a ---
// --- Track P22a ---
import { collectGrantedGraveyardActivatedAbilitiesWave8 } from './runtime/staticsWave8.ts';
// --- End Track P22a ---
import {
	evaluatePermanent,
	getAttachedAbilityStrippingAuraSources,
	inspectCardContinuousBreakdown,
	isTimedContinuousEffectActiveForState,
	permanentHasLostAllAbilities,
	permanentRetainsInnateManaAbilities,
	timedLayer6AbilitySurvivesRemoval,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent
} from './runtime/layers.ts';
import {
	checkGlobalCastPermissionsAndRestrictions,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame,
	resolveZoneChangeReplacements
} from './runtime/replace.ts';
import type {
	CardInstance,
	CastOption,
	EffectiveActivatedAbility,
	GamePhase,
	GameState,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	TargetRequirementInfo
} from './types.ts';

export const NO_TARGET_REQUIREMENT: TargetRequirementInfo = {
	requiresTarget: false,
	targetKind: 'none',
	minTargets: 0,
	maxTargets: 0,
	zone: 'none',
	sameGraveyard: false,
	controllerFilter: 'any'
};

/**
 * Translates compiled IR `TargetSpec[]` into a `TargetRequirementInfo` descriptor for cast/activation
 * validation and UI target selection.
 */
export function targetRequirementFromSpecs(specs: TargetSpec[]): TargetRequirementInfo {
	if (specs.length === 0) return NO_TARGET_REQUIREMENT;
	const minTargets = specs.reduce((s, x) => s + x.min, 0);
	const maxTargets = specs.reduce((s, x) => s + x.max, 0);
	const spec = specs[0];
	if (
		spec.kind === 'objectOrPlayer' ||
		(specs.length > 1 && specs.some((s) => s.kind !== spec.kind))
	) {
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'any',
			minTargets,
			maxTargets,
			zone: 'any',
			sameGraveyard: false,
			controllerFilter: 'any',
			targetSpecs: specs
		};
	}
	if (spec.kind === 'player') {
		const rel = spec.player?.relation ?? 'any';
		const controllerFilter =
			rel === 'opponent' || rel === 'each_opponent' ? 'opponent' : rel === 'you' ? 'you' : 'any';
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'player',
			minTargets,
			maxTargets,
			zone: 'player',
			sameGraveyard: false,
			controllerFilter,
			targetSpecs: specs
		};
	}
	const f = spec.filter;
	if (f.zone === 'stack') {
		const allSameController = specs.every((s) => (s.filter.controller ?? 'any') === (f.controller ?? 'any'));
		const controllerFilter = allSameController ? (f.controller ?? 'any') : 'any';
		const stackKind = f.stackKind;
		let cardTypeFilter: string | undefined;
		if (f.notTypes?.includes('Creature')) cardTypeFilter = 'Noncreature';
		else if (f.notTypes?.includes('Instant') && f.notTypes?.includes('Sorcery')) {
			cardTypeFilter = 'Permanent';
		} else if (f.types?.includes('Instant') && f.types?.includes('Sorcery')) {
			cardTypeFilter = 'InstantOrSorcery';
		} else if (f.types?.length === 1) {
			cardTypeFilter = f.types[0];
		}
		return {
			requiresTarget: minTargets > 0,
			targetKind: stackKind && stackKind !== 'spell' ? 'stack' : 'spell',
			...(stackKind ? { stackKind } : {}),
			minTargets,
			maxTargets,
			zone: 'stack',
			sameGraveyard: false,
			controllerFilter,
			...(cardTypeFilter ? { cardTypeFilter } : {}),
			targetSpecs: specs
		};
	}
	if (f.zone === 'graveyard' || f.zone === 'exile') {
		const controllerFilter = f.owner ?? f.controller ?? 'any';
		const sameGraveyard = f.zone === 'graveyard' && Boolean(spec.sameOwner || f.owner === 'you' || maxTargets <= 1);
		let cardTypeFilter: string | undefined;
		if (f.types?.includes('Instant') && f.types?.includes('Sorcery')) {
			cardTypeFilter = 'InstantOrSorcery';
		} else if (f.notTypes?.includes('Instant') && f.notTypes?.includes('Sorcery')) {
			cardTypeFilter = 'Permanent';
		} else if (f.notTypes?.includes('Land')) {
			cardTypeFilter = 'NonlandPermanent';
		} else if (f.types?.length === 1) {
			cardTypeFilter = f.types[0];
		}
		return {
			requiresTarget: minTargets > 0,
			targetKind: f.zone === 'exile' ? 'exile_card' : 'graveyard_card',
			minTargets,
			maxTargets,
			zone: f.zone,
			sameGraveyard,
			controllerFilter,
			...(cardTypeFilter ? { cardTypeFilter } : {}),
			targetSpecs: specs
		};
	}
	const allSameController = specs.every((s) => (s.filter.controller ?? 'any') === (f.controller ?? 'any'));
	const controllerFilter = allSameController ? (f.controller ?? 'any') : 'any';
	const allSameTypes =
		specs.length === 1 ||
		specs.every(
			(s) =>
				JSON.stringify(s.filter.types ?? null) === JSON.stringify(f.types ?? null) &&
				// --- Track P8 ---
				JSON.stringify(s.filter.allTypes ?? null) === JSON.stringify(f.allTypes ?? null) &&
				JSON.stringify(s.filter.notTypes ?? null) === JSON.stringify(f.notTypes ?? null) &&
				JSON.stringify(s.filter.subtypes ?? null) === JSON.stringify(f.subtypes ?? null) &&
				JSON.stringify(s.filter.supertypes ?? null) === JSON.stringify(f.supertypes ?? null)
		);
	let targetKind = 'permanent';
	let cardTypeFilter: string | undefined = 'Permanent';
	if (!allSameTypes) {
		targetKind = 'permanent';
		cardTypeFilter = undefined;
	} else if (f.allTypes?.length) {
		// --- Track P8 ---
		targetKind = f.allTypes.includes('Creature')
			? controllerFilter === 'you'
				? 'controlled_creature'
				: 'creature'
			: 'permanent';
		cardTypeFilter = f.allTypes.join('');
	} else if (f.types?.length === 1 && f.types[0] === 'Creature') {
		targetKind = controllerFilter === 'you' ? 'controlled_creature' : 'creature';
		const qual = [...(f.supertypes ?? []), ...(f.subtypes ?? [])];
		cardTypeFilter = qual.length > 0 ? `${qual.join(' ')} Creature` : 'Creature';
	} else if (f.types?.length === 2 && f.types.includes('Artifact') && f.types.includes('Enchantment')) {
		targetKind = 'artifact_or_enchantment';
		cardTypeFilter = 'ArtifactOrEnchantment';
	} else if (f.types?.length === 2 && f.types.includes('Artifact') && f.types.includes('Creature')) {
		targetKind = 'permanent';
		cardTypeFilter = 'ArtifactOrCreature';
	} else if (f.types?.length === 2 && f.types.includes('Creature') && f.types.includes('Planeswalker')) {
		targetKind = 'permanent';
		cardTypeFilter = 'CreatureOrPlaneswalker';
	} else if (f.notTypes?.includes('Land')) {
		targetKind = 'nonland_permanent';
		cardTypeFilter = 'NonlandPermanent';
	} else if (f.types?.length === 1) {
		targetKind = 'permanent';
		cardTypeFilter = f.types[0];
	} else if (f.types && f.types.length > 1) {
		targetKind = 'permanent';
		cardTypeFilter = f.types.join('Or');
	}
	return {
		requiresTarget: minTargets > 0,
		targetKind,
		minTargets,
		maxTargets,
		zone: 'battlefield',
		sameGraveyard: false,
		controllerFilter,
		...(cardTypeFilter ? { cardTypeFilter } : {}),
		targetSpecs: specs
	};
}

/**
 * Returns the spell target requirement for casting `card` (Instant, Sorcery, or Aura) from the
 * compiled IR. Non-Aura permanent spells do not target on the stack (CR 115.1b).
 */
export function modalTargetRequirement(
	modal: ModalDef,
	filterSpecs: (specs: TargetSpec[]) => TargetSpec[] = (s) => s
): TargetRequirementInfo {
	const branches = modal.modes.map((m) => targetRequirementFromSpecs(filterSpecs(m.targets)));
	const firstReq = branches.find((b) => b.requiresTarget) ?? branches[0] ?? NO_TARGET_REQUIREMENT;
	const anyReq = branches.some((b) => b.requiresTarget);
	return {
		requiresTarget: anyReq && modal.min > 0 && !modal.upTo,
		targetKind: firstReq.targetKind,
		minTargets: anyReq
			? Math.min(...branches.filter((b) => b.requiresTarget).map((b) => b.minTargets))
			: 0,
		maxTargets: Math.max(0, ...branches.map((b) => b.maxTargets)),
		zone: firstReq.zone,
		sameGraveyard: firstReq.sameGraveyard,
		controllerFilter: firstReq.controllerFilter,
		cardTypeFilter: firstReq.cardTypeFilter,
		isModal: true,
		modalBranches: branches
	};
}

export function getSpellTargetRequirement(
	card: ScryfallCard,
	option?: Partial<Pick<CastOption, 'faceIndex' | 'fused' | 'optionalAdditionalCosts' | 'spellMods'>>,
	optionalCostCounts?: Record<string, number>
): TargetRequirementInfo {
	if (option?.spellMods?.castFaceDown) {
		return NO_TARGET_REQUIREMENT;
	}
	// --- Track P18a: Mutate cast option targets non-Human creature with same owner (CR 702.140a) ---
	if (option?.spellMods?.mutating) {
		return targetRequirementFromSpecs([mutateTargetSpec()]);
	}
	// --- End Track P18a ---
	const faceOpts = {
		zone: 'stack' as const,
		faceIndex: option?.faceIndex ?? 0,
		fused: option?.fused,
		// --- Track P12 ---
		...(option?.spellMods?.bestowed ? { bestowed: true } : {}),
		// --- End Track P12 ---
		// --- Track P15 ---
		...(option?.spellMods?.cleaved ? { cleaved: true } : {}),
		...((optionalCostCounts?.['opt:gift'] ?? 0) > 0 ? { giftPromised: true } : {})
		// --- End Track P15 ---
	};
	const abilities = activeAbilityDefs(card, faceOpts);
	const chars = activeCharacteristics(card, faceOpts);
	const types = chars.types;
	const subtypes = chars.subtypes;
	const activeSpecs = (specs: TargetSpec[]) =>
		specs.filter((sp) => !sp.condition || isCastConditionMet(sp.condition, card, optionalCostCounts, option));
	if (subtypes.includes('Aura')) {
		const enchantSpecs: TargetSpec[] = [];
		for (const ab of abilities) {
			if (ab.kind === 'keyword') {
				const { name: kwName, enchantFilter, enchantPlayer } = ab.keyword;
				if (kwName === 'enchant') {
					if (enchantPlayer) {
						return targetRequirementFromSpecs([
							{
								kind: 'player',
								filter: {},
								player: enchantPlayer,
								min: 1,
								max: 1
							}
						]);
					}
					enchantSpecs.push({
						kind: 'object',
						filter: { zone: 'battlefield', ...(enchantFilter ?? {}) },
						min: enchantSpecs.length === 0 ? 1 : 0,
						max: enchantSpecs.length === 0 ? 1 : 0
					});
				}
			}
		}
		if (enchantSpecs.length > 0) {
			return targetRequirementFromSpecs(enchantSpecs);
		}
		return targetRequirementFromSpecs([
			{ kind: 'object', filter: { zone: 'battlefield' }, min: 1, max: 1 }
		]);
	}
	if (!types.includes('Instant') && !types.includes('Sorcery')) {
		return NO_TARGET_REQUIREMENT;
	}
	const nonModalSpecs: TargetSpec[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'spell') {
			if (ab.modal && !option?.fused) {
				// CR 702.42b: When Entwine (or another chooseAllModes optional cost) is paid,
				// all modes are chosen in printed order and their target specs combine sequentially.
				if (hasChooseAllModesOptionalCost(option, optionalCostCounts)) {
					nonModalSpecs.push(...ab.modal.modes.flatMap((m) => activeSpecs(m.targets)));
					continue;
				}
				return modalTargetRequirement(ab.modal, activeSpecs);
			}
			nonModalSpecs.push(...activeSpecs(ab.targets));
		} else if (ab.kind === 'unsupported' && ab.id === 'cast' && ab.targets) {
			nonModalSpecs.push(...activeSpecs(ab.targets));
		}
	}
	// --- Track P12: Awaken N adds "target land you control" (CR 702.113a) ---
	if ((option?.spellMods?.awakenCounters ?? 0) > 0) {
		nonModalSpecs.push(AWAKEN_LAND_TARGET_SPEC);
	}
	// --- End Track P12 ---
	// --- Track P15: Splice onto [subtype/type] appends spliced spell TargetSpecs (CR 702.47a,c) ---
	if (option?.optionalAdditionalCosts && optionalCostCounts) {
		for (const opt of option.optionalAdditionalCosts) {
			if (!opt.spliceCard || (optionalCostCounts[opt.id] ?? 0) <= 0) continue;
			const splicedCompiled = compileCard(opt.spliceCard);
			const splicedSpell = splicedCompiled.faces[0]?.abilities.find(
				(a): a is SpellAbility => a.kind === 'spell'
			);
			if (splicedSpell) {
				nonModalSpecs.push(...activeSpecs(splicedSpell.targets));
			}
		}
	}
	// --- End Track P15 ---
	return nonModalSpecs.length > 0 ? targetRequirementFromSpecs(nonModalSpecs) : NO_TARGET_REQUIREMENT;
}

export function filterActiveEffectSteps(steps: EffectStep[], condCtx?: FilterContext): EffectStep[] {
	return condCtx
		? steps.filter((s) => !s.condition || evaluateFilterCondition(s.condition, condCtx))
		: steps;
}

const FIVE_MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
const ALL_MANA_TYPES_ORDER: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
const BASIC_LAND_COLORS: ReadonlyArray<[string, ManaColor]> = [
	['Plains', 'W'],
	['Island', 'U'],
	['Swamp', 'B'],
	['Mountain', 'R'],
	['Forest', 'G']
];

const COMBAT_PHASES_SET: ReadonlySet<GamePhase> = new Set<GamePhase>([
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

const PRE_ATTACKER_PHASES_SET: ReadonlySet<GamePhase> = new Set<GamePhase>([
	'upkeep',
	'draw',
	'main1',
	'begin_combat'
]);

interface ExtractedManaPotential {
	direct: Set<ManaColor>;
	hasOppLandColors: boolean;
	hasCtrlLandTypes: boolean;
	hasCtrlLandColors: boolean;
}

export function effectiveBattlefieldCardAndFaceOpts(
	state: GameState,
	perm: CardInstance
): {
	timedLayer1a: ReturnType<typeof activeTimedLayer1aForPermanent>;
	effectiveCard: ScryfallCard;
	effectiveFaceOpts: ResolveObjectFacesOptions;
} {
	const timedLayer1a = activeTimedLayer1aForPermanent(state, perm);
	const effectiveCard =
		timedLayer1a?.card ?? perm.copiableState?.card ?? perm.copiableCard ?? perm.card;
	const baseFaceOpts = instanceFaceOptions(perm, 'battlefield');
	const effectiveFaceOpts: ResolveObjectFacesOptions = timedLayer1a
		? {
				...baseFaceOpts,
				copiableState: timedLayer1a,
				faceIndex: timedLayer1a.faceIndex ?? 0,
				isSingleFaceCopy: timedLayer1a.isSingleFaceCopy,
				prototyped: Boolean(timedLayer1a.prototyped)
			}
		: baseFaceOpts;
	return { timedLayer1a, effectiveCard, effectiveFaceOpts };
}

function commanderColorsOfPlayer(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>();
	for (const col of player.commanderColorIdentity ?? []) {
		if (col !== 'C') set.add(col);
	}
	const zones: Array<readonly CardInstance[]> = [
		player.command,
		player.battlefield,
		player.graveyard,
		player.exile,
		player.hand,
		player.library
	];
	for (const z of zones) {
		for (const c of z) {
			if (!c.isCommander || c.ownerId !== player.playerId) continue;
			for (const col of c.card.colorIdentity ?? []) {
				if (col !== 'C') set.add(col);
			}
		}
	}
	return FIVE_MANA_COLORS.filter((c) => set.has(c));
}

function exiledLinkedColors(
	state: GameState,
	sourceInstanceId: string,
	sourceObjectVersion: number
): ManaColor[] {
	const out = new Set<ManaColor>();
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (
				ex.exiledBy?.sourceInstanceId !== sourceInstanceId ||
				(ex.exiledBy.sourceObjectVersion ?? 1) !== sourceObjectVersion
			) {
				continue;
			}
			const faces = getCardFaces(ex.card);
			const f0 = faces[0];
			const cols = f0?.colors && f0.colors.length > 0 ? f0.colors : (ex.card.colors ?? []);
			for (const c of cols) {
				if (FIVE_MANA_COLORS.includes(c)) out.add(c);
			}
		}
	}
	return FIVE_MANA_COLORS.filter((c) => out.has(c));
}

function controlledPermanentColors(state: GameState, controllerId: string): ManaColor[] {
	const out = new Set<ManaColor>();
	const player = state.players.find((p) => p.playerId === controllerId);
	if (!player) return [];
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		for (const c of ev.colors) {
			if (FIVE_MANA_COLORS.includes(c)) out.add(c);
		}
	}
	return FIVE_MANA_COLORS.filter((c) => out.has(c));
}

function isAbilityCurrentlyActivatableForMana(
	state: GameState,
	controllerId: string,
	perm: CardInstance,
	ab: ActivatedAbility | UnsupportedAbility,
	condCtx: FilterContext,
	abIdOverride?: string
): boolean {
	if (ab.grantCondition && !evaluateFilterCondition(ab.grantCondition, condCtx)) return false;
	if (ab.activationCondition && !evaluateFilterCondition(ab.activationCondition, condCtx)) {
		return false;
	}
	const restrictions = ab.activationRestrictions;
	if (!restrictions || restrictions.length === 0) return true;
	const effId = abIdOverride ?? ab.id;
	if (
		restrictions.includes('onceEachTurn') &&
		effId &&
		perm.activatedAbilityIdsThisTurn?.includes(effId)
	) {
		return false;
	}
	if (
		restrictions.includes('oncePerGame') &&
		effId &&
		perm.usedOncePerGameAbilityIds?.includes(effId)
	) {
		return false;
	}
	const activePlayerId = state.players[state.activePlayerIndex]?.playerId;
	if (restrictions.includes('duringYourTurn') && activePlayerId !== controllerId) return false;
	if (restrictions.includes('duringOpponentsTurn') && activePlayerId === controllerId) return false;
	if (
		restrictions.includes('duringYourUpkeep') &&
		(activePlayerId !== controllerId || state.phase !== 'upkeep')
	) {
		return false;
	}
	if (restrictions.includes('duringCombat') && !COMBAT_PHASES_SET.has(state.phase)) return false;
	if (restrictions.includes('beforeAttackers') && !PRE_ATTACKER_PHASES_SET.has(state.phase)) {
		return false;
	}
	if (
		restrictions.includes('afterAttackers') &&
		(!state.combat?.active ||
			(state.phase !== 'declare_attackers' &&
				state.phase !== 'declare_blockers' &&
				state.phase !== 'first_strike_damage' &&
				state.phase !== 'combat_damage' &&
				state.phase !== 'end_combat'))
	) {
		return false;
	}
	if (
		restrictions.includes('beforeBlockers') &&
		state.phase !== 'begin_combat' &&
		state.phase !== 'declare_attackers'
	) {
		return false;
	}
	if (restrictions.includes('duringBlockers') && state.phase !== 'declare_blockers') {
		return false;
	}
	if (
		restrictions.includes('afterBlockers') &&
		(!state.combat?.blockersDeclared ||
			(state.phase !== 'declare_blockers' &&
				state.phase !== 'first_strike_damage' &&
				state.phase !== 'combat_damage' &&
				state.phase !== 'end_combat'))
	) {
		return false;
	}
	if (
		restrictions.includes('afterCombat') &&
		state.phase !== 'main2' &&
		state.phase !== 'end_step'
	) {
		return false;
	}
	return true;
}

function amountIsDeterminableWithoutCost(a: Amount): boolean {
	switch (a.k) {
		case 'x':
		case 'countersRemovedThisWay':
		case 'tappedCostPower':
		case 'stormCount':
		case 'anyNumber':
		case 'p20bCostPaidCount':
		case 'sacrificedCostStat':
		case 'eventAmount':
		case 'lastEffectAmount':
		case 'countedThisWay':
			return false;
		case 'negate':
		case 'mul':
		case 'half':
			return amountIsDeterminableWithoutCost(a.of);
		case 'sum':
		case 'min':
		case 'max':
			return a.args.every(amountIsDeterminableWithoutCost);
		case 'difference':
			return amountIsDeterminableWithoutCost(a.left) && amountIsDeterminableWithoutCost(a.right);
		case 'conditional':
			return (
				amountIsDeterminableWithoutCost(a.then) &&
				amountIsDeterminableWithoutCost(a.else)
			);
		default:
			return true;
	}
}

function extractManaFromAddSteps(
	steps: EffectStep[],
	condCtx: FilterContext,
	cmdColors: ManaColor[],
	chosenColor: ManaColor | undefined,
	perm: CardInstance,
	controller: PlayerGameState,
	state: GameState
): ExtractedManaPotential {
	const direct = new Set<ManaColor>();
	let hasOppLandColors = false;
	let hasCtrlLandTypes = false;
	let hasCtrlLandColors = false;

	for (const s of steps) {
		if (s.verb !== 'addMana') continue;
		if (s.condition && !evaluateFilterCondition(s.condition, condCtx)) continue;
		if (
			s.amount &&
			amountIsDeterminableWithoutCost(s.amount) &&
			evaluateAmount(s.amount, condCtx) <= 0
		) {
			continue;
		}
		const p = s.params;
		if (!p) continue;
		if (Array.isArray(p.mana)) {
			for (const c of p.mana) direct.add(c);
		}
		if (Array.isArray(p.manaWithChosenColor)) {
			for (const c of p.manaWithChosenColor) direct.add(c);
			if (chosenColor) direct.add(chosenColor);
		}
		if (Array.isArray(p.manaOrChosenColor)) {
			for (const c of p.manaOrChosenColor) direct.add(c);
			if (chosenColor) direct.add(chosenColor);
		}
		if (Array.isArray(p.manaBundles)) {
			for (const b of p.manaBundles) {
				for (const c of b) direct.add(c);
			}
		}
		if (p.manaCombinationColors) {
			const combCols =
				p.manaCombinationColors === 'any' ? FIVE_MANA_COLORS : p.manaCombinationColors;
			for (const c of combCols) direct.add(c);
		}
		if (p.addManaFromExiledColors) {
			for (const c of exiledLinkedColors(state, perm.instanceId, perm.objectVersion ?? 1)) {
				direct.add(c);
			}
		}
		if (p.addManaPerColorControlled) {
			for (const c of controlledPermanentColors(state, controller.playerId)) direct.add(c);
		}
		const ch = p.manaChoice;
		if (Array.isArray(ch)) {
			for (const c of ch) direct.add(c);
		} else if (ch === 'any') {
			for (const c of FIVE_MANA_COLORS) direct.add(c);
		} else if (ch === 'commanderIdentity') {
			for (const c of cmdColors) direct.add(c);
		} else if (ch === 'chosenColor') {
			if (chosenColor) direct.add(chosenColor);
		} else if (ch === 'opponentLandColors') {
			hasOppLandColors = true;
		} else if (ch === 'controlledLandProducedTypes') {
			hasCtrlLandTypes = true;
		} else if (ch === 'controlledLandProducedColors') {
			hasCtrlLandColors = true;
		}
	}

	return { direct, hasOppLandColors, hasCtrlLandTypes, hasCtrlLandColors };
}

function collectDirectPermanentManaProduction(
	state: GameState,
	controller: PlayerGameState,
	perm: CardInstance,
	includeColorless: boolean
): ExtractedManaPotential {
	const direct = new Set<ManaColor>();
	let hasOppLandColors = false;
	let hasCtrlLandTypes = false;
	let hasCtrlLandColors = false;
	if (perm.phasedOut) {
		return { direct, hasOppLandColors, hasCtrlLandTypes, hasCtrlLandColors };
	}
	const ev = evaluatePermanent(state, perm);
	const cmdColors = commanderColorsOfPlayer(controller);
	const condCtx: FilterContext = { state, controllerId: controller.playerId, source: perm };

	const allow = (c: ManaColor) => {
		if (c !== 'C' || includeColorless) direct.add(c);
	};

	const mergeSteps = (steps: EffectStep[], effChosenColor: ManaColor | undefined) => {
		const res = extractManaFromAddSteps(
			steps,
			condCtx,
			cmdColors,
			effChosenColor,
			perm,
			controller,
			state
		);
		for (const c of res.direct) allow(c);
		if (res.hasOppLandColors) hasOppLandColors = true;
		if (res.hasCtrlLandTypes) hasCtrlLandTypes = true;
		if (res.hasCtrlLandColors) hasCtrlLandColors = true;
	};

	if (ev.isLand && (!ev.losesAllAbilities || permanentRetainsInnateManaAbilities(perm, state))) {
		for (const [sub, col] of BASIC_LAND_COLORS) {
			if (ev.hasSubType(sub)) allow(col);
		}
	}

	const { timedLayer1a, effectiveCard, effectiveFaceOpts } = effectiveBattlefieldCardAndFaceOpts(state, perm);
	if (!ev.losesAllAbilities || permanentRetainsInnateManaAbilities(perm, state)) {
		if (!effectiveFaceOpts.isFaceDown) {
			const resolvedFaces = resolveObjectFaces(effectiveCard, effectiveFaceOpts);
			const cardDef = compileCard(effectiveFaceOpts.copiableState?.card ?? effectiveCard);
			const rawIdCounts = new Map<string, number>();
			for (const fi of resolvedFaces.activeFaceIndices) {
				const face = cardDef.faces[fi];
				if (!face) continue;
				for (const ab of face.abilities) {
					if (
						((ab.kind === 'activated' && !ab.intrinsic) ||
							(ab.kind === 'unsupported' && ab.id && ab.id !== 'cast')) &&
						ab.id
					) {
						rawIdCounts.set(ab.id, (rawIdCounts.get(ab.id) ?? 0) + 1);
					}
				}
			}
			for (const fi of resolvedFaces.activeFaceIndices) {
				const face = cardDef.faces[fi];
				if (!face) continue;
				for (const ab of face.abilities) {
					if (
						(ab.kind !== 'activated' && ab.kind !== 'unsupported') ||
						(ab.kind === 'activated' && ab.intrinsic) ||
						!ab.isMana ||
						!ab.effect?.length
					) {
						continue;
					}
					const rawId = ab.id ?? 'mana_tap';
					const abId =
						resolvedFaces.activeFaceIndices.length > 1 && (rawIdCounts.get(rawId) ?? 0) > 1
							? `f${fi}:${rawId}`
							: rawId;
					if (!isAbilityCurrentlyActivatableForMana(state, controller.playerId, perm, ab, condCtx, abId)) {
						continue;
					}
					mergeSteps(ab.effect, perm.chosenColor);
				}
			}
		}
		const effCopyLayer1 = timedLayer1a ?? perm.copiableState;
		const effMergedComponents = effCopyLayer1
			? effCopyLayer1.mergedComponents
			: perm.mergedComponents;
		if (!perm.isFaceDown && effMergedComponents && effMergedComponents.length > 1) {
			for (let cIdx = 1; cIdx < effMergedComponents.length; cIdx++) {
				const compFace = compileCard(effMergedComponents[cIdx]!).faces[0];
				if (!compFace) continue;
				for (const ab of compFace.abilities) {
					if (
						(ab.kind !== 'activated' && ab.kind !== 'unsupported') ||
						(ab.kind === 'activated' && ab.intrinsic) ||
						!ab.isMana ||
						!ab.effect?.length
					) {
						continue;
					}
					const abId = `backup_act:merged_${cIdx}:${ab.id}`;
					if (!isAbilityCurrentlyActivatableForMana(state, controller.playerId, perm, ab, condCtx, abId)) {
						continue;
					}
					mergeSteps(ab.effect, perm.chosenColor);
				}
			}
		}
	}

	const breakdown = inspectCardContinuousBreakdown(perm, state);
	for (const item of breakdown.items) {
		if (item.removed || item.isInnate) continue;
		if (item.grantedAbility?.isMana) {
			const ab = item.grantedAbility;
			const abId =
				ab.intrinsic && !item.grantSourceId
					? ab.id
					: item.grantSourceId
						? `granted:${item.grantSourceId}:${ab.id}`
						: ab.id;
			if (!isAbilityCurrentlyActivatableForMana(state, controller.playerId, perm, ab, condCtx, abId)) {
				continue;
			}
			const grantSourceChosenColor = item.grantSourceId
				? state.players
						.flatMap((pl) => pl.battlefield)
						.find((p) => p.instanceId === item.grantSourceId)?.chosenColor
				: undefined;
			mergeSteps(ab.effect, grantSourceChosenColor ?? perm.chosenColor);
		} else if (item.canonicalKey === 'mana_any') {
			for (const c of FIVE_MANA_COLORS) allow(c);
		}
	}

	if (state.timedContinuousEffects?.length) {
		const permVer = perm.objectVersion ?? 1;
		let quoteIdx = 0;
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer6?.grantedAbilityTexts?.length) continue;
			if (!isTimedContinuousEffectActiveForState(state, eff)) continue;
			if (
				!eff.affected.some(
					(a) => a.instanceId === perm.instanceId && (a.objectVersion ?? 1) === permVer
				)
			) {
				continue;
			}
			for (const gt of eff.layer6.grantedAbilityTexts) {
				for (const def of resolveQuotedAbilityDefs(gt, effectiveCard.name)) {
					if (def.kind !== 'activated') continue;
					const abId = `quoted_eot:${eff.timestamp}:${quoteIdx++}`;
					if (!def.isMana || !def.effect?.length) continue;
					if (!timedLayer6AbilitySurvivesRemoval(perm, state, eff.timestamp, Boolean(def.isMana))) {
						continue;
					}
					if (!isAbilityCurrentlyActivatableForMana(state, controller.playerId, perm, def, condCtx, abId)) {
						continue;
					}
					mergeSteps(def.effect, perm.chosenColor);
				}
			}
		}
	}

	for (const bg of collectBackupGrantedAbilityGroups(state, perm)) {
		for (const ab of bg.abilities) {
			if (
				(ab.kind !== 'activated' && ab.kind !== 'unsupported') ||
				(ab.kind === 'activated' && ab.intrinsic) ||
				!ab.isMana ||
				!ab.effect?.length
			) {
				continue;
			}
			if (!timedLayer6AbilitySurvivesRemoval(perm, state, bg.timestamp, Boolean(ab.isMana))) {
				continue;
			}
			const abId = `backup_act:${bg.sourceInstanceId}:${ab.id}`;
			if (!isAbilityCurrentlyActivatableForMana(state, controller.playerId, perm, ab, condCtx, abId)) {
				continue;
			}
			mergeSteps(ab.effect, perm.chosenColor);
		}
	}

	return { direct, hasOppLandColors, hasCtrlLandTypes, hasCtrlLandColors };
}

function computeBoardLandManaFixedPoint(state: GameState): {
	byPlayerDirect: Map<string, ExtractedManaPotential>;
	landTypesByPlayer: Map<string, Set<ManaColor>>;
} {
	const active = state.players.filter((p) => !p.lost);
	const byPlayerDirect = new Map<string, ExtractedManaPotential>();
	const landTypesByPlayer = new Map<string, Set<ManaColor>>();
	for (const p of active) {
		const agg: ExtractedManaPotential = {
			direct: new Set<ManaColor>(),
			hasOppLandColors: false,
			hasCtrlLandTypes: false,
			hasCtrlLandColors: false
		};
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (!ev.isLand) continue;
			const part = collectDirectPermanentManaProduction(state, p, perm, true);
			for (const c of part.direct) agg.direct.add(c);
			if (part.hasOppLandColors) agg.hasOppLandColors = true;
			if (part.hasCtrlLandTypes) agg.hasCtrlLandTypes = true;
			if (part.hasCtrlLandColors) agg.hasCtrlLandColors = true;
		}
		byPlayerDirect.set(p.playerId, agg);
		landTypesByPlayer.set(p.playerId, new Set<ManaColor>(agg.direct));
	}
	for (let iter = 0; iter < 8; iter++) {
		let changed = false;
		for (const p of active) {
			const agg = byPlayerDirect.get(p.playerId)!;
			if (!agg.hasOppLandColors) continue;
			const pSet = landTypesByPlayer.get(p.playerId)!;
			for (const opp of active) {
				if (opp.playerId === p.playerId) continue;
				const oppSet = landTypesByPlayer.get(opp.playerId)!;
				for (const c of FIVE_MANA_COLORS) {
					if (oppSet.has(c) && !pSet.has(c)) {
						pSet.add(c);
						changed = true;
					}
				}
			}
		}
		if (!changed) break;
	}
	return { byPlayerDirect, landTypesByPlayer };
}

export function playerLandColors(
	state: GameState,
	player: PlayerGameState
): { direct: Set<ManaColor>; hasOrchard: boolean } {
	const direct = new Set<ManaColor>();
	let hasOrchard = false;
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.isLand) continue;
		const part = collectDirectPermanentManaProduction(state, player, perm, false);
		for (const c of part.direct) {
			if (c !== 'C') direct.add(c);
		}
		if (part.hasOppLandColors) hasOrchard = true;
	}
	return { direct, hasOrchard };
}

/**
 * CR 106.7: Colors of mana (`W | U | B | R | G`, never `C`) that lands controlled by `actor`'s
 * opponents could produce right now.
 */
export function opponentLandColors(state: GameState, actor: PlayerGameState): ManaColor[] {
	const { landTypesByPlayer } = computeBoardLandManaFixedPoint(state);
	const out = new Set<ManaColor>();
	for (const opp of state.players) {
		if (opp.playerId === actor.playerId || opp.lost) continue;
		const oppTypes = landTypesByPlayer.get(opp.playerId);
		if (!oppTypes) continue;
		for (const c of FIVE_MANA_COLORS) {
			if (oppTypes.has(c)) out.add(c);
		}
	}
	return FIVE_MANA_COLORS.filter((c) => out.has(c));
}

/**
 * CR 106.7: Computes the mana types (`W, U, B, R, G, C` when `includeColorless`, else `W..G`)
 * that a single permanent on the battlefield could produce right now.
 */
export function permanentCouldProduceManaTypes(
	state: GameState,
	controller: PlayerGameState,
	perm: CardInstance,
	includeColorless: boolean
): ManaColor[] {
	const directRes = collectDirectPermanentManaProduction(state, controller, perm, includeColorless);
	const out = new Set<ManaColor>(directRes.direct);
	if (directRes.hasOppLandColors || directRes.hasCtrlLandTypes || directRes.hasCtrlLandColors) {
		const { landTypesByPlayer } = computeBoardLandManaFixedPoint(state);
		if (directRes.hasOppLandColors) {
			for (const opp of state.players) {
				if (opp.playerId === controller.playerId || opp.lost) continue;
				const oppTypes = landTypesByPlayer.get(opp.playerId);
				if (!oppTypes) continue;
				for (const c of FIVE_MANA_COLORS) {
					if (oppTypes.has(c)) out.add(c);
				}
			}
		}
		if (directRes.hasCtrlLandTypes || directRes.hasCtrlLandColors) {
			const ctrlTypes = landTypesByPlayer.get(controller.playerId);
			if (ctrlTypes) {
				for (const c of ctrlTypes) {
					if (c === 'C') {
						if (directRes.hasCtrlLandTypes && includeColorless) out.add('C');
					} else {
						out.add(c);
					}
				}
			}
		}
	}
	return ALL_MANA_TYPES_ORDER.filter((c) => out.has(c));
}

function manaStepProduction(
	steps: EffectStep[],
	commanderIdentity: ManaColor[],
	chosenColor?: ManaColor,
	condCtx?: FilterContext
): {
	colors: ManaColor[];
	amount: number;
	opponentLandColors?: boolean;
	manaRestriction?: EffectiveActivatedAbility['manaRestriction'];
	manaBundles?: ManaColor[][];
	manaCombinationColors?: ManaColor[] | 'any';
	// --- Track P10 ---
	manaRestrictionSpec?: EffectiveActivatedAbility['manaRestrictionSpec'];
	retainManaUntilEndOfTurn?: boolean;
	// --- End Track P10 ---
} | null {
	if (!steps.some((s) => s.verb === 'addMana')) return null;
	const activeSteps = filterActiveEffectSteps(steps, condCtx);
	const addSteps = activeSteps.filter((s) => s.verb === 'addMana');
	if (addSteps.length === 0) {
		// CR 605.2: still a mana ability even when 0 conditional addMana steps are active.
		return { colors: [], amount: 0 };
	}
	const cmdColors: ManaColor[] = commanderIdentity.filter((c) => c !== 'C');
	const colors: ManaColor[] = [];
	let totalAmount = 0;
	let opponentLands = false;
	let manaRestriction: EffectiveActivatedAbility['manaRestriction'];
	let manaBundles: ManaColor[][] | undefined;
	let manaCombinationColors: ManaColor[] | 'any' | undefined;
	// --- Track P10 ---
	let manaRestrictionSpec: EffectiveActivatedAbility['manaRestrictionSpec'];
	let retainManaUntilEndOfTurn = false;
	// --- End Track P10 ---
	let fixedSymbols: ManaColor[] | null = [];
	for (const s of addSteps) {
		if (s.params?.manaRestriction) manaRestriction = s.params.manaRestriction;
		// --- Track P10 ---
		if (s.params?.manaRestrictionSpec) manaRestrictionSpec = s.params.manaRestrictionSpec;
		if (s.params?.retainManaUntilEndOfTurn) retainManaUntilEndOfTurn = true;
		// --- End Track P10 ---
		const amt = s.amount?.k === 'const' ? s.amount.n : 1;
		const choice = s.params?.manaChoice;
		if (choice === 'opponentLandColors') {
			fixedSymbols = null;
			opponentLands = true;
			totalAmount += amt;
		} else if (choice === 'controlledLandProducedTypes' || choice === 'controlledLandProducedColors') {
			fixedSymbols = null;
			totalAmount += amt;
		} else if (choice === 'any') {
			fixedSymbols = null;
			for (const c of ['W', 'U', 'B', 'R', 'G'] as ManaColor[]) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
		} else if (choice === 'commanderIdentity') {
			fixedSymbols = null;
			for (const c of cmdColors) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
		} else if (choice === 'chosenColor') {
			fixedSymbols = null;
			if (Array.isArray(s.params?.manaOrChosenColor)) {
				for (const c of s.params.manaOrChosenColor) {
					if (!colors.includes(c)) colors.push(c);
				}
			}
			if (chosenColor && !colors.includes(chosenColor)) {
				colors.push(chosenColor);
			}
			totalAmount += amt;
		} else if (Array.isArray(s.params?.manaOrChosenColor)) {
			fixedSymbols = null;
			for (const c of s.params.manaOrChosenColor) {
				if (!colors.includes(c)) colors.push(c);
			}
			if (chosenColor && !colors.includes(chosenColor)) {
				colors.push(chosenColor);
			}
			totalAmount += amt;
		} else if (Array.isArray(choice)) {
			fixedSymbols = null;
			for (const c of choice) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
		} else if (Array.isArray(s.params?.manaWithChosenColor)) {
			fixedSymbols = null;
			const bundle: ManaColor[] = [
				...s.params.manaWithChosenColor,
				...(chosenColor ? [chosenColor] : [])
			];
			for (const c of bundle) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += bundle.length;
			if (bundle.length > 0) manaBundles = [bundle];
		} else if (Array.isArray(s.params?.manaBundles) && s.params.manaBundles.length > 0) {
			fixedSymbols = null;
			for (const b of s.params.manaBundles) {
				for (const c of b) {
					if (!colors.includes(c)) colors.push(c);
				}
			}
			totalAmount += s.params.manaBundles[0].length || 1;
			manaBundles = s.params.manaBundles.map((b) => [...b]);
		} else if (s.params?.manaCombinationColors) {
			fixedSymbols = null;
			const combCols: ManaColor[] =
				s.params.manaCombinationColors === 'any'
					? ['W', 'U', 'B', 'R', 'G']
					: s.params.manaCombinationColors;
			for (const c of combCols) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
			manaCombinationColors =
				s.params.manaCombinationColors === 'any'
					? 'any'
					: [...s.params.manaCombinationColors];
		} else if (s.params?.addManaFromExiledColors) {
			fixedSymbols = null;
			if (condCtx?.source) {
				const cols = exiledLinkedColors(
					condCtx.state,
					condCtx.source.instanceId,
					condCtx.source.objectVersion ?? 1
				);
				for (const c of cols) {
					if (!colors.includes(c)) colors.push(c);
				}
				if (cols.length > 0) totalAmount += amt;
			}
		} else if (Array.isArray(s.params?.mana)) {
			for (const c of s.params.mana) {
				if (!colors.includes(c)) colors.push(c);
			}
			const stepAmt = s.amount?.k === 'const' ? s.amount.n : s.params.mana.length || 1;
			totalAmount += stepAmt;
			if (
				fixedSymbols !== null &&
				(!s.amount || s.amount.k === 'const') &&
				s.params.mana.length === stepAmt
			) {
				fixedSymbols.push(...s.params.mana);
			} else {
				fixedSymbols = null;
			}
		} else {
			fixedSymbols = null;
		}
	}
	if (!manaBundles && fixedSymbols && new Set(fixedSymbols).size > 1) {
		manaBundles = [fixedSymbols];
	}
	return {
		colors,
		amount: Math.max(0, totalAmount),
		...(opponentLands ? { opponentLandColors: true } : {}),
		...(manaRestriction ? { manaRestriction } : {}),
		...(manaBundles ? { manaBundles } : {}),
		...(manaCombinationColors ? { manaCombinationColors } : {}),
		// --- Track P10 ---
		...(manaRestrictionSpec ? { manaRestrictionSpec } : {}),
		...(retainManaUntilEndOfTurn ? { retainManaUntilEndOfTurn: true } : {})
		// --- End Track P10 ---
	};
}

interface BuildEffectiveAbilityOptions {
	idOverride?: string;
	displayCardName: string;
	displayCard: ScryfallCard;
	grantSourceCard?: ScryfallCard;
	grantFaceIndex?: number;
	grantSources?: string[];
	labelOverride?: string;
	costTextOverride?: string;
	effectTextOverride?: string;
	chosenColor?: ManaColor;
	// --- Track P10 ---
	grantedAbilityText?: string;
	// --- End Track P10 ---
	condCtx?: FilterContext;
}

function buildEffectiveActivatedAbility(
	ab: ActivatedAbility | UnsupportedAbility,
	commanderIdentity: ManaColor[],
	resolveOpponentLandColors: (() => ManaColor[]) | undefined,
	opts: BuildEffectiveAbilityOptions
): EffectiveActivatedAbility | null {
	const id = opts.idOverride ?? ab.id!;
	const cost = ab.kind === 'activated' ? ab.cost : (ab.cost ?? []);
	const costComplete = ab.kind === 'activated' ? true : (ab.costComplete ?? false);
	const timing = ab.kind === 'activated' ? ab.timing : (ab.timing ?? 'instant');
	const isMana =
		ab.kind === 'activated'
			? ab.isMana
			: Boolean(ab.isMana && ab.effect && ab.effect.length > 0);
	const effect = ab.kind === 'activated' ? ab.effect : (ab.effect ?? []);
	const targets = ab.kind === 'activated' ? ab.targets : (ab.targets ?? []);
	const fullText = displayAbilityText(ab.text ?? '', opts.displayCardName, opts.displayCard);
	const colonIdx = fullText.indexOf(':');
	const costPart = colonIdx >= 0 ? fullText.slice(0, colonIdx).trim() : '';
	const effectPart = colonIdx >= 0 ? fullText.slice(colonIdx + 1).trim() : fullText;

	const loyaltyDef = cost.find((c): c is Extract<CostDef, { k: 'loyalty' }> => c.k === 'loyalty');
	// --- Track P15: +X / -X loyalty abilities (CR 606.4) ---
	const isLoyaltyX = Boolean(loyaltyDef?.isX);
	const loyaltySign: '+' | '-' | undefined = isLoyaltyX ? (loyaltyDef?.sign ?? '+') : undefined;
	const loyaltyCost = loyaltyDef && !isLoyaltyX ? loyaltyDef.delta : null;
	// --- End Track P15 ---
	const manaDef = cost.find((c): c is Extract<CostDef, { k: 'mana' }> => c.k === 'mana');
	const manaCost = manaDef ? manaDef.cost : '';
	const requiresTap = cost.some((c) => c.k === 'tapSelf');
	const requiresSacrificeSelf = cost.some((c) => c.k === 'sacrifice' && c.filter === 'self');
	const lifeDef = cost.find((c): c is Extract<CostDef, { k: 'payLife' }> => c.k === 'payLife');
	const lifeCost = lifeDef && lifeDef.amount.k === 'const' ? lifeDef.amount.n : 0;

	let producesMana: ManaColor[] = [];
	let producesAmount = 0;
	let hasManaProduction = false;
	let manaAmount: EffectiveActivatedAbility['manaAmount'];
	let manaRestriction: EffectiveActivatedAbility['manaRestriction'];
	let manaBundles: EffectiveActivatedAbility['manaBundles'];
	let manaCombinationColors: EffectiveActivatedAbility['manaCombinationColors'];
	// --- Track P10 ---
	let manaRestrictionSpec: EffectiveActivatedAbility['manaRestrictionSpec'];
	let retainManaUntilEndOfTurn: boolean | undefined;
	// --- End Track P10 ---
	const activeEffect = filterActiveEffectSteps(effect, opts.condCtx);
	const freezesSelfUntap =
		isMana && activeEffect.some((s) => s.verb === 'freezeUntap' && s.subject.k === 'self');
	if (isMana) {
		const prod = manaStepProduction(effect, commanderIdentity, opts.chosenColor, opts.condCtx);
		if (prod?.opponentLandColors) {
			const oppColors = resolveOpponentLandColors ? resolveOpponentLandColors() : [];
			if (oppColors.length === 0) return null;
			producesMana = oppColors;
			producesAmount = prod.amount;
			hasManaProduction = true;
			manaRestriction = prod.manaRestriction;
			// --- Track P10 ---
			manaRestrictionSpec = prod.manaRestrictionSpec;
			retainManaUntilEndOfTurn = prod.retainManaUntilEndOfTurn;
			// --- End Track P10 ---
		} else if (prod) {
			producesMana = prod.colors;
			producesAmount = prod.amount;
			hasManaProduction = true;
			manaRestriction = prod.manaRestriction;
			manaBundles = prod.manaBundles;
			manaCombinationColors = prod.manaCombinationColors;
			// --- Track P10 ---
			manaRestrictionSpec = prod.manaRestrictionSpec;
			retainManaUntilEndOfTurn = prod.retainManaUntilEndOfTurn;
			// --- End Track P10 ---
		}
		const activeAddSteps = activeEffect.filter((s) => s.verb === 'addMana');
		if (activeAddSteps.some((s) => s.amount && s.amount.k !== 'const')) {
			if (activeAddSteps.length === 1) {
				manaAmount = activeAddSteps[0].amount;
			} else {
				manaAmount = {
					k: 'sum',
					args: activeAddSteps.map((s) =>
						s.amount ?? { k: 'const', n: Array.isArray(s.params?.mana) ? s.params.mana.length : 1 }
					)
				};
			}
		}
	}

	const modal = ab.kind === 'activated' ? ab.modal : undefined;
	const targetInfo = modal ? modalTargetRequirement(modal) : targetRequirementFromSpecs(targets);
	const isPureTapMana = isMana && id === 'mana_tap' && !manaBundles && !manaCombinationColors && !freezesSelfUntap;
	const sourceSuffix = opts.grantSources && opts.grantSources.length > 0 ? ` (${opts.grantSources.join(', ')})` : '';
	const maxEffectLen = opts.grantSources ? 60 : 45;
	const loyaltyPrefix = isLoyaltyX
		? `${loyaltySign}X`
		: loyaltyCost !== null
			? `${loyaltyCost >= 0 ? `+${loyaltyCost}` : loyaltyCost}`
			: null;
	const baseLabel =
		isPureTapMana && producesMana.length > 0
			? `Tap: Add ${producesAmount > 1 ? `${producesAmount}x ` : ''}${producesMana.map((c) => `{${c}}`).join('/')}`
			: loyaltyPrefix !== null
				? `${loyaltyPrefix}: ${effectPart.slice(0, 48)}`
				: `${costPart}: ${effectPart.slice(0, maxEffectLen)}`;
	const label = opts.labelOverride ?? `${baseLabel}${sourceSuffix}`;
	const costText =
		opts.costTextOverride ??
		(isPureTapMana ? '{T}' : loyaltyPrefix !== null ? loyaltyPrefix : costPart);
	const activationZones = ab.kind === 'activated' ? ab.activationZones : undefined;
	const costKeyword = ab.kind === 'activated' ? ab.costKeyword : undefined;
	const activationCondition = ab.activationCondition;
	// --- Track P15 ---
	const choosesX =
		isLoyaltyX ||
		/\{X\}/i.test(manaCost) ||
		cost.some(
			(c) =>
				(c.k === 'payLife' && c.amount.k === 'x') ||
				(c.k === 'payEnergy' && c.count.k === 'x') ||
				(c.k === 'removeCounters' && c.count.k === 'x') ||
				(c.k === 'discard' && c.count.k === 'x') ||
				(c.k === 'exileFrom' && c.count.k === 'x') ||
				// --- Track P17b ---
				(c.k === 'sacrifice' && c.count.k === 'x') ||
				(c.k === 'tapOthers' && c.count.k === 'x') ||
				(c.k === 'untapOthers' && c.count.k === 'x') ||
				(c.k === 'returnToHand' && c.count.k === 'x') ||
				(c.k === 'putCounters' && c.count.k === 'x') ||
				(c.k === 'putOnBottomOfLibrary' && c.count.k === 'x') ||
				(c.k === 'mill' && c.count.k === 'x')
				// --- End Track P17b ---
		);
	const activatorWho = ab.kind === 'activated' ? ab.activatorWho : undefined;
	const powerUpReduction = ab.kind === 'activated' ? ab.powerUpReduction : undefined;
	// --- End Track P15 ---

	return {
		id,
		label,
		costText,
		manaCost,
		cost,
		costComplete,
		requiresTap,
		requiresSacrificeSelf,
		lifeCost,
		loyaltyCost,
		isManaAbility: isMana && hasManaProduction,
		sorcerySpeedOnly: timing === 'sorcery',
		...(ab.activationRestrictions?.length ? { activationRestrictions: ab.activationRestrictions } : {}),
		...(activationCondition ? { activationCondition } : {}),
		...(activationZones?.length ? { activationZones } : {}),
		...(costKeyword ? { costKeyword } : {}),
		...(ab.grantCondition ? { grantCondition: ab.grantCondition } : {}),
		// --- Track P15 ---
		...(choosesX ? { choosesX: true } : {}),
		...(loyaltySign ? { loyaltySign } : {}),
		...(activatorWho ? { activatorWho } : {}),
		...(powerUpReduction ? { powerUpReduction: true } : {}),
		// --- End Track P15 ---
		// --- Track P18b ---
		...(ab.xCantBeZero ? { xCantBeZero: true } : {}),
		// --- End Track P18b ---
		producesMana,
		producesAmount,
		...(manaAmount ? { manaAmount } : {}),
		...(manaRestriction ? { manaRestriction } : {}),
		...(manaBundles ? { manaBundles } : {}),
		...(manaCombinationColors ? { manaCombinationColors } : {}),
		// --- Track P10 ---
		...(manaRestrictionSpec ? { manaRestrictionSpec } : {}),
		...(retainManaUntilEndOfTurn ? { retainManaUntilEndOfTurn: true } : {}),
		...(opts.grantedAbilityText ? { grantedAbilityText: opts.grantedAbilityText } : {}),
		// --- End Track P10 ---
		...(freezesSelfUntap ? { freezesSelfUntap: true } : {}),
		...(opts.grantSourceCard ? { grantSourceCard: opts.grantSourceCard } : {}),
		...(opts.grantFaceIndex !== undefined ? { grantFaceIndex: opts.grantFaceIndex } : {}),
		effectText: opts.effectTextOverride ?? effectPart,
		...(modal ? { modal } : {}),
		requiresTarget: targetInfo.requiresTarget,
		targetKind: targetInfo.targetKind,
		targetInfo
	};
}

function buildFaceActivatedAbilities(
	faceName: string,
	faceIndex: number,
	abilities: ReturnType<typeof activeAbilityDefs>,
	card: ScryfallCard,
	commanderIdentity: ManaColor[],
	resolveOpponentLandColors?: () => ManaColor[],
	chosenColor?: ManaColor,
	condCtx?: FilterContext,
	allowedIntrinsicColors?: ReadonlySet<ManaColor>
): EffectiveActivatedAbility[] {
	const out: EffectiveActivatedAbility[] = [];

	const intrinsicColors: ManaColor[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'activated' && ab.intrinsic) {
			for (const s of ab.effect) {
				for (const c of s.params?.mana ?? []) {
					if (allowedIntrinsicColors && !allowedIntrinsicColors.has(c)) continue;
					if (!intrinsicColors.includes(c)) intrinsicColors.push(c);
				}
			}
		}
	}
	if (intrinsicColors.length > 0) {
		out.push({
			id: 'mana_tap',
			faceIndex,
			label: `Tap: Add ${intrinsicColors.map((c) => `{${c}}`).join('/')}`,
			costText: '{T}',
			manaCost: '',
			cost: [{ k: 'tapSelf' }],
			costComplete: true,
			requiresTap: true,
			requiresSacrificeSelf: false,
			lifeCost: 0,
			loyaltyCost: null,
			isManaAbility: true,
			producesMana: intrinsicColors,
			producesAmount: 1,
			effectText: `Add ${intrinsicColors.map((c) => `{${c}}`).join(' or ')}`,
			requiresTarget: false,
			targetKind: 'none',
			targetInfo: NO_TARGET_REQUIREMENT
		});
	}

	for (const ab of abilities) {
		if (ab.kind === 'keyword') {
			const { name: kwName, cost: kwCost, equipFilter } = ab.keyword;
			if (kwName === 'equip') {
				// --- Track P12 ---
				const filter = equipFilter ?? {};
				const costDefs =
					ab.keyword.costDefs ??
					(kwCost && kwCost !== '{0}' ? [{ k: 'mana' as const, cost: kwCost }] : []);
				const manaParts = costDefs.filter(
					(d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana'
				);
				const nonManaParts = costDefs.filter((d) => d.k !== 'mana');
				const equipCost =
					kwCost ?? (manaParts.length > 0 ? manaParts.map((m) => m.cost).join('') : '{0}');
				const lifeCost = costDefs.reduce(
					(sum, d) => (d.k === 'payLife' && d.amount.k === 'const' ? sum + d.amount.n : sum),
					0
				);
				const requiresTap = costDefs.some((d) => d.k === 'tapSelf');
				const requiresSacrificeSelf = costDefs.some(
					(d) => d.k === 'sacrifice' && d.filter === 'self'
				);
				const qual = [
					...(filter.token === true ? ['token'] : filter.token === false ? ['nontoken'] : []),
					...(filter.supertypes?.map((s) => s.toLowerCase()) ?? []),
					...(filter.notTypes?.map((t) => `non${t.toLowerCase()}`) ?? []),
					...(filter.notSubtypes?.map((s) => `non-${s}`) ?? []),
					...(filter.subtypes ?? [])
				].join(' ');
				const allowsPw = Boolean(
					ab.keyword.equipAllowPlaneswalker || filter.types?.includes('Planeswalker')
				);
				const allowsCreature = !filter.types || filter.types.includes('Creature');
				const baseNoun =
					allowsPw && allowsCreature
						? 'creature or planeswalker'
						: allowsPw
							? 'planeswalker'
							: 'creature';
				const equipTargetPhrase = ab.keyword.param
					? ab.keyword.param
					: qual
						? `${qual} ${baseNoun}`
						: baseNoun;
				const hasCustomTarget = equipTargetPhrase !== 'creature';
				let labelPrefix: string;
				if (nonManaParts.length > 0) {
					const costDesc = [
						...(equipCost && equipCost !== '{0}' ? [equipCost] : []),
						describeCost(nonManaParts)
					].join(', ');
					labelPrefix = hasCustomTarget
						? `Equip ${equipTargetPhrase}—${costDesc}`
						: `Equip—${costDesc}`;
				} else {
					labelPrefix = hasCustomTarget
						? `Equip ${equipTargetPhrase} ${equipCost}`
						: `Equip ${equipCost}`;
				}
				const spec: TargetSpec = {
					kind: 'object',
					filter: { zone: 'battlefield', types: ['Creature'], controller: 'you', ...filter },
					min: 1,
					max: 1
				};
				const targetInfo = targetRequirementFromSpecs([spec]);
				out.push({
					id: ab.id ?? 'equip_0',
					faceIndex,
					label: `${labelPrefix}: Attach to target ${equipTargetPhrase} you control`,
					costText: labelPrefix,
					manaCost: equipCost,
					cost: costDefs,
					costComplete: true,
					requiresTap,
					requiresSacrificeSelf,
					lifeCost,
					loyaltyCost: null,
					isManaAbility: false,
					sorcerySpeedOnly: true,
					costKeyword: 'equip',
					producesMana: [],
					producesAmount: 0,
					effectText: `Attach to target ${equipTargetPhrase} you control.`,
					requiresTarget: true,
					targetKind: targetInfo.targetKind,
					targetInfo
				});
				// --- End Track P12 ---
			} else {
				const spec = getKeywordSpec(kwName);
				if (
					spec?.status === 'implemented' &&
					spec.implementation?.kind === 'activated' &&
					spec.implementation.buildActivated
				) {
					const built = spec.implementation.buildActivated(
						ab.keyword,
						ab.id ?? `${kwName}_0`,
						ab.span
					);
					if (built) {
						const effective = buildEffectiveActivatedAbility(
							built.ability,
							commanderIdentity,
							resolveOpponentLandColors,
							{
								displayCardName: faceName,
								displayCard: card,
								labelOverride: built.label,
								costTextOverride: built.costText,
								effectTextOverride: built.effectText,
								chosenColor,
								condCtx
							}
						);
						if (effective) out.push({ ...effective, faceIndex });
					}
					// --- Track P15: Reconfigure also defines an unattach ability (CR 702.151a) ---
					if (kwName === 'reconfigure') {
						const unattachBuilt = buildReconfigureUnattachAbility(
							ab.keyword,
							ab.id ?? 'reconfigure_0',
							ab.span
						);
						if (unattachBuilt) {
							const unattachEff = buildEffectiveActivatedAbility(
								unattachBuilt.ability,
								commanderIdentity,
								resolveOpponentLandColors,
								{
									displayCardName: faceName,
									displayCard: card,
									labelOverride: unattachBuilt.label,
									costTextOverride: unattachBuilt.costText,
									effectTextOverride: unattachBuilt.effectText,
									chosenColor,
									condCtx
								}
							);
							if (unattachEff) out.push({ ...unattachEff, faceIndex });
						}
					}
					// --- End Track P15 ---
				}
			}
			continue;
		}

		if (
			(ab.kind === 'activated' && !ab.intrinsic) ||
			(ab.kind === 'unsupported' && ab.id && ab.id !== 'cast')
		) {
			if (ab.id === 'mana_tap' && out.some((x) => x.id === 'mana_tap')) continue;
			const built = buildEffectiveActivatedAbility(ab, commanderIdentity, resolveOpponentLandColors, {
				displayCardName: faceName,
				displayCard: card,
				chosenColor,
				condCtx
			});
			if (built) out.push({ ...built, faceIndex });
		}
	}

	return out;
}

/**
 * Builds the innate activated abilities of `card` from its compiled IR, scoped to `faceOpts`
 * (and disambiguating colliding ability IDs across multiple active faces such as unlocked Room doors).
 */
export function getCardActivatedAbilities(
	card: ScryfallCard,
	commanderIdentity: ManaColor[] = [],
	resolveOpponentLandColors?: () => ManaColor[],
	faceOpts?: ResolveObjectFacesOptions,
	chosenColor?: ManaColor,
	condCtx?: FilterContext,
	allowedIntrinsicColors?: ReadonlySet<ManaColor>
): EffectiveActivatedAbility[] {
	const resolved = resolveObjectFaces(card, faceOpts);
	const def = compileCard(card);
	const collected: EffectiveActivatedAbility[] = [];
	for (const fi of resolved.activeFaceIndices) {
		const face = def.faces[fi];
		if (!face) continue;
		collected.push(
			...buildFaceActivatedAbilities(
				face.name,
				fi,
				face.abilities,
				card,
				commanderIdentity,
				resolveOpponentLandColors,
				chosenColor,
				condCtx,
				allowedIntrinsicColors
			)
		);
	}
	if (resolved.activeFaceIndices.length <= 1) return collected;
	const idCounts = new Map<string, number>();
	for (const ab of collected) idCounts.set(ab.id, (idCounts.get(ab.id) ?? 0) + 1);
	return collected.map((ab) =>
		(idCounts.get(ab.id) ?? 0) > 1 ? { ...ab, id: `f${ab.faceIndex ?? 0}:${ab.id}` } : ab
	);
}

/**
 * Returns the activated abilities of a permanent from its compiled IR, with continuous layer
 * grants/ability-loss (CR 613.1f, 613.7) and active cost modifiers applied.
 */
export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = []
): EffectiveActivatedAbility[] {
	const condCtx: FilterContext = { state, controllerId: actor.playerId, source: perm };
	const resolveOppLands = () =>
		state.lobbyCode === 'GOLDEN'
			? (['W', 'U', 'B', 'R', 'G'] as ManaColor[])
			: opponentLandColors(state, actor);

	let rawAbilities: EffectiveActivatedAbility[];
	if (perm.zone !== 'battlefield') {
		// CR 611.3b: Battlefield Layer 4/6 static effects (ability loss, grants, copy) apply only
		// to permanents on the battlefield; off-battlefield objects keep their innate abilities,
		// with cost modifiers still applied below.
		rawAbilities = getCardActivatedAbilities(
			perm.card,
			commanderIdentity,
			resolveOppLands,
			instanceFaceOptions(perm, perm.zone),
			perm.chosenColor,
			condCtx
		).filter((ab) => !ab.grantCondition);
		// --- Track P22a (CR 702.97 Scavenge / CR 702.84 Unearth graveyard grants) ---
		if (perm.zone === 'graveyard' && perm.ownerId === actor.playerId) {
			for (const g of collectGrantedGraveyardActivatedAbilitiesWave8(state, actor, perm)) {
				if (rawAbilities.some((a) => a.id === g.abilityId)) continue;
				const built = buildEffectiveActivatedAbility(
					g.ability,
					commanderIdentity,
					resolveOppLands,
					{
						idOverride: g.abilityId,
						displayCardName: perm.card.name,
						displayCard: g.grantSourceCard,
						grantSourceCard: g.grantSourceCard,
						grantSources: [g.grantSourceName],
						labelOverride: g.label,
						costTextOverride: g.costText,
						effectTextOverride: g.effectText,
						chosenColor: perm.chosenColor,
						condCtx
					}
				);
				if (built) rawAbilities.push(built);
			}
		}
		// --- End Track P22a ---
	} else {
		const ev = evaluatePermanent(state, perm);
		const breakdown = inspectCardContinuousBreakdown(perm, state);
		const allInnateRemoved = permanentHasLostAllAbilities(perm, state).lost;
		const retainsInnateMana =
			allInnateRemoved && !perm.isFaceDown && permanentRetainsInnateManaAbilities(perm, state);
		const activeBasicLandColors = new Set<ManaColor>();
		if (ev.isLand) {
			for (const [sub, col] of BASIC_LAND_COLORS) {
				if (ev.hasSubType(sub)) activeBasicLandColors.add(col);
			}
		}
		// --- Track P7 ---
		const { timedLayer1a, effectiveCard, effectiveFaceOpts } =
			effectiveBattlefieldCardAndFaceOpts(state, perm);
		// --- End Track P7 ---
		rawAbilities =
			allInnateRemoved && !retainsInnateMana
				? []
				: getCardActivatedAbilities(
						effectiveCard,
						commanderIdentity,
						resolveOppLands,
						effectiveFaceOpts,
						perm.chosenColor,
						condCtx,
						activeBasicLandColors
					).filter(
						(ab) =>
							(!allInnateRemoved || ab.isManaAbility) &&
							(!ab.grantCondition || evaluateFilterCondition(ab.grantCondition, condCtx))
					);

		// Add granted activated abilities from Layer 4 / Layer 6 IR (`AttributedKeywordOrEffect.grantedAbility`)
		for (const item of breakdown.items) {
			if (item.removed || item.isInnate || !item.grantedAbility) continue;
			const grantedIr = item.grantedAbility;
			const abId =
				grantedIr.intrinsic && !item.grantSourceId
					? grantedIr.id
					: item.grantSourceId
						? `granted:${item.grantSourceId}:${grantedIr.id}`
						: grantedIr.id;
			if (rawAbilities.some((a) => a.id === abId)) continue;
			const grantSourceChosenColor = item.grantSourceId
				? state.players
						.flatMap((pl) => pl.battlefield)
						.find((p) => p.instanceId === item.grantSourceId)?.chosenColor
				: undefined;
			const built = buildEffectiveActivatedAbility(grantedIr, commanderIdentity, resolveOppLands, {
				idOverride: abId,
				displayCardName: effectiveCard.name,
				displayCard: item.grantSourceCard ?? effectiveCard,
				grantSourceCard: item.grantSourceCard,
				...(item.grantFaceIndex !== undefined ? { grantFaceIndex: item.grantFaceIndex } : {}),
				grantSources: item.sources,
				chosenColor: grantSourceChosenColor ?? perm.chosenColor,
				condCtx
			});
			if (built) rawAbilities.push(built);
		}
		// --- Track P10: EOT-granted quoted activated abilities (`TimedContinuousEffect.layer6.grantedAbilityTexts`) ---
		if (state.timedContinuousEffects?.length) {
			const permVer = perm.objectVersion ?? 1;
			let quoteIdx = 0;
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer6?.grantedAbilityTexts?.length) continue;
				if (!isTimedContinuousEffectActiveForState(state, eff)) continue;
				if (
					!eff.affected.some(
						(a) => a.instanceId === perm.instanceId && (a.objectVersion ?? 1) === permVer
					)
				) {
					continue;
				}
				for (const gt of eff.layer6.grantedAbilityTexts) {
					for (const def of resolveQuotedAbilityDefs(gt, effectiveCard.name)) {
						if (def.kind !== 'activated') continue;
						const abId = `quoted_eot:${eff.timestamp}:${quoteIdx++}`;
						const built = buildEffectiveActivatedAbility(def, commanderIdentity, resolveOppLands, {
							idOverride: abId,
							displayCardName: effectiveCard.name,
							displayCard: effectiveCard,
							grantSources: [eff.sourceName],
							chosenColor: perm.chosenColor,
							grantedAbilityText: gt,
							condCtx
						});
						if (built && timedLayer6AbilitySurvivesRemoval(perm, state, eff.timestamp, built.isManaAbility)) {
							rawAbilities.push(built);
						}
					}
				}
			}
		}
		// --- End Track P10 ---

		// --- Track P12: Backup-granted activated abilities (CR 702.165c) ---
		for (const bg of collectBackupGrantedAbilityGroups(state, perm)) {
			for (const ab of bg.abilities) {
				if (ab.kind !== 'activated' || ab.intrinsic) continue;
				const abId = `backup_act:${bg.sourceInstanceId}:${ab.id}`;
				if (rawAbilities.some((a) => a.id === abId)) continue;
				const built = buildEffectiveActivatedAbility(ab, commanderIdentity, resolveOppLands, {
					idOverride: abId,
					displayCardName: effectiveCard.name,
					displayCard: bg.sourceCard,
					grantSourceCard: bg.sourceCard,
					grantFaceIndex: bg.faceIndex,
					grantSources: [bg.sourceName],
					chosenColor: perm.chosenColor,
					condCtx
				});
				if (built && timedLayer6AbilitySurvivesRemoval(perm, state, bg.timestamp, built.isManaAbility)) {
					rawAbilities.push(built);
				}
			}
		}
		// --- End Track P12 ---

		// --- Track P18a: Merged permanent underneath component activated abilities (CR 731.2b / CR 707.2) ---
		const effCopyLayer1 = timedLayer1a ?? perm.copiableState;
		const effMergedComponents = effCopyLayer1
			? effCopyLayer1.mergedComponents
			: perm.mergedComponents;
		if (
			(!allInnateRemoved || retainsInnateMana) &&
			!perm.isFaceDown &&
			effMergedComponents &&
			effMergedComponents.length > 1
		) {
			for (let cIdx = 1; cIdx < effMergedComponents.length; cIdx++) {
				const compCard = effMergedComponents[cIdx]!;
				const compDef = compileCard(compCard);
				const compFace = compDef.faces[0];
				if (!compFace) continue;
				for (const ab of compFace.abilities) {
					if (ab.kind === 'activated' && !ab.intrinsic) {
						const abId = `backup_act:merged_${cIdx}:${ab.id}`;
						if (rawAbilities.some((a) => a.id === abId)) continue;
						const built = buildEffectiveActivatedAbility(ab, commanderIdentity, resolveOppLands, {
							idOverride: abId,
							displayCardName: effectiveCard.name,
							displayCard: compCard,
							grantSourceCard: compCard,
							grantFaceIndex: 0,
							grantSources: [compCard.name],
							chosenColor: perm.chosenColor,
							condCtx
						});
						if (built && (!allInnateRemoved || built.isManaAbility)) rawAbilities.push(built);
					} else if (ab.kind === 'keyword') {
						const { name: kwName } = ab.keyword;
						const spec = getKeywordSpec(kwName);
						if (
							spec?.status === 'implemented' &&
							spec.implementation?.kind === 'activated' &&
							spec.implementation.buildActivated
						) {
							const baseId = ab.id ?? `${kwName}_0`;
							const kwBuilt = spec.implementation.buildActivated(ab.keyword, baseId, ab.span);
							if (kwBuilt) {
								const abId = `backup_act:merged_${cIdx}:${kwBuilt.ability.id}`;
								if (rawAbilities.some((a) => a.id === abId)) continue;
								const built = buildEffectiveActivatedAbility(
									kwBuilt.ability,
									commanderIdentity,
									resolveOppLands,
									{
										idOverride: abId,
										displayCardName: effectiveCard.name,
										displayCard: compCard,
										grantSourceCard: compCard,
										grantFaceIndex: 0,
										grantSources: [compCard.name],
										labelOverride: kwBuilt.label,
										costTextOverride: kwBuilt.costText,
										effectTextOverride: kwBuilt.effectText,
										chosenColor: perm.chosenColor,
										condCtx
									}
								);
								if (built && (!allInnateRemoved || built.isManaAbility)) rawAbilities.push(built);
							}
						}
					}
				}
			}
		}
		// --- End Track P18a ---
	}

	return rawAbilities.map((ab) => {
		// --- Track P10: Bind chosen creature subtype onto manaRestrictionSpec ---
		if (ab.manaRestrictionSpec && perm.chosenSubType && !ab.manaRestrictionSpec.sourceChosenSubType) {
			ab = {
				...ab,
				manaRestrictionSpec: {
					...ab.manaRestrictionSpec,
					sourceChosenSubType: perm.chosenSubType
				}
			};
		}
		// --- End Track P10 ---
		// --- Track P17b ---
		const rawBaseMana = ab.baseManaCost ?? ab.manaCost;
		const isKeywordAb = Boolean(
			ab.costKeyword ||
				ab.id.startsWith('equip_') ||
				ab.id.startsWith('cycling_') ||
				ab.id.startsWith('unearth_') ||
				ab.id.startsWith('ninjutsu_') ||
				ab.id.startsWith('commander_ninjutsu_') ||
				ab.id.startsWith('scavenge_') ||
				ab.id.startsWith('boast_') ||
				ab.id.startsWith('exhaust_') ||
				ab.id.startsWith('powerup_')
		);
		const { manaCost: effMana } = effectiveAbilityManaCost(
			state,
			actor.playerId,
			ab.id,
			rawBaseMana,
			ab.costKeyword,
			0,
			isKeywordAb ? perm : undefined,
			ab.isManaAbility,
			Boolean(ab.powerUpReduction),
			undefined,
			ab.loyaltyCost !== null
		);
		// --- End Track P17b ---
		if (effMana !== rawBaseMana) {
			const hasManaEntry = ab.cost.some((c) => c.k === 'mana');
			const nextCost = hasManaEntry
				? ab.cost.map((c) => (c.k === 'mana' ? { k: 'mana' as const, cost: effMana } : c))
				: effMana && effMana !== '{0}'
					? [{ k: 'mana' as const, cost: effMana }, ...ab.cost]
					: ab.cost;
			const filteredCost =
				effMana === '{0}' || effMana === '' ? nextCost.filter((c) => c.k !== 'mana') : nextCost;
			const nextCostText =
				ab.id.startsWith('equip_') && effMana === '{0}'
					? 'Equip {0}'
					: rawBaseMana && ab.costText.includes(rawBaseMana)
						? ab.costText.replace(rawBaseMana, effMana || '{0}')
						: ab.costText;
			const nextLabel =
				ab.id.startsWith('equip_') && effMana === '{0}'
					? `Equip {0} (was ${rawBaseMana})`
					: rawBaseMana && ab.label.includes(rawBaseMana)
						? ab.label.replace(rawBaseMana, effMana || '{0}')
						: ab.label;
			return {
				...ab,
				baseManaCost: rawBaseMana,
				manaCost: effMana,
				cost: filteredCost,
				costText: nextCostText,
				label: nextLabel
			};
		}
		return ab;
	});
}

export {
	evaluatePermanent,
	getAttachedAbilityStrippingAuraSources,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
	type AttributedKeywordOrEffect,
	type CardContinuousBreakdown,
	type EvaluatedPermanent,
	checkGlobalCastPermissionsAndRestrictions,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame,
	resolveZoneChangeReplacements
};
