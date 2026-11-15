import { cardManaSteps as compiledCardManaSteps, compileCard } from './compiler/index.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './runtime/faces.ts';
import { displayAbilityText } from './compiler/support.ts';
import type { ActivatedAbility, CostDef, EffectStep, ModalDef, TargetSpec, UnsupportedAbility } from './ir.ts';
import { getKeywordSpec } from './keywords.ts';
import { effectiveAbilityManaCost } from './runtime/costs.ts';
import { hasChooseAllModesOptionalCost, isCastConditionMet } from './runtime/kicker.ts';
import { evaluateCondition as evaluateFilterCondition } from './runtime/objectFilter.ts';
import {
	evaluatePermanent,
	getAttachedAbilityStrippingAuraSources,
	inspectCardContinuousBreakdown,
	permanentHasLostAllAbilities,
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
	const faceOpts = { zone: 'stack' as const, faceIndex: option?.faceIndex ?? 0, fused: option?.fused };
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
	return nonModalSpecs.length > 0 ? targetRequirementFromSpecs(nonModalSpecs) : NO_TARGET_REQUIREMENT;
}

/**
 * Colors of mana that lands controlled by `actor`'s opponents could produce (Exotic Orchard,
 * Fellwar Stone).
 */
function opponentLandColors(state: GameState, actor: PlayerGameState): ManaColor[] {
	const found = new Set<ManaColor>();
	for (const opp of state.players) {
		if (opp.playerId === actor.playerId || opp.lost) continue;
		const oppCmdId = Array.from(
			new Set(opp.command.flatMap((c) => c.card.colorIdentity || []))
		) as ManaColor[];
		for (const oppPerm of opp.battlefield) {
			if (oppPerm.phasedOut) continue;
			const oppEval = evaluatePermanent(state, oppPerm);
			if (!oppEval.isLand) continue;
			const oppCard = oppPerm.copiableCard ?? oppPerm.card;
			if (!oppEval.losesAllAbilities) {
				for (const s of compiledCardManaSteps(oppCard)) {
					const choice = s.params?.manaChoice;
					const cols: ManaColor[] =
						choice === 'any'
							? ['W', 'U', 'B', 'R', 'G']
							: choice === 'commanderIdentity'
								? oppCmdId
								: choice === 'chosenColor'
									? oppPerm.chosenColor
										? [oppPerm.chosenColor]
										: []
									: Array.isArray(choice)
										? choice
										: s.params?.manaWithChosenColor
											? [
													...s.params.manaWithChosenColor,
													...(oppPerm.chosenColor ? [oppPerm.chosenColor] : [])
												]
											: s.params?.manaBundles
												? s.params.manaBundles.flat()
												: s.params?.manaCombinationColors
													? s.params.manaCombinationColors === 'any'
														? ['W', 'U', 'B', 'R', 'G']
														: s.params.manaCombinationColors
													: (s.params?.mana ?? []);
					for (const c of cols) if (c !== 'C') found.add(c);
				}
			}
			for (const t of ['Plains:W', 'Island:U', 'Swamp:B', 'Mountain:R', 'Forest:G'] as const) {
				const [sub, col] = t.split(':') as [string, ManaColor];
				if (oppEval.typeLine.includes(sub)) found.add(col);
			}
			const oppBreakdown = inspectCardContinuousBreakdown(oppPerm, state);
			for (const item of oppBreakdown.items) {
				if (item.removed || item.isInnate || !item.grantedAbility?.isMana) continue;
				const grantSourceChosenColor = item.grantSourceId
					? state.players
							.flatMap((pl) => pl.battlefield)
							.find((p) => p.instanceId === item.grantSourceId)?.chosenColor
					: undefined;
				const effChosenColor = grantSourceChosenColor ?? oppPerm.chosenColor;
				for (const s of item.grantedAbility.effect) {
					if (s.verb !== 'addMana') continue;
					const choice = s.params?.manaChoice;
					if (choice === 'opponentLandColors') continue;
					const cols: ManaColor[] =
						choice === 'any'
							? ['W', 'U', 'B', 'R', 'G']
							: choice === 'commanderIdentity'
								? oppCmdId
								: choice === 'chosenColor'
									? effChosenColor
										? [effChosenColor]
										: []
									: Array.isArray(choice)
										? choice
										: s.params?.manaWithChosenColor
											? [
													...s.params.manaWithChosenColor,
													...(effChosenColor ? [effChosenColor] : [])
												]
											: s.params?.manaBundles
												? s.params.manaBundles.flat()
												: s.params?.manaCombinationColors
													? s.params.manaCombinationColors === 'any'
														? ['W', 'U', 'B', 'R', 'G']
														: s.params.manaCombinationColors
													: (s.params?.mana ?? []);
					for (const c of cols) if (c !== 'C') found.add(c);
				}
			}
		}
	}
	return (['W', 'U', 'B', 'R', 'G'] as ManaColor[]).filter((c) => found.has(c));
}

function manaStepProduction(
	steps: EffectStep[],
	commanderIdentity: ManaColor[],
	chosenColor?: ManaColor
): {
	colors: ManaColor[];
	amount: number;
	opponentLandColors?: boolean;
	manaRestriction?: EffectiveActivatedAbility['manaRestriction'];
	manaBundles?: ManaColor[][];
	manaCombinationColors?: ManaColor[] | 'any';
} | null {
	const addSteps = steps.filter((s) => s.verb === 'addMana');
	if (addSteps.length === 0) return null;
	const cmdColors: ManaColor[] = commanderIdentity.filter((c) => c !== 'C');
	const colors: ManaColor[] = [];
	let totalAmount = 0;
	let opponentLands = false;
	let manaRestriction: EffectiveActivatedAbility['manaRestriction'];
	let manaBundles: ManaColor[][] | undefined;
	let manaCombinationColors: ManaColor[] | 'any' | undefined;
	let fixedSymbols: ManaColor[] | null = [];
	for (const s of addSteps) {
		if (s.params?.manaRestriction) manaRestriction = s.params.manaRestriction;
		const amt = s.amount?.k === 'const' ? s.amount.n : 1;
		const choice = s.params?.manaChoice;
		if (choice === 'opponentLandColors') {
			fixedSymbols = null;
			opponentLands = true;
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
		amount: Math.max(1, totalAmount),
		...(opponentLands ? { opponentLandColors: true } : {}),
		...(manaRestriction ? { manaRestriction } : {}),
		...(manaBundles ? { manaBundles } : {}),
		...(manaCombinationColors ? { manaCombinationColors } : {})
	};
}

interface BuildEffectiveAbilityOptions {
	idOverride?: string;
	displayCardName: string;
	displayCard: ScryfallCard;
	grantSourceCard?: ScryfallCard;
	grantSources?: string[];
	labelOverride?: string;
	costTextOverride?: string;
	effectTextOverride?: string;
	chosenColor?: ManaColor;
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
	const loyaltyCost = loyaltyDef ? loyaltyDef.delta : null;
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
	const freezesSelfUntap =
		isMana && effect.some((s) => s.verb === 'freezeUntap' && s.subject.k === 'self');
	if (isMana) {
		const prod = manaStepProduction(effect, commanderIdentity, opts.chosenColor);
		if (prod?.opponentLandColors) {
			const oppColors = resolveOpponentLandColors ? resolveOpponentLandColors() : [];
			if (oppColors.length === 0) return null;
			producesMana = oppColors;
			producesAmount = prod.amount;
			hasManaProduction = true;
			manaRestriction = prod.manaRestriction;
		} else if (prod) {
			producesMana = prod.colors;
			producesAmount = prod.colors.length > 0 ? prod.amount : 0;
			hasManaProduction = true;
			manaRestriction = prod.manaRestriction;
			manaBundles = prod.manaBundles;
			manaCombinationColors = prod.manaCombinationColors;
		}
		const dynStep = effect.find((s) => s.verb === 'addMana' && s.amount && s.amount.k !== 'const');
		if (dynStep?.amount) manaAmount = dynStep.amount;
	}

	const modal = ab.kind === 'activated' ? ab.modal : undefined;
	const targetInfo = modal ? modalTargetRequirement(modal) : targetRequirementFromSpecs(targets);
	const isPureTapMana = isMana && id === 'mana_tap' && !manaBundles && !manaCombinationColors && !freezesSelfUntap;
	const sourceSuffix = opts.grantSources && opts.grantSources.length > 0 ? ` (${opts.grantSources.join(', ')})` : '';
	const maxEffectLen = opts.grantSources ? 60 : 45;
	const baseLabel =
		isPureTapMana && producesMana.length > 0
			? `Tap: Add ${producesAmount > 1 ? `${producesAmount}x ` : ''}${producesMana.map((c) => `{${c}}`).join('/')}`
			: loyaltyCost !== null
				? `${loyaltyCost >= 0 ? `+${loyaltyCost}` : loyaltyCost}: ${effectPart.slice(0, 48)}`
				: `${costPart}: ${effectPart.slice(0, maxEffectLen)}`;
	const label = opts.labelOverride ?? `${baseLabel}${sourceSuffix}`;
	const costText =
		opts.costTextOverride ??
		(isPureTapMana
			? '{T}'
			: loyaltyCost !== null
				? `${loyaltyCost >= 0 ? `+${loyaltyCost}` : loyaltyCost}`
				: costPart);
	const activationZones = ab.kind === 'activated' ? ab.activationZones : undefined;
	const costKeyword = ab.kind === 'activated' ? ab.costKeyword : undefined;
	const activationCondition = ab.activationCondition;

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
		producesMana,
		producesAmount,
		...(manaAmount ? { manaAmount } : {}),
		...(manaRestriction ? { manaRestriction } : {}),
		...(manaBundles ? { manaBundles } : {}),
		...(manaCombinationColors ? { manaCombinationColors } : {}),
		...(freezesSelfUntap ? { freezesSelfUntap: true } : {}),
		...(opts.grantSourceCard ? { grantSourceCard: opts.grantSourceCard } : {}),
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
	chosenColor?: ManaColor
): EffectiveActivatedAbility[] {
	const out: EffectiveActivatedAbility[] = [];

	const intrinsicColors: ManaColor[] = [];
	for (const ab of abilities) {
		if (ab.kind === 'activated' && ab.intrinsic) {
			for (const s of ab.effect) {
				for (const c of s.params?.mana ?? []) {
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
				const equipCost = kwCost ?? '{0}';
				const filter = equipFilter ?? {};
				const qual = [
					...(filter.supertypes?.map((s) => s.toLowerCase()) ?? []),
					...(filter.subtypes ?? [])
				].join(' ');
				const equipTargetPhrase = qual ? `${qual} creature` : 'creature';
				const labelPrefix = qual ? `Equip ${qual} ${equipCost}` : `Equip ${equipCost}`;
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
					cost: equipCost && equipCost !== '{0}' ? [{ k: 'mana', cost: equipCost }] : [],
					costComplete: true,
					requiresTap: false,
					requiresSacrificeSelf: false,
					lifeCost: 0,
					loyaltyCost: null,
					isManaAbility: false,
					sorcerySpeedOnly: true,
					costKeyword: 'equip',
					producesMana: [],
					producesAmount: 0,
					effectText: `Attach to target ${equipTargetPhrase} you control.`,
					requiresTarget: true,
					targetKind: 'controlled_creature',
					targetInfo
				});
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
								chosenColor
							}
						);
						if (effective) out.push({ ...effective, faceIndex });
					}
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
				chosenColor
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
	chosenColor?: ManaColor
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
				chosenColor
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
			perm.chosenColor
		).filter((ab) => !ab.grantCondition);
	} else {
		const breakdown = inspectCardContinuousBreakdown(perm, state);
		const allInnateRemoved = permanentHasLostAllAbilities(perm, state).lost;
		const effectiveCard = perm.copiableCard ?? perm.card;
		rawAbilities = allInnateRemoved
			? []
			: getCardActivatedAbilities(
					effectiveCard,
					commanderIdentity,
					resolveOppLands,
					instanceFaceOptions(perm, 'battlefield'),
					perm.chosenColor
				).filter(
					(ab) =>
						!ab.grantCondition ||
						evaluateFilterCondition(ab.grantCondition, {
							state,
							controllerId: actor.playerId,
							source: perm
						})
				);

		// Add granted activated abilities from Layer 4 / Layer 6 IR (`AttributedKeywordOrEffect.grantedAbility`)
		for (const item of breakdown.items) {
			if (item.removed || item.isInnate || !item.grantedAbility) continue;
			const grantedIr = item.grantedAbility;
			const abId = grantedIr.intrinsic
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
				grantSources: item.sources,
				chosenColor: grantSourceChosenColor ?? perm.chosenColor
			});
			if (built) rawAbilities.push(built);
		}
	}

	return rawAbilities.map((ab) => {
		const { manaCost: effMana } = effectiveAbilityManaCost(
			state,
			actor.playerId,
			ab.id,
			ab.manaCost,
			ab.costKeyword
		);
		if (effMana !== ab.manaCost) {
			const nextCost = ab.cost.map((c) =>
				c.k === 'mana' ? { k: 'mana' as const, cost: effMana } : c
			);
			const filteredCost =
				effMana === '{0}' || effMana === '' ? nextCost.filter((c) => c.k !== 'mana') : nextCost;
			const nextCostText =
				ab.id.startsWith('equip_') && effMana === '{0}'
					? 'Equip {0}'
					: ab.manaCost && ab.costText.includes(ab.manaCost)
						? ab.costText.replace(ab.manaCost, effMana || '{0}')
						: ab.costText;
			const nextLabel =
				ab.id.startsWith('equip_') && effMana === '{0}'
					? `Equip {0} (was ${ab.manaCost})`
					: ab.manaCost && ab.label.includes(ab.manaCost)
						? ab.label.replace(ab.manaCost, effMana || '{0}')
						: ab.label;
			return {
				...ab,
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
