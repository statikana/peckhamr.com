/**
 * Track P6 — Striated & Inset Permanent Frames (`Station` CR 722, `Level up` CR 711,
 * `Prototype` CR 719) + Orthogonal Cast/Exile/Counter/Hand-Discard Keyword Helpers
 * (`Offspring` CR 702.175, `Squad` CR 702.157, `Replicate` CR 702.56, `Conspire` CR 702.78,
 * `Casualty` CR 702.153, `Warp` CR 702.185, `Vanishing` CR 702.63, `Fading` CR 702.32,
 * `Transmute` CR 702.53, `Reinforce` CR 702.77).
 *
 * Kept free of compiler/engine runtime imports so compiler, keywords, ruleTree, faces,
 * kicker, and engine can all import these helpers without circular dependencies.
 */
import type {
	AbilityDef,
	ActivatedAbility,
	CardDefinition,
	Condition,
	CostDef,
	FaceDefinition,
	KeywordDef,
	PrototypeSpec,
	ReplacementAbility,
	Span,
	TriggeredAbility
} from '../ir.ts';
import type {
	CardInstance,
	CastCostAid,
	CastOption,
	CastOptionOptionalCost,
	DelayedTrigger,
	GameState,
	ManaColor,
	ScryfallCard,
	SpellModifications,
	TargetRequirementInfo,
	ZoneType
} from '../types.ts';

// ---- Prototype (CR 719, CR 702.160) ---------------------------------------------------------

const COLORED_MANA_SYMBOLS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** CR 719.2 / CR 202.2: Derives the colors of a prototype mana cost from its colored mana symbols. */
export function parsePrototypeColorsFromManaCost(manaCost: string): ManaColor[] {
	const found: ManaColor[] = [];
	const tokens = manaCost.match(/\{[^}]+\}/g) ?? [];
	for (const tok of tokens) {
		const inner = tok.slice(1, -1).toUpperCase();
		for (const c of COLORED_MANA_SYMBOLS) {
			if (inner.split('/').includes(c) && !found.includes(c)) {
				found.push(c);
			}
		}
	}
	return found;
}

/** CR 202.3 / CR 719.3b: Computes the mana value of a mana cost string (X = 0 unless added separately). */
export function parseManaValueFromCostString(manaCost: string): number {
	let mv = 0;
	const tokens = manaCost.match(/\{[^}]+\}/g) ?? [];
	for (const tok of tokens) {
		const inner = tok.slice(1, -1).trim().toUpperCase();
		if (!inner || inner === 'X' || inner === '0') continue;
		if (/^\d+$/.test(inner)) {
			mv += parseInt(inner, 10);
			continue;
		}
		const parts = inner.split('/');
		const nums = parts.filter((p) => /^\d+$/.test(p)).map((p) => parseInt(p, 10));
		if (nums.length > 0) {
			mv += Math.max(...nums);
		} else {
			mv += 1;
		}
	}
	return mv;
}

/** Extracts the compiled `PrototypeSpec` from a `FaceDefinition`, if any. */
export function getFacePrototypeSpec(face: FaceDefinition | undefined): PrototypeSpec | undefined {
	if (!face) return undefined;
	if (face.prototypeSpec) return face.prototypeSpec;
	for (const ab of face.abilities) {
		if (ab.kind !== 'keyword') continue;
		const { name: kwName, prototypeSpec } = ab.keyword;
		if (kwName === 'prototype' && prototypeSpec) {
			return prototypeSpec;
		}
	}
	return undefined;
}

// ---- Station (CR 722, CR 702.184) & Leveler (CR 711, CR 702.87) -----------------------------

/** CR 722.2a: `"As long as this permanent has N or more charge counters on it, ..."` */
export function buildStationCounterCondition(minCharge: number): Condition {
	return {
		k: 'compare',
		left: { k: 'countersOn', counter: 'charge', of: { k: 'self' } },
		op: '>=',
		right: { k: 'const', n: minCharge }
	};
}

/** CR 711.2a–b: `"As long as this permanent has at least N1 [and at most N2] level counters on it, ..."` */
export function buildLevelRangeCondition(minLevel: number, maxLevel?: number): Condition {
	const ge: Condition = {
		k: 'compare',
		left: { k: 'countersOn', counter: 'level', of: { k: 'self' } },
		op: '>=',
		right: { k: 'const', n: minLevel }
	};
	if (maxLevel === undefined) return ge;
	return {
		k: 'and',
		of: [
			ge,
			{
				k: 'compare',
				left: { k: 'countersOn', counter: 'level', of: { k: 'self' } },
				op: '<=',
				right: { k: 'const', n: maxLevel }
			}
		]
	};
}

export function andConditions(a: Condition | undefined, b: Condition): Condition {
	if (!a) return b;
	if (a.k === 'and') return { k: 'and', of: [...a.of, b] };
	return { k: 'and', of: [a, b] };
}

/**
 * CR 702.184a: `"Tap another untapped creature you control: Put charge counters equal to its power
 * on this permanent. Activate only as a sorcery."`
 */
export function buildStationActivatedAbility(
	_kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; label: string; costText: string; effectText: string } {
	return {
		ability: {
			kind: 'activated',
			id,
			cost: [
				{
					k: 'tapOthers',
					count: { k: 'const', n: 1 },
					filter: {
						types: ['Creature'],
						controller: 'you',
						tapped: false,
						other: true
					}
				}
			],
			targets: [],
			effect: [
				{
					verb: 'putCounters',
					subject: { k: 'self' },
					amount: { k: 'tappedCostPower' },
					params: { counter: 'charge' },
					span
				}
			],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'station',
			text: 'Tap another untapped creature you control: Put charge counters equal to its power on ~. Station only as a sorcery.',
			span
		},
		label:
			'Station — Tap another untapped creature you control: Put charge counters equal to its power on this permanent',
		costText: 'Station (Tap another untapped creature)',
		effectText:
			"Put charge counters equal to the tapped creature's power on this permanent. Activate only as a sorcery."
	};
}

/**
 * CR 702.87a: `"[Cost]: Put a level counter on this permanent. Activate only as a sorcery."`
 */
export function buildLevelUpActivatedAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; label: string; costText: string; effectText: string } | null {
	const costDefs: CostDef[] =
		kw.costDefs && kw.costDefs.length > 0
			? kw.costDefs
			: kw.cost
				? [{ k: 'mana', cost: kw.cost }]
				: [];
	if (costDefs.length === 0) return null;
	const costDisplay = (kw.cost ?? kw.param ?? '').trim();
	const prefix = costDisplay ? `Level up ${costDisplay}` : 'Level up';
	return {
		ability: {
			kind: 'activated',
			id,
			cost: costDefs,
			targets: [],
			effect: [
				{
					verb: 'putCounters',
					subject: { k: 'self' },
					amount: { k: 'const', n: 1 },
					params: { counter: 'level' },
					span
				}
			],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'level up',
			text: `${costDisplay || '{0}'}: Put a level counter on ~. Level up only as a sorcery.`,
			span
		},
		label: `${prefix}: Put a level counter on this permanent`,
		costText: prefix,
		effectText: 'Put a level counter on this permanent. Activate only as a sorcery.'
	};
}

// ---- Hand-Discard Activated Keywords: Transmute (CR 702.53) & Reinforce (CR 702.77) ---------

/**
 * CR 702.53a: `"[Cost], Discard this card: Search your library for a card with the same mana value
 * as the discarded card, reveal that card, and put it into your hand. Then shuffle. Activate only
 * as a sorcery."`
 */
export function buildTransmuteActivatedAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; label: string; costText: string; effectText: string } | null {
	const baseCosts: CostDef[] =
		kw.costDefs && kw.costDefs.length > 0
			? kw.costDefs
			: kw.cost
				? [{ k: 'mana', cost: kw.cost }]
				: [];
	if (baseCosts.length === 0) return null;
	const targetMv = kw.n ?? 0;
	const costDisplay = (kw.cost ?? kw.param ?? '').trim();
	const prefix = costDisplay ? `Transmute ${costDisplay}` : 'Transmute';
	const effectText = `Search your library for a card with mana value ${targetMv}, reveal it, put it into your hand, then shuffle.`;
	return {
		ability: {
			kind: 'activated',
			id,
			cost: [...baseCosts, { k: 'discard', count: { k: 'const', n: 1 }, filter: 'self' }],
			targets: [],
			effect: [
				{
					verb: 'search',
					subject: { k: 'none' },
					params: {
						search: {
							filter: {
								manaValue: { op: '=', value: { k: 'const', n: targetMv } }
							},
							count: 1,
							upTo: true,
							statedQuality: true,
							reveal: true,
							destinations: [{ zone: 'hand' }],
							description: `a card with mana value ${targetMv}`
						}
					},
					span
				}
			],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['hand'],
			costKeyword: 'transmute',
			text: `${costDisplay}, Discard ~: ${effectText} Activate only as a sorcery.`,
			span
		},
		label: `${prefix} — Discard: Search for a card with mana value ${targetMv}`,
		costText: `${prefix}, Discard this card`,
		effectText
	};
}

/**
 * CR 702.77a: `"[Cost], Discard this card: Put N +1/+1 counters on target creature."`
 */
export function buildReinforceActivatedAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; label: string; costText: string; effectText: string } | null {
	const n = kw.n;
	if (n === undefined || n < 1) return null;
	const baseCosts: CostDef[] =
		kw.costDefs && kw.costDefs.length > 0
			? kw.costDefs
			: kw.cost
				? [{ k: 'mana', cost: kw.cost }]
				: [];
	if (baseCosts.length === 0) return null;
	const costDisplay = (kw.cost ?? '').trim();
	const prefix = costDisplay ? `Reinforce ${n}—${costDisplay}` : `Reinforce ${n}`;
	const counterWord = n === 1 ? 'a +1/+1 counter' : `${n} +1/+1 counters`;
	const effectText = `Put ${counterWord} on target creature.`;
	return {
		ability: {
			kind: 'activated',
			id,
			cost: [...baseCosts, { k: 'discard', count: { k: 'const', n: 1 }, filter: 'self' }],
			targets: [
				{
					kind: 'object',
					filter: { zone: 'battlefield', types: ['Creature'] },
					min: 1,
					max: 1
				}
			],
			effect: [
				{
					verb: 'putCounters',
					subject: { k: 'target', index: 0 },
					amount: { k: 'const', n },
					params: { counter: '+1/+1' },
					span
				}
			],
			timing: 'instant',
			isMana: false,
			activationZones: ['hand'],
			costKeyword: 'reinforce',
			text: `${costDisplay}, Discard ~: ${effectText}`,
			span
		},
		label: `${prefix} — Discard: ${effectText}`,
		costText: `${prefix}, Discard this card`,
		effectText
	};
}

// ---- Vanishing (CR 702.63) & Fading (CR 702.32) ---------------------------------------------

/**
 * CR 702.63a–b:
 * - `Vanishing N` (when `n !== undefined && n > 0`): enters with `N` time counters.
 * - Bare `Vanishing` (`n === undefined`, CR 702.63b): no ETB replacement.
 * - Both have the upkeep time-counter removal trigger (with intervening-if >= 1 time counter)
 *   and the `"When the last time counter is removed from ~, sacrifice it"` trigger.
 */
export function buildVanishingAbilities(n: number | undefined, span: Span): AbilityDef[] {
	const out: AbilityDef[] = [];
	if (n !== undefined && n > 0) {
		const etbRep: ReplacementAbility = {
			kind: 'replacement',
			replacement: {
				replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
				with: {
					k: 'modify',
					counters: { counter: 'time', amount: { k: 'const', n } }
				},
				selfReplacement: true
			},
			span
		};
		out.push(etbRep);
	}
	const upkeepTrig: TriggeredAbility = {
		kind: 'triggered',
		trigger: {
			event: 'phaseBegin',
			filter: { phase: 'upkeep' },
			scope: 'controller_turn'
		},
		condition: {
			k: 'compare',
			left: { k: 'countersOn', counter: 'time', of: { k: 'self' } },
			op: '>=',
			right: { k: 'const', n: 1 }
		},
		targets: [],
		effect: [
			{
				verb: 'removeCounters',
				subject: { k: 'self' },
				amount: { k: 'const', n: 1 },
				params: { counter: 'time' },
				span
			}
		],
		text: 'At the beginning of your upkeep, if ~ has a time counter on it, remove a time counter from it.',
		span
	};
	const lastRemovedTrig: TriggeredAbility = {
		kind: 'triggered',
		trigger: {
			event: 'counterRemoved',
			filter: { object: 'self', counter: 'time', lastCounter: true }
		},
		targets: [],
		effect: [
			{
				verb: 'sacrifice',
				subject: { k: 'self' },
				span
			}
		],
		text: 'When the last time counter is removed from ~, sacrifice it.',
		span
	};
	out.push(upkeepTrig, lastRemovedTrig);
	return out;
}

/**
 * CR 702.32a:
 * - Enters with `N` fade counters.
 * - `"At the beginning of your upkeep, remove a fade counter from this permanent. If you can't, sacrifice the permanent."`
 */
export function buildFadingAbilities(n: number, span: Span): AbilityDef[] {
	const out: AbilityDef[] = [];
	if (n > 0) {
		const etbRep: ReplacementAbility = {
			kind: 'replacement',
			replacement: {
				replaces: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
				with: {
					k: 'modify',
					counters: { counter: 'fade', amount: { k: 'const', n } }
				},
				selfReplacement: true
			},
			span
		};
		out.push(etbRep);
	}
	const upkeepTrig: TriggeredAbility = {
		kind: 'triggered',
		trigger: {
			event: 'phaseBegin',
			filter: { phase: 'upkeep' },
			scope: 'controller_turn'
		},
		targets: [],
		effect: [
			{
				verb: 'removeCounters',
				subject: { k: 'self' },
				amount: { k: 'const', n: 1 },
				params: { counter: 'fade', ifUnableSacrificeSelf: true },
				span
			}
		],
		text: "At the beginning of your upkeep, remove a fade counter from ~. If you can't, sacrifice it.",
		span
	};
	out.push(upkeepTrig);
	return out;
}

// ---- Optional-Cost Trigger Builders (Offspring, Squad, Replicate, Conspire, Casualty) -------

/** CR 702.175a: `"When this permanent enters, if its offspring cost was paid, create a token that's a copy of it, except it's 1/1."` */
export function buildOffspringTrigger(span: Span): TriggeredAbility {
	return {
		kind: 'triggered',
		trigger: {
			event: 'zoneChange',
			filter: { object: 'self', to: 'battlefield' }
		},
		condition: { k: 'kicked', tag: 'offspring' },
		targets: [],
		effect: [
			{
				verb: 'copyPermanent',
				subject: { k: 'self' },
				amount: { k: 'const', n: 1 },
				params: { exceptPT: { power: 1, toughness: 1 } },
				span
			}
		],
		text: "When ~ enters, if its offspring cost was paid, create a token that's a copy of it, except it's 1/1.",
		span
	};
}

/** CR 702.157a: `"When this creature enters, if its squad cost was paid, create a token that's a copy of it for each time its squad cost was paid."` */
export function buildSquadTrigger(span: Span): TriggeredAbility {
	return {
		kind: 'triggered',
		trigger: {
			event: 'zoneChange',
			filter: { object: 'self', to: 'battlefield' }
		},
		condition: { k: 'kicked', tag: 'squad' },
		targets: [],
		effect: [
			{
				verb: 'copyPermanent',
				subject: { k: 'self' },
				amount: { k: 'kickedCount', tag: 'squad' },
				span
			}
		],
		text: "When ~ enters, if its squad cost was paid, create a token that's a copy of it for each time its squad cost was paid.",
		span
	};
}

/** CR 702.56a / 702.78a / 702.153a: Cast trigger that copies `~` on the stack (`mayChooseNewTargets: true`). */
export function buildOptionalCostCastCopyTrigger(
	tag: 'replicate' | 'conspire' | 'casualty',
	repeatable: boolean,
	span: Span
): TriggeredAbility {
	return {
		kind: 'triggered',
		trigger: {
			event: 'cast',
			filter: { object: 'self', player: { relation: 'you' } }
		},
		condition: { k: 'kicked', tag },
		targets: [],
		effect: [
			{
				verb: 'copySpell',
				subject: { k: 'self' },
				params: {
					count: repeatable ? { k: 'kickedCount', tag } : { k: 'const', n: 1 },
					mayChooseNewTargets: true
				},
				span
			}
		],
		text: repeatable
			? `When you cast ~, if its ${tag} cost was paid, copy it for each time its ${tag} cost was paid. You may choose new targets for the copies.`
			: `When you cast ~, if its ${tag} cost was paid, copy it. You may choose new targets for the copy.`,
		span
	};
}

// ---- Warp (CR 702.185) & Prototype (CR 719.3) Runtime Helpers -------------------------------

/** CR 702.185a: True when `inst` in exile was exiled by Warp and the turn it was exiled has ended. */
export function canCastWarpedFromExile(
	state: GameState,
	inst: CardInstance,
	actorId: string
): boolean {
	if (inst.zone !== 'exile') return false;
	if (!inst.warpedByOwnerId || inst.warpedByOwnerId !== actorId) return false;
	const currentSerial = state.turnSerial ?? state.turnNumber;
	return currentSerial > (inst.warpedTurnSerial ?? 0);
}

/** CR 702.185a: True when `inst` has a Warp exile permission owned by `actorId` (even before the turn ends, for zone-permission gate). */
export function hasWarpExilePermission(inst: CardInstance, actorId: string): boolean {
	return Boolean(inst.warpedByOwnerId && inst.warpedByOwnerId === actorId);
}

/** CR 702.185a: Builds the next-end-step exile delayed trigger when a Warped permanent enters the battlefield. */
export function buildWarpExileDelayedTrigger(
	id: string,
	controllerId: string,
	perm: CardInstance
): DelayedTrigger {
	return {
		id,
		controllerId,
		sourceInstanceId: perm.instanceId,
		sourceCard: perm.card,
		triggerPhase: 'end_step',
		targetInstanceId: perm.instanceId,
		targetObjectVersion: perm.objectVersion,
		title: `${perm.card.name} (Warp)`,
		description: `Exile ${perm.card.name} at the beginning of the next end step (CR 702.185a).`,
		delayedEffect: {
			kind: 'warpExile',
			targetInstanceId: perm.instanceId,
			targetObjectVersion: perm.objectVersion
		}
	};
}

export interface BuildTrackP6CastOptionsParams {
	state: GameState;
	actorId: string;
	inst: CardInstance;
	card: ScryfallCard;
	def: CardDefinition;
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard';
	isMultiFace: boolean;
	layout: string;
	candidateFaceIndices: number[];
	taxSuffix: string;
	spellAdditionalCost: (
		card: ScryfallCard,
		faceIndex: number,
		fused: boolean
	) => { defs: CostDef[]; complete: boolean } | null;
	spellOptionalAdditionalCosts: (
		card: ScryfallCard,
		faceIndex: number,
		fused: boolean,
		prototyped?: boolean
	) => CastOptionOptionalCost[];
	buildPaymentAids: (
		fromZone: 'hand' | 'command' | 'exile' | 'graveyard',
		faceIndex: number,
		fused: boolean,
		isFaceDown: boolean
	) => CastCostAid[] | undefined;
	getSpellTargetRequirement: (card: ScryfallCard, option?: CastOption) => TargetRequirementInfo;
	spellChoosesX: (
		card: ScryfallCard,
		baseCost?: CastOption['baseCost'] | string,
		extraManaCosts?: string[],
		faceIndex?: number,
		fused?: boolean,
		isFaceDown?: boolean
	) => boolean;
}

/**
 * Builds Track P6 `CastOption`s:
 * - `'exile:warp'` (`CR 702.185a`): normal printed-cost cast from exile on any turn after the turn it was exiled by Warp.
 * - `'alt:prototype'` (`CR 719.3`): inset prototype cast option whenever the player has zone permission to cast the card
 *   (from `'hand'`, `'command'`, or non-free `'exile'` including `'exile:warp'`).
 */
export function buildTrackP6CastOptions(params: BuildTrackP6CastOptionsParams): CastOption[] {
	const {
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
		buildPaymentAids,
		getSpellTargetRequirement,
		spellChoosesX
	} = params;

	const out: CastOption[] = [];
	const warpExileReady = fromZone === 'exile' && canCastWarpedFromExile(state, inst, actorId);

	for (const fi of candidateFaceIndices) {
		const faceDef = def.faces[fi];
		if (!faceDef) continue;
		const faceChars = faceDef.characteristics;
		const faceTypes = faceChars.types;
		const isLandOnlyFace = faceTypes.includes('Land') && !faceTypes.includes('Creature');
		if (isLandOnlyFace) continue;

		const faceName = faceDef.name;
		const faceManaCost = faceChars.manaCost;
		const isAdventureFace = isMultiFace && layout === 'adventure' && fi === 1;
		const faceIndexProp = isMultiFace ? { faceIndex: fi } : {};
		const idFor = (baseId: string) => (fi === 0 ? baseId : `face:${fi}:${baseId}`);
		const adventureMods: Partial<SpellModifications> = isAdventureFace
			? { exileAdventureOnResolve: true }
			: {};

		const additional = spellAdditionalCost(card, fi, false);
		const mandatoryAdditionalCosts =
			additional && additional.defs.length > 0 ? additional.defs : undefined;
		const paymentAids = buildPaymentAids(fromZone, fi, false, false);
		const paymentAidsProp = paymentAids ? { paymentAids } : {};
		const targetInfo = getSpellTargetRequirement(card, { faceIndex: fi } as CastOption);

		// CR 702.185a: Cast a warped card from exile after the turn it was exiled has ended.
		if (warpExileReady && inst.playableFromExileBy?.playerId !== actorId && !inst.castViaSuspend) {
			const optionalAdditionalCosts = spellOptionalAdditionalCosts(card, fi, false, false);
			const baseCost: CastOption['baseCost'] = { kind: 'printed' };
			const label = isAdventureFace
				? `Cast Adventure: ${faceName} from Exile (Warp)`
				: isMultiFace
					? `Cast ${faceName} from Exile (Warp)`
					: 'Cast from Exile (Warp)';
			out.push({
				id: idFor('exile:warp'),
				label,
				costDisplay: `${faceManaCost || '{0}'}${taxSuffix}`,
				fromZone: 'exile',
				permission: 'exile_permission',
				...faceIndexProp,
				baseCost,
				...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
				...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
				...paymentAidsProp,
				timing: 'default',
				spellMods: { ...adventureMods },
				choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
				requiresTarget: targetInfo.requiresTarget
			});
		}

		// CR 719.3 / 719.3a: Cast prototyped whenever casting from a permitted zone without another alt/free cost.
		const proto = getFacePrototypeSpec(faceDef);
		const canCastNormallyInZone =
			fromZone === 'hand' ||
			fromZone === 'command' ||
			(fromZone === 'exile' &&
				!inst.castViaSuspend &&
				((inst.playableFromExileBy?.playerId === actorId &&
					!inst.playableFromExileBy.withoutPayingManaCost) ||
					warpExileReady));
		if (proto && canCastNormallyInZone && !inst.castViaSuspend) {
			const optionalAdditionalCosts = spellOptionalAdditionalCosts(card, fi, false, true);
			const baseCost: CastOption['baseCost'] = {
				kind: 'alternative',
				manaCost: proto.manaCost
			};
			const ptBadge = `${proto.power}/${proto.toughness}`;
			const label = isMultiFace
				? `Cast Prototyped (${ptBadge}) — ${faceName}`
				: `Cast Prototyped (${ptBadge})`;
			out.push({
				id: idFor('alt:prototype'),
				label,
				costDisplay: `${proto.manaCost || '{0}'}${taxSuffix}`,
				fromZone,
				permission: fromZone === 'exile' ? 'exile_permission' : 'zone_default',
				...faceIndexProp,
				baseCost,
				...(mandatoryAdditionalCosts ? { mandatoryAdditionalCosts } : {}),
				...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
				...paymentAidsProp,
				timing: 'default',
				spellMods: {
					...adventureMods,
					prototyped: true,
					castSummarySuffix: ` (Prototyped ${ptBadge})`,
					label: `Prototyped ${ptBadge}`
				},
				choosesX: spellChoosesX(card, baseCost, undefined, fi, false),
				requiresTarget: targetInfo.requiresTarget
			});
		}
	}

	return out;
}
