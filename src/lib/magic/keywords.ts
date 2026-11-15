/**
 * Unified CR 702 keyword registry (ENGINE_ARCHITECTURE_PLAN.md section 2.12).
 *
 * Single source of truth for keyword recognition (`KNOWN_KEYWORDS`, `IMPLEMENTED_KEYWORDS`),
 * continuous/effect grantability (`STATIC_CONTINUOUS_KEYWORDS`, `GRANTABLE_KEYWORDS`),
 * display labels (`KEYWORD_LABELS`), alternative-cost cast options (`ALTERNATIVE_COST_KEYWORDS`),
 * and pure-IR keyword trigger/static expansions.
 *
 * Contains only structured IR builders and CR metadata — zero rules-text reads and zero
 * card-name comparisons.
 */
import type { ActivatedAbility, CostDef, EffectStep, EventKind, KeywordDef, ObjectFilter, Span, StaticDef } from './ir.ts';
import type { RuntimeTrigger } from './compiler/triggers.ts';
import {
	buildLevelUpActivatedAbility,
	buildOffspringTrigger,
	buildOptionalCostCastCopyTrigger,
	buildReinforceActivatedAbility,
	buildSquadTrigger,
	buildStationActivatedAbility,
	buildTransmuteActivatedAbility
} from './runtime/striatedFrames.ts';

export type KeywordParameterKind = 'none' | 'cost' | 'number' | 'quality' | 'cardName' | 'text';

/** Metadata describing an alternative-cost keyword ability (CR 118.9). */
export interface AlternativeCostKeywordMeta {
	id: string;
	label: string;
	castSummarySuffix: string;
	zones: Array<'hand' | 'command' | 'exile' | 'graveyard'>;
	/** True when casting from non-hand zones requires an existing zone permission (not granted by the keyword itself). */
	requiresZonePermission?: boolean;
	spellTypes?: Array<'Instant' | 'Sorcery'>;
	/** True when Land cards cannot be cast via this alternative cost (CR 702.138a: "cast this card from your graveyard" — lands can't be cast). */
	disallowLand?: boolean;
	targetsBecomeEach?: boolean;
	exileOnLeaveStack?: boolean;
	/** CR 702.74a: marks the cast spell / entering permanent as evoked. */
	evoked?: boolean;
	/** CR 702.138a–b: marks the cast spell / entering permanent as escaped. */
	escaped?: boolean;
	// --- Track P3 ---
	/** CR 702.152a: marks the cast spell / entering permanent as blitzed. */
	blitzed?: boolean;
	/** CR 702.146a–b / 712.8c: casts a double-faced card transformed with its back face up from graveyard (Disturb). */
	castTransformedBackFace?: boolean;
	// --- Track P6 ---
	/** CR 702.185a: marks the cast spell / entering permanent as warped from hand. */
	warped?: boolean;
	// --- Track P9 ---
	/** CR 702.109a: marks the cast spell / entering permanent as dashed. */
	dashed?: boolean;
	timing?: 'default' | 'instant_only' | 'sorcery_only';
	stackBadgeLabel?: string;
	/** CR 708: casting this card face down as a 2/2 colorless creature (Morph / Megamorph / Disguise). */
	faceDown?: {
		kind: 'morph' | 'megamorph' | 'disguise';
		castManaCost: string;
		wardCost?: string;
	};
}

export type KeywordImplementation =
	| { kind: 'primitive'; landwalkFilter?: ObjectFilter }
	| {
			kind: 'castOption';
			altCost?: AlternativeCostKeywordMeta;
			events?: readonly EventKind[];
			buildTriggers?: (kw: KeywordDef, abilityIndex: number, span: Span) => RuntimeTrigger[];
	  }
	| {
			kind: 'trigger';
			/** Event kinds this trigger listens to (used for Layer 6 granted-trigger fast paths). */
			events: readonly EventKind[];
			/** Builds RuntimeTrigger[] for a printed KeywordDef or a parameterless Layer 6 grant. */
			buildTriggers: (kw: KeywordDef, abilityIndex: number, span: Span) => RuntimeTrigger[];
	  }
	| { kind: 'static'; buildStatics: (kw: KeywordDef) => StaticDef[] }
	| {
			kind: 'activated';
			buildActivated?: (
				kw: KeywordDef,
				id: string,
				span: Span
			) => {
				ability: ActivatedAbility;
				costText: string;
				effectText: string;
				label: string;
			} | null;
	  };

const CYCLING_PREFIX_BY_KW: Record<string, string> = {
	cycling: 'Cycling',
	'basic landcycling': 'Basic landcycling',
	landcycling: 'Landcycling'
};

function cyclingHeadLabel(kw: KeywordDef): string {
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const kwName = kw.name;
	const prefix =
		CYCLING_PREFIX_BY_KW[kwName] ??
		(kw.cyclingDesc
			? `${kw.cyclingDesc.charAt(0).toUpperCase()}${kw.cyclingDesc.slice(1)}cycling`
			: 'Typecycling');
	if (!rawCost) return prefix;
	return isManaOnly ? `${prefix} ${rawCost}` : `${prefix}—${rawCost}`;
}

/**
 * Shared IR builder for Cycling (CR 702.29a) and Typecycling (CR 702.29e).
 * Used by both `ruleTree.ts` (`getCardActivatedAbilities`) and `compiler/index.ts` (`effectOf`).
 */
export function buildCyclingAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const discardSelf: CostDef = { k: 'discard', count: { k: 'const', n: 1 }, filter: 'self' };
	const cost: CostDef[] = [...costDefs, discardSelf];
	const costText = cyclingHeadLabel(kw);
	const kwName = kw.name;
	const isPlainCycling = kwName === 'cycling';

	let effect: EffectStep[];
	let effectText: string;
	if (isPlainCycling) {
		effect = [
			{
				verb: 'draw',
				subject: { k: 'playerRef', ref: { k: 'you' } },
				amount: { k: 'const', n: 1 },
				span
			}
		];
		effectText = 'Draw a card.';
	} else {
		const filter = kw.cyclingFilter;
		if (!filter) return null;
		const desc = kw.cyclingDesc ?? 'matching';
		effect = [
			{
				verb: 'search',
				subject: { k: 'none' },
				actor: { k: 'you' },
				amount: { k: 'const', n: 1 },
				params: {
					search: {
						filter,
						count: 1,
						upTo: true,
						statedQuality: true,
						reveal: true,
						destinations: [{ zone: 'hand' }],
						description: `a ${desc} card`
					}
				},
				span
			}
		];
		effectText = `Search your library for a ${desc} card, reveal it, put it into your hand, then shuffle.`;
	}

	const label = isPlainCycling
		? `${costText}: Draw a card`
		: `${costText}: Search for a ${kw.cyclingDesc ?? 'matching'} card`;

	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect,
			timing: 'instant',
			isMana: false,
			activationZones: ['hand'],
			costKeyword: 'cycling',
			id,
			text: `${costText}: ${effectText}`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.122a: "Crew N" means "Tap any number of other untapped creatures you control with total
 * power N or greater: This permanent becomes an artifact creature until end of turn."
 */
export function buildCrewAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const raw = kw.param?.trim();
	const n =
		kw.n !== undefined
			? kw.n
			: raw && /^\d+$/.test(raw)
				? Number(raw)
				: null;
	if (n === null || !Number.isInteger(n) || n < 0) return null;
	const cost: CostDef[] = [
		{
			k: 'tapSubsetSum',
			minTotal: { k: 'const', n },
			metric: 'power',
			filter: { controller: 'you', types: ['Creature'], tapped: false },
			excludeSelf: true,
			restrictionTag: 'crew'
		}
	];
	const effect: EffectStep[] = [
		{
			verb: 'animate',
			subject: { k: 'self' },
			params: { addTypes: ['Artifact', 'Creature'], duration: 'endOfTurn' },
			span
		}
	];
	const costText = `Tap untapped creatures with total power ${n} or more`;
	const effectText = 'This permanent becomes an artifact creature until end of turn.';
	const label = `Crew ${n}`;
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect,
			timing: 'instant',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'crew',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.84a: "Unearth [cost]" means "[Cost]: Return this card from your graveyard to the
 * battlefield. It gains haste. Exile it at the beginning of the next end step. If it would leave
 * the battlefield, exile it instead of putting it anywhere else. Activate only as a sorcery."
 */
export function buildUnearthAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const label = rawCost ? (isManaOnly ? `Unearth ${rawCost}` : `Unearth—${rawCost}`) : 'Unearth';
	const costText = label;
	const effectText =
		'Return this card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step or if it would leave the battlefield. Unearth only as a sorcery.';
	const effect: EffectStep[] = [
		{
			verb: 'move',
			subject: { k: 'self' },
			params: { from: 'graveyard', to: 'battlefield', underYourControl: true, unearth: true },
			span
		}
	];
	return {
		ability: {
			kind: 'activated',
			cost: costDefs,
			targets: [],
			effect,
			timing: 'sorcery',
			isMana: false,
			activationZones: ['graveyard'],
			costKeyword: 'unearth',
			id,
			text: `${costText}: ${effectText}`,
			span
		},
		costText,
		effectText,
		label
	};
}

// --- Track P3 ---
/**
 * CR 702.171a: "Saddle N" means "Tap any number of other untapped creatures you control with total
 * power N or greater: This permanent becomes saddled until end of turn. Activate only as a sorcery."
 */
export function buildSaddleAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const raw = kw.param?.trim();
	const n =
		kw.n !== undefined
			? kw.n
			: raw && /^\d+$/.test(raw)
				? Number(raw)
				: null;
	if (n === null || !Number.isInteger(n) || n < 0) return null;
	const cost: CostDef[] = [
		{
			k: 'tapSubsetSum',
			minTotal: { k: 'const', n },
			metric: 'power',
			filter: { controller: 'you', types: ['Creature'], other: true, tapped: false },
			excludeSelf: true,
			restrictionTag: 'saddle'
		}
	];
	const effect: EffectStep[] = [
		{
			verb: 'saddle',
			subject: { k: 'self' },
			span
		}
	];
	const costText = `Tap other untapped creatures with total power ${n} or more`;
	const effectText = 'This permanent becomes saddled until end of turn. Saddle only as a sorcery.';
	const label = `Saddle ${n}`;
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect,
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'saddle',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.24a: "Cumulative upkeep [cost]" means "At the beginning of your upkeep, if this permanent
 * is on the battlefield, put an age counter on this permanent. Then you may pay [cost] for each age
 * counter on it. If you don't, sacrifice it."
 */
export function buildCumulativeUpkeepTriggers(
	kw: KeywordDef,
	abilityIndex: number,
	span: Span
): RuntimeTrigger[] {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return [];
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const text = rawCost
		? isManaOnly
			? `Cumulative upkeep ${rawCost}`
			: `Cumulative upkeep—${rawCost}`
		: 'Cumulative upkeep';
	return [
		{
			abilityIndex,
			trigger: {
				event: 'phaseBegin',
				filter: { phase: 'upkeep' },
				scope: 'controller_turn'
			},
			effectSupported: true,
			text,
			effect: {
				steps: [
					{
						verb: 'putCounters',
						subject: { k: 'self' },
						amount: { k: 'const', n: 1 },
						params: { counter: 'age' },
						span
					},
					{
						verb: 'cumulativeUpkeep',
						subject: { k: 'self' },
						params: {
							cumulativeUpkeepCost: costDefs,
							cumulativeUpkeepText: rawCost
						},
						span
					}
				],
				targets: [],
				unparsed: []
			}
		}
	];
}

// --- Track P9 ---
/**
 * CR 702.30a: "Echo [cost]" means "At the beginning of your upkeep, if this permanent came under
 * your control since the beginning of your last upkeep, sacrifice it unless you pay [cost]."
 */
export function buildEchoTriggers(
	kw: KeywordDef,
	abilityIndex: number,
	span: Span
): RuntimeTrigger[] {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return [];
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const text = rawCost ? (isManaOnly ? `Echo ${rawCost}` : `Echo—${rawCost}`) : 'Echo';
	return [
		{
			abilityIndex,
			trigger: {
				event: 'phaseBegin',
				filter: { phase: 'upkeep' },
				scope: 'controller_turn'
			},
			condition: { k: 'cameUnderControlSinceLastUpkeep' },
			effectSupported: true,
			text,
			effect: {
				steps: [
					{
						verb: 'sacrifice',
						subject: { k: 'self' },
						optional: { chooser: { k: 'you' }, cost: costDefs, mode: 'doUnlessPaid' },
						span
					}
				],
				targets: [],
				unparsed: []
			}
		}
	];
}

/**
 * CR 702.49a / 702.49d: "Ninjutsu [cost]" / "Commander ninjutsu [cost]" means "[Cost], Reveal this
 * card from your hand [or command zone], Return an unblocked attacking creature you control to its
 * owner's hand: Put this card onto the battlefield from your hand [or command zone] tapped and
 * attacking."
 */
export function buildNinjutsuAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const { name: kwId } = kw;
	const isCommanderNinjutsu = kwId === 'commander ninjutsu';
	const prefix = isCommanderNinjutsu ? 'Commander ninjutsu' : 'Ninjutsu';
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const label = rawCost ? (isManaOnly ? `${prefix} ${rawCost}` : `${prefix}—${rawCost}`) : prefix;
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'revealFromHand', count: { k: 'const', n: 1 }, filter: 'self' },
		{
			k: 'returnToHand',
			count: { k: 'const', n: 1 },
			filter: {
				zone: 'battlefield',
				controller: 'you',
				types: ['Creature'],
				unblockedAttacker: true
			}
		}
	];
	const costText = `${label}, Return an unblocked attacking creature you control to its owner's hand`;
	const effectText = isCommanderNinjutsu
		? 'Put this card onto the battlefield from your hand or the command zone tapped and attacking.'
		: 'Put this card onto the battlefield from your hand tapped and attacking.';
	const effect: EffectStep[] = [
		{
			verb: 'move',
			subject: { k: 'self' },
			params: { to: 'battlefield', underYourControl: true, tapped: true },
			span
		}
	];
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect,
			timing: 'instant',
			isMana: false,
			activationZones: isCommanderNinjutsu ? ['hand', 'command'] : ['hand'],
			activationCondition: { k: 'ninjutsuWindow' },
			costKeyword: isCommanderNinjutsu ? 'commander ninjutsu' : 'ninjutsu',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.97a: "Scavenge [cost]" means "[Cost], Exile this card from your graveyard: Put a number
 * of +1/+1 counters equal to this card's power on target creature. Activate only as a sorcery."
 */
export function buildScavengeAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	const label = rawCost ? (isManaOnly ? `Scavenge ${rawCost}` : `Scavenge—${rawCost}`) : 'Scavenge';
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'exileFrom', zone: 'graveyard', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Exile this card from your graveyard`;
	const effectText =
		"Put a number of +1/+1 counters equal to this card's power on target creature. Scavenge only as a sorcery.";
	const effect: EffectStep[] = [
		{
			verb: 'putCounters',
			subject: { k: 'target', index: 0 },
			params: { counter: '+1/+1' },
			amount: { k: 'stat', of: { k: 'self' }, stat: 'power', lki: true },
			span
		}
	];
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [
				{
					kind: 'object',
					filter: { zone: 'battlefield', types: ['Creature'] },
					min: 1,
					max: 1
				}
			],
			effect,
			timing: 'sorcery',
			isMana: false,
			activationZones: ['graveyard'],
			costKeyword: 'scavenge',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

// --- Track P12 ---
function formatKeywordCostLabel(prefix: string, kw: KeywordDef): string {
	const rawCost = (kw.cost ?? kw.param ?? '').trim();
	if (!rawCost) return prefix;
	const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
	return isManaOnly ? `${prefix} ${rawCost}` : `${prefix}—${rawCost}`;
}

/**
 * CR 702.107a: "Outlast [cost]" means "[Cost], {T}: Put a +1/+1 counter on this creature. Activate only as a sorcery."
 */
export function buildOutlastAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Outlast', kw);
	const cost: CostDef[] = [...costDefs, { k: 'tapSelf' }];
	const costText = `${label}, {T}`;
	const effectText = 'Put a +1/+1 counter on this creature. Outlast only as a sorcery.';
	const effect: EffectStep[] = [
		{
			verb: 'putCounters',
			subject: { k: 'self' },
			params: { counter: '+1/+1' },
			amount: { k: 'const', n: 1 },
			span
		}
	];
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect,
			timing: 'sorcery',
			isMana: false,
			costKeyword: 'outlast',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.128a: "Embalm [cost]" means "[Cost], Exile this card from your graveyard: Create a token
 * that's a copy of it, except it's a white Zombie in addition to its other types with no mana cost.
 * Embalm only as a sorcery."
 */
export function buildEmbalmAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Embalm', kw);
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'exileFrom', zone: 'graveyard', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Exile this card from your graveyard`;
	const effectText =
		"Create a token that's a copy of this card, except it's a white Zombie in addition to its other types with no mana cost. Embalm only as a sorcery.";
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['graveyard'],
			costKeyword: 'embalm',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.129a: "Eternalize [cost]" means "[Cost], Exile this card from your graveyard: Create a
 * token that's a copy of it, except it's a 4/4 black Zombie creature in addition to its other types
 * with no mana cost. Eternalize only as a sorcery."
 */
export function buildEternalizeAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Eternalize', kw);
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'exileFrom', zone: 'graveyard', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Exile this card from your graveyard`;
	const effectText =
		"Create a token that's a copy of this card, except it's 4/4, it's a black Zombie creature in addition to its other types, and it has no mana cost. Eternalize only as a sorcery.";
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['graveyard'],
			costKeyword: 'eternalize',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.141a: "Encore [cost]" means "[Cost], Exile this card from your graveyard: For each
 * opponent, create a token that's a copy of this card that attacks that opponent this turn if able.
 * They gain haste. Sacrifice them at the beginning of the next end step. Activate only as a sorcery."
 */
export function buildEncoreAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Encore', kw);
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'exileFrom', zone: 'graveyard', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Exile this card from your graveyard`;
	const effectText =
		"For each opponent, create a token copy that attacks that opponent this turn if able. They gain haste. Sacrifice them at the beginning of the next end step. Activate only as a sorcery.";
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['graveyard'],
			costKeyword: 'encore',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}
// --- End Track P12 ---

// --- Track P15 ---
/**
 * CR 702.167a: "Craft with [materials] [cost]" means "[Cost], Exile this permanent, Exile
 * [materials] from among other permanents you control and/or cards in your graveyard: Return this
 * card to the battlefield transformed under its owner's control. Craft only as a sorcery."
 */
export function buildCraftAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const matDesc = kw.param ?? 'materials';
	const rawCost = (kw.cost ?? '').trim();
	const label = rawCost ? `Craft with ${matDesc} ${rawCost}` : `Craft with ${matDesc}`;
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'exileFrom', zone: 'battlefield', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Exile this permanent and ${matDesc}`;
	const effectText =
		"Return this card to the battlefield transformed under its owner's control. Craft only as a sorcery.";
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'craft',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.151a: "Reconfigure [cost]" defines "[Cost]: Attach this permanent to another target
 * creature you control. Activate only as a sorcery" and "[Cost]: Unattach this permanent. Activate
 * only if this permanent is attached to a creature and only as a sorcery."
 */
export function buildReconfigureAttachAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const prefix = formatKeywordCostLabel('Reconfigure', kw);
	const costText = prefix;
	const effectText =
		'Attach this permanent to another target creature you control. Activate only as a sorcery.';
	const label = `${prefix}: Attach to another target creature you control`;
	const targets = [
		{
			kind: 'object' as const,
			filter: { zone: 'battlefield' as const, types: ['Creature'], controller: 'you' as const, other: true },
			min: 1,
			max: 1
		}
	];
	const effect: EffectStep[] = [{ verb: 'attach', subject: { k: 'target', index: 0 }, span }];
	return {
		ability: {
			kind: 'activated',
			cost: costDefs,
			targets,
			effect,
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'reconfigure',
			id,
			text: `${costText}: ${effectText}`,
			span
		},
		costText,
		effectText,
		label
	};
}

export function buildReconfigureUnattachAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const prefix = formatKeywordCostLabel('Reconfigure', kw);
	const costText = prefix;
	const effectText =
		'Unattach this permanent. Activate only if this permanent is attached to a creature and only as a sorcery.';
	const label = `${prefix}: Unattach this permanent`;
	const unattachId = id.startsWith('reconfigure_')
		? id.replace(/^reconfigure_/, 'reconfigure_unattach_')
		: `reconfigure_unattach_${id}`;
	return {
		ability: {
			kind: 'activated',
			cost: costDefs,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'reconfigure',
			id: unattachId,
			text: `${costText}: ${effectText}`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.71a: "Transfigure [cost]" means "[Cost], Sacrifice this permanent: Search your library
 * for a creature card with the same mana value as this permanent, put it onto the battlefield,
 * then shuffle. Activate only as a sorcery."
 */
export function buildTransfigureAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Transfigure', kw);
	const cost: CostDef[] = [
		...costDefs,
		{ k: 'sacrifice', count: { k: 'const', n: 1 }, filter: 'self' }
	];
	const costText = `${label}, Sacrifice this permanent`;
	const effectText =
		'Search your library for a creature card with the same mana value as this permanent, put it onto the battlefield, then shuffle. Activate only as a sorcery.';
	return {
		ability: {
			kind: 'activated',
			cost,
			targets: [],
			effect: [],
			timing: 'sorcery',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'transfigure',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}

/**
 * CR 702.65a: "Aura swap [cost]" means "[Cost]: You may exchange this permanent with an Aura card
 * in your hand."
 */
export function buildAuraSwapAbility(
	kw: KeywordDef,
	id: string,
	span: Span
): { ability: ActivatedAbility; costText: string; effectText: string; label: string } | null {
	const costDefs = kw.costDefs;
	if (!costDefs || costDefs.length === 0) return null;
	const label = formatKeywordCostLabel('Aura swap', kw);
	const costText = label;
	const effectText = 'You may exchange this permanent with an Aura card in your hand.';
	return {
		ability: {
			kind: 'activated',
			cost: costDefs,
			targets: [],
			effect: [],
			timing: 'instant',
			isMana: false,
			activationZones: ['battlefield'],
			costKeyword: 'aura swap',
			id,
			text: `${label} (${costText}: ${effectText})`,
			span
		},
		costText,
		effectText,
		label
	};
}
// --- End Track P15 ---

export interface KeywordSpec {
	/** Canonical lower-case keyword name. */
	name: string;
	/** Comprehensive Rules section number (e.g. '702.91'). */
	cr: string;
	parameterKind: KeywordParameterKind;
	/** Display label for non-parameterized battlefield keyword badges. */
	displayLabel?: string;
	/** True when a continuous effect or "gains ..." clause can grant this keyword. */
	grantable: boolean;
	status: 'implemented' | 'unimplemented';
	implementation?: KeywordImplementation;
}

function simpleImplemented(
	name: string,
	cr: string,
	displayLabel: string,
	grantable = true
): [string, KeywordSpec] {
	return [
		name,
		{
			name,
			cr,
			parameterKind: 'none',
			displayLabel,
			grantable,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	];
}

function landwalkImplemented(
	name: string,
	displayLabel: string,
	landwalkFilter: ObjectFilter
): [string, KeywordSpec] {
	return [
		name,
		{
			name,
			cr: '702.14',
			parameterKind: 'none',
			displayLabel,
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive', landwalkFilter }
		}
	];
}

function unimplemented(
	name: string,
	cr: string,
	parameterKind: KeywordParameterKind = 'none'
): [string, KeywordSpec] {
	return [
		name,
		{
			name,
			cr,
			parameterKind,
			grantable: false,
			status: 'unimplemented'
		}
	];
}

function faceDownCostKeyword(
	name: string,
	cr: string,
	kind: 'morph' | 'megamorph' | 'disguise',
	label: string,
	wardCost?: string
): [string, KeywordSpec] {
	return [
		name,
		{
			name,
			cr,
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: `alt:${name}`,
					label,
					castSummarySuffix: ' (Face Down)',
					stackBadgeLabel: wardCost ? `Face Down (Ward ${wardCost})` : 'Face Down',
					zones: ['hand', 'command', 'exile'],
					requiresZonePermission: true,
					timing: 'default',
					faceDown: {
						kind,
						castManaCost: '{3}',
						...(wardCost ? { wardCost } : {})
					}
				}
			}
		}
	];
}

const REGISTRY_ENTRIES: Array<[string, KeywordSpec]> = [
	// ---- Implemented simple keywords (order preserves existing KEYWORD_LABELS / KEYWORD_ORDER) ----
	simpleImplemented('flying', '702.9', 'Flying'),
	simpleImplemented('first strike', '702.7', 'First strike'),
	simpleImplemented('double strike', '702.4', 'Double strike'),
	simpleImplemented('deathtouch', '702.2', 'Deathtouch'),
	simpleImplemented('defender', '702.3', 'Defender'),
	simpleImplemented('flash', '702.8', 'Flash'),
	simpleImplemented('haste', '702.10', 'Haste'),
	[
		'hexproof',
		{
			name: 'hexproof',
			cr: '702.11',
			parameterKind: 'quality',
			displayLabel: 'Hexproof',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	simpleImplemented('indestructible', '702.12', 'Indestructible'),
	simpleImplemented('infect', '702.90', 'Infect'),
	simpleImplemented('lifelink', '702.15', 'Lifelink'),
	simpleImplemented('menace', '702.111', 'Menace'),
	simpleImplemented('phasing', '702.26', 'Phasing'),
	simpleImplemented('reach', '702.17', 'Reach'),
	simpleImplemented('shroud', '702.18', 'Shroud'),
	simpleImplemented('trample', '702.19', 'Trample'),
	simpleImplemented('vigilance', '702.20', 'Vigilance'),
	simpleImplemented('changeling', '702.73', 'Changeling'),
	simpleImplemented('fear', '702.36', 'Fear'),
	simpleImplemented('intimidate', '702.13', 'Intimidate'),
	simpleImplemented('wither', '702.80', 'Wither'),
	simpleImplemented('horsemanship', '702.31', 'Horsemanship'),
	simpleImplemented('shadow', '702.28', 'Shadow'),
	// --- Track P8 ---
	simpleImplemented('skulk', '702.118', 'Skulk'),
	[
		'prowess',
		{
			name: 'prowess',
			cr: '702.108',
			parameterKind: 'none',
			displayLabel: 'Prowess',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'cast',
							filter: { object: { notTypes: ['Creature'] }, player: { relation: 'you' } }
						},
						effectSupported: true,
						text: 'Prowess',
						effect: {
							steps: [
								{
									verb: 'pump',
									subject: { k: 'self' },
									amount: { k: 'const', n: 1 },
									params: { toughness: { k: 'const', n: 1 }, duration: 'endOfTurn' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],

	// ---- Implemented parameterized, cast-option, & pure-IR keywords ----
	[
		'enchant',
		{
			name: 'enchant',
			cr: '702.5',
			parameterKind: 'quality',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	[
		'equip',
		{
			name: 'equip',
			cr: '702.6',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated' }
		}
	],
	[
		'protection',
		{
			name: 'protection',
			cr: '702.16',
			parameterKind: 'quality',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	[
		'ward',
		{
			name: 'ward',
			cr: '702.21',
			parameterKind: 'cost',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['becomesTarget'],
				buildTriggers: (kw, abilityIndex) => {
					const cost = kw.cost ?? kw.param ?? '{1}';
					return [
						{
							abilityIndex,
							trigger: {
								event: 'becomesTarget',
								filter: { object: 'self', targetedBy: 'spellOrAbility', player: { relation: 'opponent' } }
							},
							effectSupported: true,
							text: `Ward ${cost}`,
							ward: { cost, costDefs: kw.costDefs }
						}
					];
				}
			}
		}
	],
	[
		'flashback',
		{
			name: 'flashback',
			cr: '702.34',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:flashback',
					label: 'Cast with Flashback',
					castSummarySuffix: ' (Flashback)',
					stackBadgeLabel: 'Flashback',
					zones: ['graveyard'],
					requiresZonePermission: false,
					spellTypes: ['Instant', 'Sorcery'],
					exileOnLeaveStack: true,
					timing: 'default'
				}
			}
		}
	],
	[
		'fuse',
		{
			name: 'fuse',
			cr: '702.102',
			parameterKind: 'none',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'kicker',
		{
			name: 'kicker',
			cr: '702.33',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'multikicker',
		{
			name: 'multikicker',
			cr: '702.33c',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'overload',
		{
			name: 'overload',
			cr: '702.96',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:overload',
					label: 'Cast with Overload',
					castSummarySuffix: ' (Overloaded)',
					zones: ['hand', 'command', 'exile'],
					requiresZonePermission: true,
					targetsBecomeEach: true,
					timing: 'default',
					stackBadgeLabel: 'Overloaded (each matching object)'
				}
			}
		}
	],
	[
		'suspend',
		{
			name: 'suspend',
			cr: '702.62',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'partner',
		{
			name: 'partner',
			cr: '702.124',
			parameterKind: 'cardName',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],

	// ---- Track B3 Slice 1: 7 pure-IR keywords ----
	[
		'battle cry',
		{
			name: 'battle cry',
			cr: '702.91',
			parameterKind: 'none',
			displayLabel: 'Battle cry',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Battle cry',
						effect: {
							steps: [
								{
									verb: 'pump',
									subject: { k: 'all', filter: { types: ['Creature'], attacking: true, other: true } },
									amount: { k: 'const', n: 1 },
									params: { toughness: { k: 'const', n: 0 }, duration: 'endOfTurn' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'afterlife',
		{
			name: 'afterlife',
			cr: '702.135',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: { event: 'zoneChange', filter: { object: 'self', from: 'battlefield', to: 'graveyard' } },
							effectSupported: true,
							text: `Afterlife ${n}`,
							effect: {
								steps: [
									{
										verb: 'createToken',
										subject: { k: 'none' },
										amount: { k: 'const', n },
										params: {
											token: {
												name: 'Spirit Token',
												power: 1,
												toughness: 1,
												colors: ['W', 'B'],
												typeLine: 'Token Creature — Spirit',
												keywords: ['Flying']
											}
										},
										span
									}
								],
								targets: [],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	[
		'bushido',
		{
			name: 'bushido',
			cr: '702.45',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['blocks', 'becomesBlocked'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'blocks',
								filter: { object: 'self' },
								or: [{ event: 'becomesBlocked', filter: { object: 'self' } }]
							},
							effectSupported: true,
							text: `Bushido ${n}`,
							effect: {
								steps: [
									{
										verb: 'pump',
										subject: { k: 'self' },
										amount: { k: 'const', n },
										params: { toughness: { k: 'const', n }, duration: 'endOfTurn' },
										span
									}
								],
								targets: [],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	[
		'living weapon',
		{
			name: 'living weapon',
			cr: '702.92',
			parameterKind: 'none',
			displayLabel: 'Living weapon',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						effectSupported: true,
						text: 'Living weapon',
						effect: {
							steps: [
								{
									verb: 'createToken',
									subject: { k: 'none' },
									amount: { k: 'const', n: 1 },
									bindAs: 'germ',
									params: {
										token: {
											name: 'Phyrexian Germ Token',
											power: 0,
											toughness: 0,
											colors: ['B'],
											typeLine: 'Token Creature — Phyrexian Germ',
											keywords: []
										}
									},
									span
								},
								{
									verb: 'attach',
									subject: { k: 'binding', name: 'germ' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'for mirrodin!',
		{
			name: 'for mirrodin!',
			cr: '702.163',
			parameterKind: 'none',
			displayLabel: 'For Mirrodin!',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						effectSupported: true,
						text: 'For Mirrodin!',
						effect: {
							steps: [
								{
									verb: 'createToken',
									subject: { k: 'none' },
									amount: { k: 'const', n: 1 },
									bindAs: 'rebel',
									params: {
										token: {
											name: 'Rebel Token',
											power: 2,
											toughness: 2,
											colors: ['R'],
											typeLine: 'Token Creature — Rebel',
											keywords: []
										}
									},
									span
								},
								{
									verb: 'attach',
									subject: { k: 'binding', name: 'rebel' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'affinity',
		{
			name: 'affinity',
			cr: '702.41',
			parameterKind: 'quality',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'static',
				buildStatics: (kw) =>
					kw.affinityFilter
						? [
								{
									k: 'costModifier',
									affects: { k: 'self' },
									delta: {
										mode: 'reduce',
										generic: 1,
										times: {
											k: 'count',
											of: { ...kw.affinityFilter, controller: 'you', zone: 'battlefield' }
										}
									},
									who: { relation: 'you' }
								}
							]
						: []
			}
		}
	],
	[
		'exploit',
		{
			name: 'exploit',
			cr: '702.110',
			parameterKind: 'none',
			displayLabel: 'Exploit',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						effectSupported: true,
						text: 'Exploit',
						effect: {
							steps: [
								{
									verb: 'sacrifice',
									subject: { k: 'all', filter: { types: ['Creature'], controller: 'you' } },
									amount: { k: 'const', n: 1 },
									optional: { chooser: { k: 'you' } },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],

	// ---- Track B3 Slice 2: Exalted, Annihilator N, Landwalk variants ----
	[
		'exalted',
		{
			name: 'exalted',
			cr: '702.83',
			parameterKind: 'none',
			displayLabel: 'Exalted',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'attacks',
							filter: { alone: true, object: { types: ['Creature'], controller: 'you' } }
						},
						effectSupported: true,
						text: 'Exalted',
						effect: {
							steps: [
								{
									verb: 'pump',
									subject: { k: 'eventObject' },
									amount: { k: 'const', n: 1 },
									params: { toughness: { k: 'const', n: 1 }, duration: 'endOfTurn' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'annihilator',
		{
			name: 'annihilator',
			cr: '702.86',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: { event: 'attacks', filter: { object: 'self' } },
							effectSupported: true,
							text: `Annihilator ${n}`,
							effect: {
								steps: [
									{
										verb: 'sacrifice',
										subject: { k: 'all', filter: {} },
										actor: { k: 'defendingPlayer' },
										amount: { k: 'const', n },
										span
									}
								],
								targets: [],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	landwalkImplemented('landwalk', 'Landwalk', { types: ['Land'] }),
	landwalkImplemented('plainswalk', 'Plainswalk', { types: ['Land'], subtypes: ['Plains'] }),
	landwalkImplemented('islandwalk', 'Islandwalk', { types: ['Land'], subtypes: ['Island'] }),
	landwalkImplemented('swampwalk', 'Swampwalk', { types: ['Land'], subtypes: ['Swamp'] }),
	landwalkImplemented('mountainwalk', 'Mountainwalk', { types: ['Land'], subtypes: ['Mountain'] }),
	landwalkImplemented('forestwalk', 'Forestwalk', { types: ['Land'], subtypes: ['Forest'] }),
	landwalkImplemented('nonbasic landwalk', 'Nonbasic landwalk', { types: ['Land'], notSupertypes: ['Basic'] }),
	// --- Track P15 ---
	landwalkImplemented('snow landwalk', 'Snow landwalk', { types: ['Land'], supertypes: ['Snow'] }),
	landwalkImplemented('snow plainswalk', 'Snow plainswalk', {
		types: ['Land'],
		supertypes: ['Snow'],
		subtypes: ['Plains']
	}),
	landwalkImplemented('snow islandwalk', 'Snow islandwalk', {
		types: ['Land'],
		supertypes: ['Snow'],
		subtypes: ['Island']
	}),
	landwalkImplemented('snow swampwalk', 'Snow swampwalk', {
		types: ['Land'],
		supertypes: ['Snow'],
		subtypes: ['Swamp']
	}),
	landwalkImplemented('snow mountainwalk', 'Snow mountainwalk', {
		types: ['Land'],
		supertypes: ['Snow'],
		subtypes: ['Mountain']
	}),
	landwalkImplemented('snow forestwalk', 'Snow forestwalk', {
		types: ['Land'],
		supertypes: ['Snow'],
		subtypes: ['Forest']
	}),
	landwalkImplemented('legendary landwalk', 'Legendary landwalk', {
		types: ['Land'],
		supertypes: ['Legendary']
	}),
	landwalkImplemented('artifact landwalk', 'Artifact landwalk', { allTypes: ['Artifact', 'Land'] }),
	// --- End Track P15 ---

	// ---- Unimplemented CR 702 keywords recognized on keyword lines ----
	unimplemented('absorb', '702.64', 'number'),
	// --- Track P12 ---
	[
		'aftermath',
		{
			name: 'aftermath',
			cr: '702.127',
			parameterKind: 'none',
			displayLabel: 'Aftermath',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'afflict',
		{
			name: 'afflict',
			cr: '702.130',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['becomesBlocked'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: { event: 'becomesBlocked', filter: { object: 'self' } },
							effectSupported: true,
							text: `Afflict ${n}`,
							effect: {
								steps: [
									{
										verb: 'loseLife',
										subject: { k: 'playerRef', ref: { k: 'defendingPlayer' } },
										amount: { k: 'const', n },
										span
									}
								],
								targets: [],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'amplify',
		{
			name: 'amplify',
			cr: '702.38',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	[
		'ascend',
		{
			name: 'ascend',
			cr: '702.131',
			parameterKind: 'none',
			displayLabel: 'Ascend',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	[
		'assist',
		{
			name: 'assist',
			cr: '702.132',
			parameterKind: 'none',
			displayLabel: 'Assist',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'aura swap',
		{
			name: 'aura swap',
			cr: '702.65',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildAuraSwapAbility }
		}
	],
	[
		'choose a background',
		{
			name: 'choose a background',
			cr: '702.124k',
			parameterKind: 'none',
			displayLabel: 'Choose a Background',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'awaken',
		{
			name: 'awaken',
			cr: '702.113',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'backup',
		{
			name: 'backup',
			cr: '702.165',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
							effectSupported: true,
							text: `Backup ${n}`,
							effect: {
								steps: [],
								targets: [
									{
										kind: 'object',
										filter: { zone: 'battlefield', types: ['Creature'] },
										min: 1,
										max: 1
									}
								],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	unimplemented('banding', '702.22'),
	// --- Track P12 ---
	[
		'bargain',
		{
			name: 'bargain',
			cr: '702.166',
			parameterKind: 'none',
			displayLabel: 'Bargain',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'beam me up',
		{
			name: 'beam me up',
			cr: '702.196',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'bestow',
		{
			name: 'bestow',
			cr: '702.103',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P12 ---
	// --- Track P3 ---
	[
		'blitz',
		{
			name: 'blitz',
			cr: '702.152',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:blitz',
					label: 'Cast with Blitz',
					castSummarySuffix: ' (Blitz)',
					zones: ['hand', 'command', 'exile'],
					requiresZonePermission: true,
					blitzed: true,
					stackBadgeLabel: 'Blitz'
				},
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'zoneChange',
							filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
						},
						condition: { k: 'blitzed' },
						effectSupported: true,
						text: 'Blitz',
						effect: {
							steps: [
								{
									verb: 'draw',
									subject: { k: 'playerRef', ref: { k: 'you' } },
									amount: { k: 'const', n: 1 },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- Track P9 ---
	[
		'bloodthirst',
		{
			name: 'bloodthirst',
			cr: '702.54',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	unimplemented('boast', '702.142', 'text'),
	[
		'buyback',
		{
			name: 'buyback',
			cr: '702.27',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- Track P9 ---
	[
		'cascade',
		{
			name: 'cascade',
			cr: '702.85',
			parameterKind: 'none',
			displayLabel: 'Cascade',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: {
							event: 'cast',
							fromZone: 'stack',
							filter: { object: 'self' }
						},
						effectSupported: true,
						text: 'Cascade',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	// --- Track P6 ---
	[
		'casualty',
		{
			name: 'casualty',
			cr: '702.153',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => {
					const t = buildOptionalCostCastCopyTrigger('casualty', false, span);
					return [
						{
							abilityIndex,
							trigger: t.trigger,
							condition: t.condition,
							effectSupported: true,
							text: 'Casualty',
							effect: { steps: t.effect, targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- Track P12 ---
	[
		'champion',
		{
			name: 'champion',
			cr: '702.72',
			parameterKind: 'quality',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const desc = kw.param ?? 'a creature';
					return [
						{
							abilityIndex,
							trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
							effectSupported: true,
							text: `Champion ${desc} (ETB)`,
							effect: { steps: [], targets: [], unparsed: [] }
						},
						{
							abilityIndex,
							trigger: { event: 'zoneChange', filter: { object: 'self', from: 'battlefield' } },
							effectSupported: true,
							text: `Champion ${desc} (LTB)`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'cipher',
		{
			name: 'cipher',
			cr: '702.99',
			parameterKind: 'none',
			displayLabel: 'Cipher',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'cleave',
		{
			name: 'cleave',
			cr: '702.148',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P15 ---
	unimplemented('companion', '702.139', 'text'),
	// --- Track P9 ---
	[
		'commander ninjutsu',
		{
			name: 'commander ninjutsu',
			cr: '702.49d',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildNinjutsuAbility }
		}
	],
	// --- Track P15 ---
	[
		'compleated',
		{
			name: 'compleated',
			cr: '702.150',
			parameterKind: 'none',
			displayLabel: 'Compleated',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P6 ---
	[
		'conspire',
		{
			name: 'conspire',
			cr: '702.78',
			parameterKind: 'none',
			displayLabel: 'Conspire',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => {
					const t = buildOptionalCostCastCopyTrigger('conspire', false, span);
					return [
						{
							abilityIndex,
							trigger: t.trigger,
							condition: t.condition,
							effectSupported: true,
							text: 'Conspire',
							effect: { steps: t.effect, targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	[
		'convoke',
		{
			name: 'convoke',
			cr: '702.51',
			parameterKind: 'none',
			displayLabel: 'Convoke',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P15 ---
	[
		'craft',
		{
			name: 'craft',
			cr: '702.167',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCraftAbility }
		}
	],
	// --- End Track P15 ---
	[
		'crew',
		{
			name: 'crew',
			cr: '702.122',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCrewAbility }
		}
	],
	// --- Track P3 ---
	[
		'cumulative upkeep',
		{
			name: 'cumulative upkeep',
			cr: '702.24',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['phaseBegin'],
				buildTriggers: buildCumulativeUpkeepTriggers
			}
		}
	],
	[
		'cycling',
		{
			name: 'cycling',
			cr: '702.29',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCyclingAbility }
		}
	],
	// --- Track P9 ---
	[
		'dash',
		{
			name: 'dash',
			cr: '702.109',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:dash',
					label: 'Cast with Dash',
					castSummarySuffix: ' (Dashed)',
					zones: ['hand', 'command', 'exile'],
					requiresZonePermission: true,
					disallowLand: true,
					dashed: true,
					stackBadgeLabel: 'Dashed'
				}
			}
		}
	],
	// --- Track P15 ---
	[
		'daybound',
		{
			name: 'daybound',
			cr: '702.145',
			parameterKind: 'none',
			displayLabel: 'Daybound',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'decayed',
		{
			name: 'decayed',
			cr: '702.147',
			parameterKind: 'none',
			displayLabel: 'Decayed',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Decayed',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	[
		'delve',
		{
			name: 'delve',
			cr: '702.66',
			parameterKind: 'none',
			displayLabel: 'Delve',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P15 ---
	[
		'demonstrate',
		{
			name: 'demonstrate',
			cr: '702.144',
			parameterKind: 'none',
			displayLabel: 'Demonstrate',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	[
		"doctor's companion",
		{
			name: "doctor's companion",
			cr: '702.124m',
			parameterKind: 'none',
			displayLabel: "Doctor's companion",
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'dethrone',
		{
			name: 'dethrone',
			cr: '702.105',
			parameterKind: 'none',
			displayLabel: 'Dethrone',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self', dethroneMostLife: true } },
						effectSupported: true,
						text: 'Dethrone',
						effect: {
							steps: [
								{
									verb: 'putCounters',
									subject: { k: 'self' },
									amount: { k: 'const', n: 1 },
									params: { counter: '+1/+1' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	[
		'devoid',
		{
			name: 'devoid',
			cr: '702.114',
			parameterKind: 'none',
			grantable: false,
			displayLabel: 'Devoid',
			status: 'implemented',
			implementation: {
				kind: 'static',
				buildStatics: () => [
					{
						k: 'continuous',
						layer: '5',
						affected: 'self',
						mod: { k: 'setColors', colors: [] }
					}
				]
			}
		}
	],
	// --- Track P12 ---
	[
		'devour',
		{
			name: 'devour',
			cr: '702.82',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P12 ---
	faceDownCostKeyword('disguise', '702.168', 'disguise', 'Cast face down (Disguise)', '{2}'),
	// --- Track P3 ---
	[
		'disturb',
		{
			name: 'disturb',
			cr: '702.146',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:disturb',
					label: 'Cast with Disturb',
					castSummarySuffix: ' (Disturb)',
					zones: ['graveyard'],
					requiresZonePermission: false,
					disallowLand: true,
					castTransformedBackFace: true,
					stackBadgeLabel: 'Disturb'
				}
			}
		}
	],
	unimplemented('double team', '702.156'),
	// --- Track P12 ---
	[
		'dredge',
		{
			name: 'dredge',
			cr: '702.52',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P12 ---
	// --- Track P9 ---
	[
		'echo',
		{
			name: 'echo',
			cr: '702.30',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['phaseBegin'],
				buildTriggers: buildEchoTriggers
			}
		}
	],
	// --- Track P12 ---
	[
		'embalm',
		{
			name: 'embalm',
			cr: '702.128',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildEmbalmAbility }
		}
	],
	[
		'emerge',
		{
			name: 'emerge',
			cr: '702.119',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'encore',
		{
			name: 'encore',
			cr: '702.141',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildEncoreAbility }
		}
	],
	[
		'enlist',
		{
			name: 'enlist',
			cr: '702.154',
			parameterKind: 'none',
			displayLabel: 'Enlist',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Enlist',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P3 ---
	[
		'entwine',
		{
			name: 'entwine',
			cr: '702.42',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	unimplemented('epic', '702.50'),
	// --- Track P12 ---
	[
		'escalate',
		{
			name: 'escalate',
			cr: '702.120',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P12 ---
	[
		'escape',
		{
			name: 'escape',
			cr: '702.138',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:escape',
					label: 'Escape from Graveyard',
					castSummarySuffix: ' (Escaped)',
					zones: ['graveyard'],
					requiresZonePermission: false,
					disallowLand: true,
					escaped: true,
					stackBadgeLabel: 'Escaped'
				}
			}
		}
	],
	// --- Track P12 ---
	[
		'eternalize',
		{
			name: 'eternalize',
			cr: '702.129',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildEternalizeAbility }
		}
	],
	// --- End Track P12 ---
	[
		'evoke',
		{
			name: 'evoke',
			cr: '702.74',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:evoke',
					label: 'Cast with Evoke',
					castSummarySuffix: ' (Evoke)',
					zones: ['hand', 'command', 'exile'],
					requiresZonePermission: true,
					evoked: true,
					stackBadgeLabel: 'Evoke'
				},
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						condition: { k: 'evoked' },
						effectSupported: true,
						text: 'Evoke',
						effect: {
							steps: [{ verb: 'sacrifice', subject: { k: 'self' }, span }],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'evolve',
		{
			name: 'evolve',
			cr: '702.100',
			parameterKind: 'none',
			displayLabel: 'Evolve',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'zoneChange',
							filter: {
								object: { types: ['Creature'], controller: 'you', other: true },
								to: 'battlefield'
							}
						},
						condition: { k: 'evolveCompare' },
						effectSupported: true,
						text: 'Evolve',
						effect: {
							steps: [
								{
									verb: 'putCounters',
									subject: { k: 'self' },
									amount: { k: 'const', n: 1 },
									params: { counter: '+1/+1' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- Track P9 ---
	[
		'extort',
		{
			name: 'extort',
			cr: '702.101',
			parameterKind: 'none',
			displayLabel: 'Extort',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: {
							event: 'cast',
							filter: { player: { relation: 'you' } }
						},
						effectSupported: true,
						text: 'Extort',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	[
		'fabricate',
		{
			name: 'fabricate',
			cr: '702.123',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
							effectSupported: true,
							text: `Fabricate ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- Track P6 ---
	[
		'fading',
		{
			name: 'fading',
			cr: '702.32',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P9 ---
	[
		'flanking',
		{
			name: 'flanking',
			cr: '702.25',
			parameterKind: 'none',
			displayLabel: 'Flanking',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['becomesBlockedBy'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'becomesBlockedBy',
							filter: { object: 'self', withoutFlanking: true }
						},
						effectSupported: true,
						text: 'Flanking',
						effect: {
							steps: [
								{
									verb: 'pump',
									subject: { k: 'eventObject' },
									amount: { k: 'const', n: -1 },
									params: { toughness: { k: 'const', n: -1 }, duration: 'endOfTurn' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	unimplemented('forecast', '702.57', 'text'),
	// --- Track P3 ---
	[
		'foretell',
		{
			name: 'foretell',
			cr: '702.143',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	unimplemented('fortify', '702.67', 'cost'),
	unimplemented('frenzy', '702.68', 'number'),
	// --- Track P15 ---
	[
		'freerunning',
		{
			name: 'freerunning',
			cr: '702.173',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'friends forever',
		{
			name: 'friends forever',
			cr: '702.124j',
			parameterKind: 'none',
			displayLabel: 'Friends forever',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	[
		'gift',
		{
			name: 'gift',
			cr: '702.174',
			parameterKind: 'quality',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'graft',
		{
			name: 'graft',
			cr: '702.58',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'zoneChange',
								filter: { to: 'battlefield', object: { types: ['Creature'], other: true } }
							},
							condition: {
								k: 'compare',
								left: { k: 'countersOn', counter: '+1/+1', of: { k: 'self' } },
								op: '>=',
								right: { k: 'const', n: 1 }
							},
							effectSupported: true,
							text: `Graft ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'gravestorm',
		{
			name: 'gravestorm',
			cr: '702.69',
			parameterKind: 'none',
			displayLabel: 'Gravestorm',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'cast', filter: { object: 'self', player: { relation: 'you' } } },
						effectSupported: true,
						text: 'Gravestorm',
						effect: {
							steps: [
								{
									verb: 'copySpell',
									subject: { k: 'self' },
									params: { count: { k: 'gravestormCount' }, mayChooseNewTargets: true },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- End Track P15 ---
	unimplemented('haunt', '702.55'),
	unimplemented('hidden agenda', '702.106'),
	unimplemented('hideaway', '702.75', 'number'),
	// --- Track P9 ---
	[
		'improvise',
		{
			name: 'improvise',
			cr: '702.126',
			parameterKind: 'none',
			displayLabel: 'Improvise',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P15 ---
	[
		'impending',
		{
			name: 'impending',
			cr: '702.176',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['phaseBegin'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.impendingN ?? kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'phaseBegin',
								filter: { phase: 'end_step' },
								scope: 'controller_turn'
							},
							condition: { k: 'isImpending' },
							effectSupported: true,
							text: `Impending ${n}`,
							effect: {
								steps: [
									{
										verb: 'removeCounters',
										subject: { k: 'self' },
										amount: { k: 'const', n: 1 },
										params: { counter: 'time' },
										span
									}
								],
								targets: [],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	[
		'increment',
		{
			name: 'increment',
			cr: '702.191',
			parameterKind: 'none',
			displayLabel: 'Increment',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'ingest',
		{
			name: 'ingest',
			cr: '702.115',
			parameterKind: 'none',
			displayLabel: 'Ingest',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['dealsDamage'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'dealsDamage',
							filter: { object: 'self', combat: true, damageTo: 'player' }
						},
						effectSupported: true,
						text: 'Ingest',
						effect: {
							steps: [
								{
									verb: 'exile',
									subject: { k: 'libraryTop', player: { k: 'eventPlayer' } },
									amount: { k: 'const', n: 1 },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P3 ---
	[
		'jump-start',
		{
			name: 'jump-start',
			cr: '702.133',
			parameterKind: 'none',
			displayLabel: 'Jump-start',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'basic landcycling',
		{
			name: 'basic landcycling',
			cr: '702.29e',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCyclingAbility }
		}
	],
	[
		'landcycling',
		{
			name: 'landcycling',
			cr: '702.29e',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCyclingAbility }
		}
	],
	[
		'typecycling',
		{
			name: 'typecycling',
			cr: '702.29e',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildCyclingAbility }
		}
	],
	// --- Track P6 ---
	[
		'level up',
		{
			name: 'level up',
			cr: '702.87',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildLevelUpActivatedAbility }
		}
	],
	// --- Track P15 ---
	[
		'living metal',
		{
			name: 'living metal',
			cr: '702.161',
			parameterKind: 'none',
			displayLabel: 'Living metal',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'static',
				buildStatics: () => [
					{
						k: 'continuous',
						layer: '4',
						affected: 'self',
						condition: { k: 'isTurnOf', player: { k: 'you' } },
						mod: { k: 'addTypes', types: ['Artifact', 'Creature'] }
					}
				]
			}
		}
	],
	// --- End Track P15 ---
	// --- Track P9 ---
	[
		'madness',
		{
			name: 'madness',
			cr: '702.35',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['discard'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const rawCost = (kw.cost ?? kw.param ?? '').trim();
					const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
					const text = rawCost ? (isManaOnly ? `Madness ${rawCost}` : `Madness—${rawCost}`) : 'Madness';
					return [
						{
							abilityIndex,
							trigger: {
								event: 'discard',
								fromZone: 'any',
								filter: { object: 'self', madnessExiled: true }
							},
							effectSupported: true,
							text,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	faceDownCostKeyword('megamorph', '702.37b', 'megamorph', 'Cast face down (Megamorph)'),
	// --- Track P12 ---
	[
		'mayhem',
		{
			name: 'mayhem',
			cr: '702.187',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'melee',
		{
			name: 'melee',
			cr: '702.121',
			parameterKind: 'none',
			displayLabel: 'Melee',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Melee',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	[
		'mentor',
		{
			name: 'mentor',
			cr: '702.134',
			parameterKind: 'none',
			displayLabel: 'Mentor',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Mentor',
						effect: {
							steps: [
								{
									verb: 'putCounters',
									subject: { k: 'target', index: 0 },
									amount: { k: 'const', n: 1 },
									params: { counter: '+1/+1' },
									span
								}
							],
							targets: [
								{
									kind: 'object',
									filter: {
										zone: 'battlefield',
										types: ['Creature'],
										attacking: true,
										other: true,
										powerLessThanSource: true
									},
									min: 1,
									max: 1
								}
							],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'miracle',
		{
			name: 'miracle',
			cr: '702.94',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P12 ---
	// --- Track P9 ---
	[
		'modular',
		{
			name: 'modular',
			cr: '702.43',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'zoneChange',
								filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
							},
							effectSupported: true,
							text: `Modular ${n}`,
							effect: {
								steps: [
									{
										verb: 'putCounters',
										subject: { k: 'target', index: 0 },
										params: { counter: '+1/+1' },
										amount: { k: 'lkiCounterCount', counter: '+1/+1' },
										optional: { chooser: { k: 'you' } },
										span
									}
								],
								targets: [
									{
										kind: 'object',
										filter: { zone: 'battlefield', allTypes: ['Artifact', 'Creature'] },
										min: 1,
										max: 1
									}
								],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	faceDownCostKeyword('morph', '702.37', 'morph', 'Cast face down (Morph)'),
	// --- Track P15 ---
	[
		'more than meets the eye',
		{
			name: 'more than meets the eye',
			cr: '702.162',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P15 ---
	unimplemented('mutate', '702.140', 'cost'),
	// --- Track P12 ---
	[
		'myriad',
		{
			name: 'myriad',
			cr: '702.116',
			parameterKind: 'none',
			displayLabel: 'Myriad',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, _span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self' } },
						effectSupported: true,
						text: 'Myriad',
						effect: { steps: [], targets: [], unparsed: [] }
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'nightbound',
		{
			name: 'nightbound',
			cr: '702.145',
			parameterKind: 'none',
			displayLabel: 'Nightbound',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P9 ---
	[
		'ninjutsu',
		{
			name: 'ninjutsu',
			cr: '702.49',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildNinjutsuAbility }
		}
	],
	unimplemented('offering', '702.48', 'quality'),
	// --- Track P6 ---
	[
		'offspring',
		{
			name: 'offspring',
			cr: '702.175',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => {
					const t = buildOffspringTrigger(span);
					return [
						{
							abilityIndex,
							trigger: t.trigger,
							condition: t.condition,
							effectSupported: true,
							text: 'Offspring',
							effect: { steps: t.effect, targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- Track P12 ---
	[
		'outlast',
		{
			name: 'outlast',
			cr: '702.107',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildOutlastAbility }
		}
	],
	// --- End Track P12 ---
	// --- Track P9 ---
	[
		'persist',
		{
			name: 'persist',
			cr: '702.79',
			parameterKind: 'none',
			displayLabel: 'Persist',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'zoneChange',
							filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
						},
						condition: { k: 'lkiHasNoCounter', counter: '-1/-1' },
						effectSupported: true,
						text: 'Persist',
						effect: {
							steps: [
								{
									verb: 'move',
									subject: { k: 'self' },
									params: {
										from: 'graveyard',
										to: 'battlefield',
										withCounters: { counter: '-1/-1', count: 1 }
									},
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- Track P3 ---
	[
		'plot',
		{
			name: 'plot',
			cr: '702.170',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	unimplemented('poisonous', '702.70', 'number'),
	// --- Track P15 ---
	[
		'paradigm',
		{
			name: 'paradigm',
			cr: '702.192',
			parameterKind: 'none',
			displayLabel: 'Paradigm',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'power-up',
		{
			name: 'power-up',
			cr: '702.193',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P6 ---
	[
		'prototype',
		{
			name: 'prototype',
			cr: '702.160',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- Track P15 ---
	[
		'provoke',
		{
			name: 'provoke',
			cr: '702.39',
			parameterKind: 'none',
			displayLabel: 'Provoke',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	[
		'prowl',
		{
			name: 'prowl',
			cr: '702.76',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'rampage',
		{
			name: 'rampage',
			cr: '702.23',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['becomesBlocked'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: { event: 'becomesBlocked', filter: { object: 'self' } },
							effectSupported: true,
							text: `Rampage ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'ravenous',
		{
			name: 'ravenous',
			cr: '702.156',
			parameterKind: 'none',
			displayLabel: 'Ravenous',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						condition: { k: 'enteredWithXAtLeast', n: 5 },
						effectSupported: true,
						text: 'Ravenous',
						effect: {
							steps: [
								{
									verb: 'draw',
									subject: { k: 'playerRef', ref: { k: 'you' } },
									amount: { k: 'const', n: 1 },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'read ahead',
		{
			name: 'read ahead',
			cr: '702.155',
			parameterKind: 'none',
			displayLabel: 'Read ahead',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P9 ---
	[
		'rebound',
		{
			name: 'rebound',
			cr: '702.88',
			parameterKind: 'none',
			displayLabel: 'Rebound',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P15 ---
	[
		'reconfigure',
		{
			name: 'reconfigure',
			cr: '702.151',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildReconfigureAttachAbility }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	[
		'recover',
		{
			name: 'recover',
			cr: '702.59',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const rawCost = (kw.cost ?? kw.param ?? '').trim();
					const isManaOnly = /^(\{[^}]+\})+$/.test(rawCost);
					const text = rawCost ? (isManaOnly ? `Recover ${rawCost}` : `Recover—${rawCost}`) : 'Recover';
					return [
						{
							abilityIndex,
							trigger: {
								event: 'zoneChange',
								fromZone: 'graveyard',
								filter: {
									object: { types: ['Creature'], owner: 'you', other: true },
									from: 'battlefield',
									to: 'graveyard'
								}
							},
							effectSupported: true,
							text,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P6 ---
	[
		'reinforce',
		{
			name: 'reinforce',
			cr: '702.77',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildReinforceActivatedAbility }
		}
	],
	// --- Track P12 ---
	[
		'renown',
		{
			name: 'renown',
			cr: '702.112',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['dealsDamage'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'dealsDamage',
								filter: { object: 'self', combat: true, damageTo: 'player' }
							},
							condition: { k: 'not', of: { k: 'isRenowned' } },
							effectSupported: true,
							text: `Renown ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P6 ---
	[
		'replicate',
		{
			name: 'replicate',
			cr: '702.56',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => {
					const t = buildOptionalCostCastCopyTrigger('replicate', true, span);
					return [
						{
							abilityIndex,
							trigger: t.trigger,
							condition: t.condition,
							effectSupported: true,
							text: 'Replicate',
							effect: { steps: t.effect, targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- Track P3 ---
	[
		'retrace',
		{
			name: 'retrace',
			cr: '702.81',
			parameterKind: 'none',
			displayLabel: 'Retrace',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- Track P9 ---
	[
		'riot',
		{
			name: 'riot',
			cr: '702.136',
			parameterKind: 'none',
			displayLabel: 'Riot',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P15 ---
	[
		'ripple',
		{
			name: 'ripple',
			cr: '702.60',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	// --- End Track P15 ---
	// --- Track P3 ---
	[
		'saddle',
		{
			name: 'saddle',
			cr: '702.171',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildSaddleAbility }
		}
	],
	// --- Track P9 ---
	[
		'scavenge',
		{
			name: 'scavenge',
			cr: '702.97',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildScavengeAbility }
		}
	],
	unimplemented('soulbond', '702.95'),
	// --- Track P9 ---
	[
		'soulshift',
		{
			name: 'soulshift',
			cr: '702.46',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (kw, abilityIndex, span) => {
					const n = kw.n ?? 0;
					return [
						{
							abilityIndex,
							trigger: {
								event: 'zoneChange',
								filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
							},
							effectSupported: true,
							text: `Soulshift ${n}`,
							effect: {
								steps: [
									{
										verb: 'move',
										subject: { k: 'target', index: 0 },
										params: { from: 'graveyard', to: 'hand' },
										optional: { chooser: { k: 'you' } },
										span
									}
								],
								targets: [
									{
										kind: 'object',
										filter: {
											zone: 'graveyard',
											owner: 'you',
											subtypes: ['Spirit'],
											manaValue: { op: '<=', value: { k: 'const', n } }
										},
										min: 1,
										max: 1
									}
								],
								unparsed: []
							}
						}
					];
				}
			}
		}
	],
	unimplemented('space sculptor', '702.158'),
	// --- Track P12 ---
	[
		'spectacle',
		{
			name: 'spectacle',
			cr: '702.137',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'splice',
		{
			name: 'splice',
			cr: '702.47',
			parameterKind: 'text',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'start your engines!',
		{
			name: 'start your engines!',
			cr: '702.179',
			parameterKind: 'none',
			displayLabel: 'Start your engines!',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- End Track P15 ---
	// --- Track P12 ---
	simpleImplemented('split second', '702.61', 'Split second'),
	// --- End Track P12 ---
	// --- Track P6 ---
	[
		'squad',
		{
			name: 'squad',
			cr: '702.157',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => {
					const t = buildSquadTrigger(span);
					return [
						{
							abilityIndex,
							trigger: t.trigger,
							condition: t.condition,
							effectSupported: true,
							text: 'Squad',
							effect: { steps: t.effect, targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	[
		'storm',
		{
			name: 'storm',
			cr: '702.40',
			parameterKind: 'none',
			displayLabel: 'Storm',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['cast'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'cast', filter: { object: 'self', player: { relation: 'you' } } },
						effectSupported: true,
						text: 'Storm',
						effect: {
							steps: [
								{
									verb: 'copySpell',
									subject: { k: 'self' },
									params: { count: { k: 'stormCount' }, mayChooseNewTargets: true },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- Track P12 ---
	[
		'sunburst',
		{
			name: 'sunburst',
			cr: '702.44',
			parameterKind: 'none',
			displayLabel: 'Sunburst',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	[
		'surge',
		{
			name: 'surge',
			cr: '702.117',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	// --- End Track P12 ---
	unimplemented('totem armor', '702.89'),
	// --- Track P12 ---
	[
		'training',
		{
			name: 'training',
			cr: '702.149',
			parameterKind: 'none',
			displayLabel: 'Training',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'attacks', filter: { object: 'self', trainingGreaterAttacker: true } },
						effectSupported: true,
						text: 'Training',
						effect: {
							steps: [
								{
									verb: 'putCounters',
									subject: { k: 'self' },
									amount: { k: 'const', n: 1 },
									params: { counter: '+1/+1' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P15 ---
	[
		'transfigure',
		{
			name: 'transfigure',
			cr: '702.71',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildTransfigureAbility }
		}
	],
	// --- End Track P15 ---
	// --- Track P6 ---
	[
		'transmute',
		{
			name: 'transmute',
			cr: '702.53',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildTransmuteActivatedAbility }
		}
	],
	unimplemented('tribute', '702.104', 'number'),
	// --- Track P12 ---
	simpleImplemented('umbra armor', '702.89', 'Umbra armor'),
	[
		'undaunted',
		{
			name: 'undaunted',
			cr: '702.125',
			parameterKind: 'none',
			displayLabel: 'Undaunted',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'static',
				buildStatics: () => [
					{
						k: 'costModifier',
						affects: { k: 'self' },
						delta: { mode: 'reduce', generic: 1, per: { k: 'opponentCount' } },
						who: { relation: 'you' }
					}
				]
			}
		}
	],
	// --- End Track P12 ---
	// --- Track P9 ---
	[
		'undying',
		{
			name: 'undying',
			cr: '702.93',
			parameterKind: 'none',
			displayLabel: 'Undying',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: {
							event: 'zoneChange',
							filter: { object: 'self', from: 'battlefield', to: 'graveyard' }
						},
						condition: { k: 'lkiHasNoCounter', counter: '+1/+1' },
						effectSupported: true,
						text: 'Undying',
						effect: {
							steps: [
								{
									verb: 'move',
									subject: { k: 'self' },
									params: {
										from: 'graveyard',
										to: 'battlefield',
										withCounters: { counter: '+1/+1', count: 1 }
									},
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	[
		'unearth',
		{
			name: 'unearth',
			cr: '702.84',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildUnearthAbility }
		}
	],
	// --- Track P9 ---
	[
		'unleash',
		{
			name: 'unleash',
			cr: '702.98',
			parameterKind: 'none',
			displayLabel: 'Unleash',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	// --- Track P6 ---
	[
		'vanishing',
		{
			name: 'vanishing',
			cr: '702.63',
			parameterKind: 'number',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'static', buildStatics: () => [] }
		}
	],
	unimplemented('visit', '702.159'),
	// --- Track P9 ---
	[
		'toxic',
		{
			name: 'toxic',
			cr: '702.164',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: { kind: 'primitive' }
		}
	],
	// --- Track P6 ---
	[
		'station',
		{
			name: 'station',
			cr: '702.184',
			parameterKind: 'none',
			displayLabel: 'Station',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'activated', buildActivated: buildStationActivatedAbility }
		}
	],
	unimplemented('exhaust', '702.177', 'text'),
	// --- Track P12 ---
	[
		'harmonize',
		{
			name: 'harmonize',
			cr: '702.180',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'mobilize',
		{
			name: 'mobilize',
			cr: '702.181',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: { event: 'attacks', filter: { object: 'self' } },
							effectSupported: true,
							text: `Mobilize ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	[
		'web-slinging',
		{
			name: 'web-slinging',
			cr: '702.188',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'sneak',
		{
			name: 'sneak',
			cr: '702.190',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: { kind: 'castOption' }
		}
	],
	[
		'firebending',
		{
			name: 'firebending',
			cr: '702.189',
			parameterKind: 'number',
			grantable: true,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['attacks'],
				buildTriggers: (kw, abilityIndex, _span) => {
					const n = kw.n ?? 1;
					return [
						{
							abilityIndex,
							trigger: { event: 'attacks', filter: { object: 'self' } },
							effectSupported: true,
							text: `Firebending ${n}`,
							effect: { steps: [], targets: [], unparsed: [] }
						}
					];
				}
			}
		}
	],
	// --- End Track P12 ---
	unimplemented('waterbend', '701.67', 'cost'),
	// --- Track P15 ---
	[
		'job select',
		{
			name: 'job select',
			cr: '702.182',
			parameterKind: 'none',
			displayLabel: 'Job select',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'trigger',
				events: ['zoneChange'],
				buildTriggers: (_kw, abilityIndex, span) => [
					{
						abilityIndex,
						trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
						effectSupported: true,
						text: 'Job select',
						effect: {
							steps: [
								{
									verb: 'createToken',
									subject: { k: 'none' },
									amount: { k: 'const', n: 1 },
									bindAs: 'hero',
									params: {
										token: {
											name: 'Hero Token',
											power: 1,
											toughness: 1,
											colors: [],
											typeLine: 'Token Creature — Hero',
											keywords: []
										}
									},
									span
								},
								{
									verb: 'attach',
									subject: { k: 'binding', name: 'hero' },
									span
								}
							],
							targets: [],
							unparsed: []
						}
					}
				]
			}
		}
	],
	// --- End Track P15 ---
	// --- Track P6 ---
	[
		'warp',
		{
			name: 'warp',
			cr: '702.185',
			parameterKind: 'cost',
			grantable: false,
			status: 'implemented',
			implementation: {
				kind: 'castOption',
				altCost: {
					id: 'alt:warp',
					label: 'Cast with Warp',
					castSummarySuffix: ' (Warped)',
					zones: ['hand'],
					requiresZonePermission: false,
					disallowLand: true,
					warped: true,
					stackBadgeLabel: 'Warped'
				}
			}
		}
	]
];

/** Single source of truth for all CR 702 keywords (and recognized keyword actions). */
export const KEYWORD_REGISTRY: Readonly<Record<string, KeywordSpec>> = Object.fromEntries(REGISTRY_ENTRIES);

export function getKeywordSpec(name: string): KeywordSpec | undefined {
	return KEYWORD_REGISTRY[name.trim().toLowerCase()];
}

/** Canonical lower-case names of all implemented keywords. */
export const IMPLEMENTED_KEYWORDS: ReadonlySet<string> = new Set(
	REGISTRY_ENTRIES.filter(([, spec]) => spec.status === 'implemented').map(([name]) => name)
);

/** All recognized CR 702 keyword names, sorted longest-first for prefix matching. */
export const KNOWN_KEYWORDS: readonly string[] = REGISTRY_ENTRIES.map(([name]) => name).sort(
	(a, b) => b.length - a.length || a.localeCompare(b)
);

const isSimpleContinuousGrantable = (name: string, spec: KeywordSpec): boolean =>
	spec.status === 'implemented' &&
	spec.grantable &&
	(spec.parameterKind === 'none' || name === 'hexproof');

// --- Track P9 ---
const TOXIC_GRANT_PHRASES = ['toxic 1', 'toxic 2', 'toxic 3', 'toxic 4', 'toxic 5', 'toxic 6'] as const;
// --- Track P12 ---
const WAVE4_GRANT_PHRASES = [
	'afflict 1',
	'afflict 2',
	'afflict 3',
	'afflict 4',
	'firebending 1',
	'firebending 2',
	'firebending 3',
	'firebending 4',
	'mobilize 1',
	'mobilize 2',
	'mobilize 3',
	'mobilize 4',
	'rampage 1',
	'rampage 2',
	'rampage 3',
	'rampage 4',
	'renown 1',
	'renown 2',
	'renown 3'
] as const;
// --- End Track P12 ---

/** Bare keywords accepted in static continuous ability grants ("Creatures you control have ..."). */
export const STATIC_CONTINUOUS_KEYWORDS: ReadonlySet<string> = new Set([
	...REGISTRY_ENTRIES.filter(([name, spec]) => isSimpleContinuousGrantable(name, spec)).map(([name]) => name),
	...TOXIC_GRANT_PHRASES,
	// --- Track P12 ---
	...WAVE4_GRANT_PHRASES
	// --- End Track P12 ---
]);

/** Bare keywords accepted by effect "gains <keyword>" clauses ("gains flying, battle cry until end of turn"). */
export const GRANTABLE_KEYWORDS: readonly string[] = [
	...REGISTRY_ENTRIES.filter(([name, spec]) => isSimpleContinuousGrantable(name, spec)).map(([name]) => name),
	...TOXIC_GRANT_PHRASES,
	// --- Track P12 ---
	...WAVE4_GRANT_PHRASES
	// --- End Track P12 ---
];

/** Display labels for non-parameterized implemented keywords (insertion order preserved). */
export const KEYWORD_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
	REGISTRY_ENTRIES.filter(([, spec]) => spec.status === 'implemented' && spec.displayLabel !== undefined).map(
		([name, spec]) => [name, spec.displayLabel!]
	)
);

/** Alternative-cost keyword metadata (CR 118.9) derived from `KEYWORD_REGISTRY`. */
export const ALTERNATIVE_COST_KEYWORDS: Readonly<Record<string, AlternativeCostKeywordMeta>> = Object.fromEntries(
	REGISTRY_ENTRIES.flatMap(([name, spec]) =>
		spec.status === 'implemented' && spec.implementation?.kind === 'castOption' && spec.implementation.altCost
			? [[name, spec.implementation.altCost] as const]
			: []
	)
);

/** Event kinds listened to by parameterless grantable `'trigger'` keywords (Layer 6 grants). */
export const GRANTED_TRIGGER_KEYWORD_EVENTS: ReadonlySet<EventKind> = new Set(
	REGISTRY_ENTRIES.flatMap(([, spec]) =>
		spec.status === 'implemented' &&
		spec.grantable &&
		spec.parameterKind === 'none' &&
		spec.implementation?.kind === 'trigger'
			? [...spec.implementation.events]
			: []
	)
);
