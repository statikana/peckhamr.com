/**
 * Runtime helpers for Track P3 orthogonal CR 702 keywords:
 * - Foretell (CR 702.143, CR 116.2h)
 * - Plot (CR 702.170, CR 116.2k)
 * - Saddle N (CR 702.171)
 * - Entwine [cost] (CR 702.42)
 * - Disturb [cost] (CR 702.146, CR 712.8c)
 * - Blitz [cost] (CR 702.152)
 * - Retrace (CR 702.81)
 * - Jump-start (CR 702.133)
 * - Cumulative upkeep [cost] (CR 702.24)
 *
 * Pure IR and GameState metadata only — zero card-name or runtime rules-text reads.
 */
import { compileCard } from '../compiler/index.ts';
import { hasWarpExilePermission } from './striatedFrames.ts';
import type { CardDefinition, CostDef } from '../ir.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	DelayedTrigger,
	GameState,
	HandSpecialActionOption,
	ScryfallCard,
	TargetRequirementInfo
} from '../types.ts';

const PLOT_KEYWORD_SET: ReadonlySet<string> = new Set(['plot']);
const RETRACE_KEYWORD_SET: ReadonlySet<string> = new Set(['retrace']);
const JUMP_START_KEYWORD_SET: ReadonlySet<string> = new Set(['jump-start']);

/**
 * Enumerates intrinsic hand special actions (CR 116.2h Foretell, CR 116.2k Plot) from compiled IR.
 */
export function enumerateHandSpecialActions(card: ScryfallCard): HandSpecialActionOption[] {
	const def = compileCard(card);
	const face0 = def.faces[0];
	if (!face0) return [];
	const out: HandSpecialActionOption[] = [];
	let hasForetell = false;
	let plotCostDefs: CostDef[] | undefined;
	let plotRawCost = '';
	for (const ab of face0.abilities) {
		if (ab.kind !== 'keyword') continue;
		const { name, costDefs, cost, param } = ab.keyword;
		if (name === 'foretell' && costDefs && costDefs.length > 0) {
			hasForetell = true;
		} else if (name === 'plot' && costDefs && costDefs.length > 0 && !plotCostDefs) {
			plotCostDefs = costDefs;
			plotRawCost = (cost ?? param ?? '').trim();
		}
	}
	if (hasForetell) {
		out.push({
			id: 'special:foretell',
			label: 'Foretell ({2})',
			costDisplay: '{2}',
			costDefs: [{ k: 'mana', cost: '{2}' }],
			sorcerySpeedOnly: false
		});
	}
	if (plotCostDefs) {
		out.push({
			id: 'special:plot',
			label: plotRawCost ? `Plot (${plotRawCost})` : 'Plot',
			costDisplay: plotRawCost || '{0}',
			costDefs: plotCostDefs,
			sorcerySpeedOnly: true
		});
	}
	return out;
}

/**
 * True when `inst` in exile carries an owner-scoped keyword cast permission (Foretell, Plot, or Warp) for `actorId`.
 */
export function hasExileKeywordPermission(inst: CardInstance, actorId: string): boolean {
	return (
		(inst.foretoldByPlayerId === actorId && inst.ownerId === actorId) ||
		(inst.plottedByPlayerId === actorId && inst.ownerId === actorId) ||
		hasWarpExilePermission(inst, actorId)
	);
}

export interface TrackP3CastOptionHooks {
	state: GameState;
	actorId: string;
	inst: CardInstance;
	card: ScryfallCard;
	def: CardDefinition;
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard';
	taxSuffix: string;
	keywordAltCost: (
		card: ScryfallCard,
		keyword: string,
		faceIndex?: number
	) => { manaCost?: string; costDefs: CostDef[]; display: string } | null;
	spellAdditionalCost: (
		card: ScryfallCard,
		faceIndex?: number,
		fused?: boolean
	) => { defs: CostDef[]; complete: boolean } | null;
	spellOptionalAdditionalCosts: (
		card: ScryfallCard,
		faceIndex?: number,
		fused?: boolean
	) => CastOptionOptionalCost[];
	buildPaymentAids: (
		fromZone: 'hand' | 'command' | 'exile' | 'graveyard',
		faceIndex: number,
		fused: boolean,
		isFree: boolean
	) => CastCostAid[] | undefined;
	getSpellTargetRequirement: (card: ScryfallCard, option?: CastOption) => TargetRequirementInfo;
	spellChoosesX: (
		card: ScryfallCard,
		baseCost: CastOption['baseCost'],
		extraManaCosts: string[] | undefined,
		faceIndex: number,
		fused: boolean
	) => boolean;
}

/**
 * Builds CastOption entries for Foretell (exile), Plot (exile), Disturb (graveyard back face),
 * Retrace (graveyard), and Jump-start (graveyard).
 */
export function buildTrackP3CastOptions(h: TrackP3CastOptionHooks): CastOption[] {
	const { state, actorId, inst, card, def, fromZone, taxSuffix } = h;
	if (inst.castViaSuspend) return [];
	const out: CastOption[] = [];
	const isMultiFace = def.faces.length > 1;

	if (fromZone === 'exile' && inst.ownerId === actorId) {
		const face0 = def.faces[0];
		const face0Types = face0?.characteristics.types ?? [];
		const isLandOnlyFace0 = face0Types.includes('Land') && !face0Types.includes('Creature');

		// CR 702.143a–c: Cast a foretold card from exile on a later turn for its foretell cost.
		if (
			!isLandOnlyFace0 &&
			inst.foretoldByPlayerId === actorId &&
			inst.foretoldTurnNumber !== undefined &&
			state.turnNumber > inst.foretoldTurnNumber
		) {
			const altCost = h.keywordAltCost(card, 'foretell', 0);
			if (altCost) {
				const baseCost: CastOption['baseCost'] = {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				};
				const additional = h.spellAdditionalCost(card, 0, false);
				const mandatoryAdditionalCosts =
					additional && additional.defs.length > 0 ? additional.defs : undefined;
				const optionalAdditionalCosts = h.spellOptionalAdditionalCosts(card, 0, false);
				const paymentAids = h.buildPaymentAids('exile', 0, false, false);
				const spellMods = {
					foretold: true,
					castSummarySuffix: ' (Foretold)',
					label: 'Foretold'
				};
				const targetInfo = h.getSpellTargetRequirement(card, {
					faceIndex: 0,
					spellMods
				} as CastOption);
				out.push({
					id: 'exile:foretell',
					label: 'Cast Foretold',
					costDisplay: `${altCost.display}${taxSuffix}`,
					fromZone: 'exile',
					permission: 'keyword_alt',
					...(isMultiFace ? { faceIndex: 0 } : {}),
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
					...(paymentAids ? { paymentAids } : {}),
					timing: 'default',
					spellMods,
					choosesX: h.spellChoosesX(card, baseCost, undefined, 0, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}
		}

		// CR 702.170d: Cast a plotted card from exile without paying its mana cost as a sorcery on a later turn.
		if (
			!isLandOnlyFace0 &&
			inst.plottedByPlayerId === actorId &&
			inst.plottedTurnNumber !== undefined &&
			state.turnNumber > inst.plottedTurnNumber &&
			face0?.abilities.some((a) => a.kind === 'keyword' && PLOT_KEYWORD_SET.has(a.keyword.name))
		) {
			const baseCost: CastOption['baseCost'] = { kind: 'free' };
			const additional = h.spellAdditionalCost(card, 0, false);
			const mandatoryAdditionalCosts =
				additional && additional.defs.length > 0 ? additional.defs : undefined;
			const optionalAdditionalCosts = h.spellOptionalAdditionalCosts(card, 0, false);
			const paymentAids = h.buildPaymentAids('exile', 0, false, true);
			const spellMods = {
				castSummarySuffix: ' (Plotted)',
				label: 'Plotted'
			};
			const targetInfo = h.getSpellTargetRequirement(card, {
				faceIndex: 0,
				spellMods
			} as CastOption);
			out.push({
				id: 'exile:plot',
				label: 'Cast Plotted',
				costDisplay: `{0}${taxSuffix}`,
				fromZone: 'exile',
				permission: 'keyword_alt',
				...(isMultiFace ? { faceIndex: 0 } : {}),
				baseCost,
				...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
				...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
				...(paymentAids ? { paymentAids } : {}),
				timing: 'sorcery_only',
				spellMods,
				choosesX: h.spellChoosesX(card, baseCost, undefined, 0, false),
				requiresTarget: targetInfo.requiresTarget
			});
		}
	}

	if (fromZone === 'graveyard' && inst.ownerId === actorId) {
		// CR 702.146a–b / CR 712.8c: Disturb casts the card transformed (back face up, faceIndex = 1) from graveyard.
		if (def.faces.length >= 2) {
			const backFace = def.faces[1];
			const backTypes = backFace.characteristics.types;
			const altCost = h.keywordAltCost(card, 'disturb', 0);
			if (altCost && !backTypes.includes('Land')) {
				const baseCost: CastOption['baseCost'] = {
					kind: 'alternative',
					...(altCost.manaCost !== undefined ? { manaCost: altCost.manaCost } : {}),
					...(altCost.costDefs.length > 0 ? { costDefs: altCost.costDefs } : {})
				};
				const additional = h.spellAdditionalCost(card, 1, false);
				const mandatoryAdditionalCosts =
					additional && additional.defs.length > 0 ? additional.defs : undefined;
				const optionalAdditionalCosts = h.spellOptionalAdditionalCosts(card, 1, false);
				const paymentAids = h.buildPaymentAids('graveyard', 1, false, false);
				const spellMods = {
					castTransformed: true,
					castSummarySuffix: ' (Disturb)',
					label: 'Disturb'
				};
				const targetInfo = h.getSpellTargetRequirement(card, {
					faceIndex: 1,
					spellMods
				} as CastOption);
				out.push({
					id: 'alt:disturb',
					label: `Cast with Disturb (${backFace.name})`,
					costDisplay: `${altCost.display}${taxSuffix}`,
					fromZone: 'graveyard',
					permission: 'keyword_alt',
					faceIndex: 1,
					baseCost,
					...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
					...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
					...(paymentAids ? { paymentAids } : {}),
					timing: 'default',
					spellMods,
					choosesX: h.spellChoosesX(card, baseCost, undefined, 1, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}
		}

		// CR 702.81a (Retrace) and CR 702.133a (Jump-start): graveyard cast permissions with discard additional cost.
		const layout = def.layout ?? 'normal';
		const faceCount =
			layout === 'split' || layout === 'adventure' || layout === 'modal_dfc'
				? def.faces.length
				: 1;
		for (let fi = 0; fi < faceCount; fi++) {
			const face = def.faces[fi];
			if (!face) continue;
			const faceTypes = face.characteristics.types;
			const isLandOnlyFace = faceTypes.includes('Land') && !faceTypes.includes('Creature');
			if (isLandOnlyFace) continue;
			const faceName = face.name;
			const faceManaCost = face.characteristics.manaCost;
			const idFor = (baseId: string) => (isMultiFace ? `f${fi}:${baseId}` : baseId);
			const faceIndexProp = isMultiFace ? { faceIndex: fi } : {};
			const additional = h.spellAdditionalCost(card, fi, false);
			const baseAdditional = additional && additional.defs.length > 0 ? additional.defs : [];
			const optionalAdditionalCosts = h.spellOptionalAdditionalCosts(card, fi, false);
			const paymentAids = h.buildPaymentAids('graveyard', fi, false, false);
			const targetInfo = h.getSpellTargetRequirement(card, { faceIndex: fi } as CastOption);

			const hasRetrace = face.abilities.some(
				(a) => a.kind === 'keyword' && RETRACE_KEYWORD_SET.has(a.keyword.name)
			);
			if (hasRetrace) {
				const baseCost: CastOption['baseCost'] = { kind: 'printed' };
				const discardLand: CostDef = {
					k: 'discard',
					count: { k: 'const', n: 1 },
					filter: { types: ['Land'] }
				};
				out.push({
					id: idFor('graveyard:retrace'),
					label: isMultiFace ? `Cast with Retrace (${faceName})` : 'Cast with Retrace',
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}, Discard a land card`,
					fromZone: 'graveyard',
					permission: 'keyword_alt',
					...faceIndexProp,
					baseCost,
					mandatoryAdditionalCosts: [...baseAdditional, discardLand],
					...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
					...(paymentAids ? { paymentAids } : {}),
					timing: 'default',
					spellMods: { castSummarySuffix: ' (Retrace)', label: 'Retrace' },
					choosesX: h.spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}

			const hasJumpStart =
				(faceTypes.includes('Instant') || faceTypes.includes('Sorcery')) &&
				face.abilities.some((a) => a.kind === 'keyword' && JUMP_START_KEYWORD_SET.has(a.keyword.name));
			if (hasJumpStart) {
				const baseCost: CastOption['baseCost'] = { kind: 'printed' };
				const discardCard: CostDef = {
					k: 'discard',
					count: { k: 'const', n: 1 }
				};
				out.push({
					id: idFor('graveyard:jumpstart'),
					label: isMultiFace ? `Cast with Jump-start (${faceName})` : 'Cast with Jump-start',
					costDisplay: `${faceManaCost || '{0}'}${taxSuffix}, Discard a card`,
					fromZone: 'graveyard',
					permission: 'keyword_alt',
					...faceIndexProp,
					baseCost,
					mandatoryAdditionalCosts: [...baseAdditional, discardCard],
					...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
					...(paymentAids ? { paymentAids } : {}),
					timing: 'default',
					spellMods: {
						exileOnLeaveStack: true,
						castSummarySuffix: ' (Jump-start)',
						label: 'Jump-start'
					},
					choosesX: h.spellChoosesX(card, baseCost, undefined, fi, false),
					requiresTarget: targetInfo.requiresTarget
				});
			}
		}
	}

	return out;
}

/**
 * CR 702.24a–b: Scales a permanent's per-age-counter Cumulative upkeep cost by `ageCounters`.
 * When `ageCounters === 0` (e.g. counter placement prevented), returns `{0}` so the controller
 * may still choose to pay `{0}` or decline and sacrifice (CR 118.5).
 */
export function scaleCumulativeUpkeepCost(costDefs: CostDef[], ageCounters: number): CostDef[] {
	const n = Math.max(0, Math.floor(ageCounters));
	if (n === 0) {
		return [{ k: 'mana', cost: '{0}' }];
	}
	return costDefs.map((def): CostDef => {
		switch (def.k) {
			case 'mana': {
				const repeated = def.cost.repeat(n);
				return { k: 'mana', cost: repeated || '{0}' };
			}
			case 'payLife':
				return def.amount.k === 'const'
					? { k: 'payLife', amount: { k: 'const', n: def.amount.n * n } }
					: def;
			case 'sacrifice':
				return def.count.k === 'const'
					? { ...def, count: { k: 'const', n: def.count.n * n } }
					: def;
			case 'discard':
				return def.count.k === 'const'
					? { ...def, count: { k: 'const', n: def.count.n * n } }
					: def;
			case 'removeCounters':
				return def.count.k === 'const'
					? { ...def, count: { k: 'const', n: def.count.n * n } }
					: def;
			case 'exileFrom':
				return def.count.k === 'const'
					? { ...def, count: { k: 'const', n: def.count.n * n } }
					: def;
			case 'tapOthers':
				return def.count.k === 'const'
					? { ...def, count: { k: 'const', n: def.count.n * n } }
					: def;
			case 'tapSubsetSum':
				return def.minTotal.k === 'const'
					? { ...def, minTotal: { k: 'const', n: def.minTotal.n * n } }
					: def;
			default:
				return def;
		}
	});
}

/**
 * CR 702.152a: Builds the next-end-step sacrifice delayed trigger for a permanent whose blitz cost was paid.
 */
export function buildBlitzSacrificeDelayedTrigger(
	id: string,
	controllerId: string,
	perm: CardInstance,
	sourceCard: ScryfallCard
): DelayedTrigger {
	return {
		id,
		controllerId,
		sourceInstanceId: perm.instanceId,
		sourceCard,
		triggerPhase: 'end_step',
		targetInstanceId: perm.instanceId,
		targetObjectVersion: perm.objectVersion,
		title: `${sourceCard.name} — Blitz Sacrifice`,
		description: `Sacrifice ${sourceCard.name} at the beginning of the next end step (CR 702.152a).`,
		delayedEffect: {
			kind: 'sacrifice',
			targetInstanceId: perm.instanceId,
			targetObjectVersion: perm.objectVersion
		}
	};
}
