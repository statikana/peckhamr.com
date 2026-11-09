import { cardManaSteps as compiledCardManaSteps, compileCard } from './compiler/index.ts';
import type { CostDef, EffectStep, TargetSpec } from './ir.ts';
import { effectiveAbilityManaCost } from './runtime/costs.ts';
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
	checkGraveyardReplacementZone,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame
} from './runtime/replace.ts';
import type {
	CardInstance,
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
	if (spec.kind === 'objectOrPlayer') {
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
		const controllerFilter = f.controller ?? 'any';
		let cardTypeFilter: string | undefined;
		if (f.notTypes?.includes('Creature')) cardTypeFilter = 'Noncreature';
		else if (f.types?.includes('Instant') && f.types?.includes('Sorcery')) {
			cardTypeFilter = 'InstantOrSorcery';
		} else if (f.types?.length === 1) {
			cardTypeFilter = f.types[0];
		}
		return {
			requiresTarget: minTargets > 0,
			targetKind: 'spell',
			minTargets,
			maxTargets,
			zone: 'stack',
			sameGraveyard: false,
			controllerFilter,
			...(cardTypeFilter ? { cardTypeFilter } : {}),
			targetSpecs: specs
		};
	}
	if (f.zone === 'graveyard') {
		const controllerFilter = f.owner ?? f.controller ?? 'any';
		const sameGraveyard = Boolean(spec.sameOwner || f.owner === 'you' || maxTargets <= 1);
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
			targetKind: 'graveyard_card',
			minTargets,
			maxTargets,
			zone: 'graveyard',
			sameGraveyard,
			controllerFilter,
			...(cardTypeFilter ? { cardTypeFilter } : {}),
			targetSpecs: specs
		};
	}
	const controllerFilter = f.controller ?? 'any';
	let targetKind = 'permanent';
	let cardTypeFilter: string | undefined = 'Permanent';
	if (f.types?.length === 1 && f.types[0] === 'Creature') {
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
export function getSpellTargetRequirement(card: ScryfallCard): TargetRequirementInfo {
	const def = compileCard(card);
	const abilities = def.faces[0]?.abilities ?? [];
	const types = def.faces[0]?.characteristics.types ?? [];
	const subtypes = def.faces[0]?.characteristics.subtypes ?? [];
	if (subtypes.includes('Aura')) {
		for (const ab of abilities) {
			if (ab.kind === 'keyword') {
				const { name: kwName, enchantFilter } = ab.keyword;
				if (kwName === 'enchant') {
					const spec: TargetSpec = {
						kind: 'object',
						filter: { zone: 'battlefield', ...(enchantFilter ?? {}) },
						min: 1,
						max: 1
					};
					return targetRequirementFromSpecs([spec]);
				}
			}
		}
		return targetRequirementFromSpecs([
			{ kind: 'object', filter: { zone: 'battlefield' }, min: 1, max: 1 }
		]);
	}
	if (!types.includes('Instant') && !types.includes('Sorcery')) {
		return NO_TARGET_REQUIREMENT;
	}
	for (const ab of abilities) {
		if (ab.kind === 'spell') {
			if (ab.modal) {
				const branches = ab.modal.modes.map((m) => targetRequirementFromSpecs(m.targets));
				const firstReq = branches.find((b) => b.requiresTarget) ?? branches[0] ?? NO_TARGET_REQUIREMENT;
				const anyReq = branches.some((b) => b.requiresTarget);
				return {
					requiresTarget: anyReq,
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
			return targetRequirementFromSpecs(ab.targets);
		}
		if (ab.kind === 'unsupported' && ab.id === 'cast' && ab.targets) {
			return targetRequirementFromSpecs(ab.targets);
		}
	}
	return NO_TARGET_REQUIREMENT;
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
								? oppCmdId.length > 0
									? oppCmdId
									: ['W', 'U', 'B', 'R', 'G']
								: Array.isArray(choice)
									? choice
									: (s.params?.mana ?? []);
					for (const c of cols) if (c !== 'C') found.add(c);
				}
			}
			for (const t of ['Plains:W', 'Island:U', 'Swamp:B', 'Mountain:R', 'Forest:G'] as const) {
				const [sub, col] = t.split(':') as [string, ManaColor];
				if (oppEval.typeLine.includes(sub)) found.add(col);
			}
		}
	}
	return (['W', 'U', 'B', 'R', 'G'] as ManaColor[]).filter((c) => found.has(c));
}

function manaStepProduction(
	steps: EffectStep[],
	commanderIdentity: ManaColor[]
): { colors: ManaColor[]; amount: number; opponentLandColors?: boolean } | null {
	const addSteps = steps.filter((s) => s.verb === 'addMana');
	if (addSteps.length === 0) return null;
	const anyColors: ManaColor[] =
		commanderIdentity.length > 0 ? commanderIdentity : ['W', 'U', 'B', 'R', 'G'];
	const colors: ManaColor[] = [];
	let totalAmount = 0;
	let opponentLands = false;
	for (const s of addSteps) {
		const amt = s.amount?.k === 'const' ? s.amount.n : 1;
		const choice = s.params?.manaChoice;
		if (choice === 'opponentLandColors') {
			opponentLands = true;
			totalAmount += amt;
		} else if (choice === 'any' || choice === 'commanderIdentity') {
			for (const c of anyColors) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
		} else if (Array.isArray(choice)) {
			for (const c of choice) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += amt;
		} else if (Array.isArray(s.params?.mana)) {
			for (const c of s.params.mana) {
				if (!colors.includes(c)) colors.push(c);
			}
			totalAmount += s.amount?.k === 'const' ? s.amount.n : s.params.mana.length || 1;
		}
	}
	return {
		colors,
		amount: Math.max(1, totalAmount),
		...(opponentLands ? { opponentLandColors: true } : {})
	};
}

/**
 * Builds the innate activated abilities of `card` from its compiled IR.
 */
export function getCardActivatedAbilities(
	card: ScryfallCard,
	commanderIdentity: ManaColor[] = ['W', 'U', 'B', 'R', 'G'],
	resolveOpponentLandColors?: () => ManaColor[]
): EffectiveActivatedAbility[] {
	const abilities = compileCard(card).faces[0]?.abilities ?? [];
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
				producesMana: [],
				producesAmount: 0,
				effectText: `Attach to target ${equipTargetPhrase} you control.`,
				requiresTarget: true,
				targetKind: 'controlled_creature',
				targetInfo
			});
			}
			continue;
		}

		if (
			(ab.kind === 'activated' && !ab.intrinsic) ||
			(ab.kind === 'unsupported' && ab.id && ab.id !== 'cast')
		) {
			if (ab.id === 'mana_tap' && out.some((x) => x.id === 'mana_tap')) continue;
			const cost = ab.kind === 'activated' ? ab.cost : (ab.cost ?? []);
			const costComplete = ab.kind === 'activated' ? true : (ab.costComplete ?? false);
			const timing = ab.kind === 'activated' ? ab.timing : (ab.timing ?? 'instant');
			const isMana =
				ab.kind === 'activated'
					? ab.isMana
					: Boolean(ab.isMana && ab.effect && ab.effect.length > 0);
			const effect = ab.kind === 'activated' ? ab.effect : (ab.effect ?? []);
			const targets = ab.kind === 'activated' ? ab.targets : (ab.targets ?? []);
			const fullText = (ab.text ?? '').replace(/~/g, card.name);
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
			if (isMana) {
				const prod = manaStepProduction(effect, commanderIdentity);
				if (prod?.opponentLandColors) {
					const oppColors = resolveOpponentLandColors ? resolveOpponentLandColors() : [];
					if (oppColors.length === 0) continue;
					producesMana = oppColors;
					producesAmount = prod.amount;
				} else if (prod && prod.colors.length > 0) {
					producesMana = prod.colors;
					producesAmount = prod.amount;
				}
			}

			const targetInfo = targetRequirementFromSpecs(targets);
			const isPureTapMana = isMana && ab.id === 'mana_tap';
			const label = isPureTapMana
				? `Tap: Add ${producesAmount > 1 ? `${producesAmount}x ` : ''}${producesMana.map((c) => `{${c}}`).join('/')}`
				: loyaltyCost !== null
					? `${loyaltyCost >= 0 ? `+${loyaltyCost}` : loyaltyCost}: ${effectPart.slice(0, 48)}`
					: `${costPart}: ${effectPart.slice(0, 45)}`;
			const costText = isPureTapMana
				? '{T}'
				: loyaltyCost !== null
					? `${loyaltyCost >= 0 ? `+${loyaltyCost}` : loyaltyCost}`
					: costPart;

			out.push({
				id: ab.id!,
				label,
				costText,
				manaCost,
				cost,
				costComplete,
				requiresTap,
				requiresSacrificeSelf,
				lifeCost,
				loyaltyCost,
				isManaAbility: isMana && producesMana.length > 0,
				sorcerySpeedOnly: timing === 'sorcery',
				producesMana,
				producesAmount,
				effectText: effectPart,
				requiresTarget: targetInfo.requiresTarget,
				targetKind: targetInfo.targetKind,
				targetInfo
			});
		}
	}

	return out;
}

/**
 * Returns the activated abilities of a permanent from its compiled IR, with continuous layer
 * grants/ability-loss and active cost modifiers applied.
 */
export function getEffectiveActivatedAbilities(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	commanderIdentity: ManaColor[] = ['W', 'U', 'B', 'R', 'G']
): EffectiveActivatedAbility[] {
	const breakdown = inspectCardContinuousBreakdown(perm, state);
	const allInnateRemoved = breakdown.items.some(
		(it) => it.isInnate && it.removed && it.removedBy.length > 0
	);

	const effectiveCard = perm.copiableCard ?? perm.card;
	let rawAbilities = allInnateRemoved
		? []
		: getCardActivatedAbilities(effectiveCard, commanderIdentity, () =>
				state.lobbyCode === 'GOLDEN'
					? (['W', 'U', 'B', 'R', 'G'] as ManaColor[])
					: opponentLandColors(state, actor)
			);

	// Add granted mana abilities from continuous type-changing effects (Imprisoned in the Moon, Song of the Dryads, Blood Moon, Urborg, Yavimaya)
	for (const item of breakdown.items) {
		if (!item.removed && !item.isInnate && item.name.startsWith('Mana Ability: Add ')) {
			const colorMatch = item.name.match(/Add \{([WUBRGC])\}/);
			if (colorMatch) {
				const col = colorMatch[1] as ManaColor;
				const abId = `granted_mana_${col.toLowerCase()}`;
				if (!rawAbilities.some((a) => a.id === abId)) {
					rawAbilities = [
						...rawAbilities,
						{
							id: abId,
							label: `{T}: Add {${col}} (${item.sources.join(', ')})`,
							costText: '{T}',
							manaCost: '{0}',
							cost: [{ k: 'tapSelf' }],
							costComplete: true,
							requiresTap: true,
							requiresSacrificeSelf: false,
							lifeCost: 0,
							loyaltyCost: null,
							isManaAbility: true,
							producesMana: [col],
							producesAmount: 1,
							effectText: `Add {${col}}.`,
							requiresTarget: false,
							targetKind: 'none',
							targetInfo: NO_TARGET_REQUIREMENT
						}
					];
				}
			}
		}
	}

	return rawAbilities.map((ab) => {
		const { manaCost: effMana } = effectiveAbilityManaCost(
			state,
			actor.playerId,
			ab.id,
			ab.manaCost
		);
		if (effMana !== ab.manaCost) {
			const nextCost = ab.cost.map((c) =>
				c.k === 'mana' ? { k: 'mana' as const, cost: effMana } : c
			);
			const filteredCost =
				effMana === '{0}' || effMana === '' ? nextCost.filter((c) => c.k !== 'mana') : nextCost;
			return {
				...ab,
				manaCost: effMana,
				cost: filteredCost,
				costText: ab.id.startsWith('equip_') && effMana === '{0}' ? 'Equip {0}' : ab.costText,
				label:
					ab.id.startsWith('equip_') && effMana === '{0}'
						? `Equip {0} (was ${ab.manaCost})`
						: ab.label
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
	checkGraveyardReplacementZone,
	getLibrarySearchInterceptor,
	playerCannotLoseGame,
	playerCannotWinGame
};
