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
	timing?: 'default' | 'instant_only';
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

	// ---- Unimplemented CR 702 keywords recognized on keyword lines ----
	unimplemented('absorb', '702.64', 'number'),
	unimplemented('afflict', '702.130', 'number'),
	unimplemented('amplify', '702.38', 'number'),
	unimplemented('ascend', '702.131'),
	unimplemented('aura swap', '702.65', 'cost'),
	unimplemented('awaken', '702.113', 'text'),
	unimplemented('backup', '702.165', 'number'),
	unimplemented('banding', '702.22'),
	unimplemented('bargain', '702.166'),
	unimplemented('bestow', '702.103', 'cost'),
	unimplemented('blitz', '702.152', 'cost'),
	unimplemented('bloodthirst', '702.54', 'number'),
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
	unimplemented('cascade', '702.85'),
	unimplemented('casualty', '702.153', 'number'),
	unimplemented('champion', '702.72', 'quality'),
	unimplemented('cipher', '702.99'),
	unimplemented('cleave', '702.148', 'cost'),
	unimplemented('companion', '702.139', 'text'),
	unimplemented('compleated', '702.150'),
	unimplemented('conspire', '702.78'),
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
	unimplemented('craft', '702.167', 'text'),
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
	unimplemented('cumulative upkeep', '702.24', 'cost'),
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
	unimplemented('dash', '702.109', 'cost'),
	unimplemented('daybound', '702.145'),
	unimplemented('decayed', '702.147'),
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
	unimplemented('demonstrate', '702.144'),
	unimplemented('dethrone', '702.105'),
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
	unimplemented('devour', '702.82', 'number'),
	faceDownCostKeyword('disguise', '702.168', 'disguise', 'Cast face down (Disguise)', '{2}'),
	unimplemented('disturb', '702.146', 'cost'),
	unimplemented('double team', '702.156'),
	unimplemented('dredge', '702.52', 'number'),
	unimplemented('echo', '702.30', 'cost'),
	unimplemented('embalm', '702.128', 'cost'),
	unimplemented('emerge', '702.119', 'cost'),
	unimplemented('encore', '702.141', 'cost'),
	unimplemented('enlist', '702.154'),
	unimplemented('entwine', '702.42', 'cost'),
	unimplemented('epic', '702.50'),
	unimplemented('escalate', '702.120', 'cost'),
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
	unimplemented('eternalize', '702.129', 'cost'),
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
	unimplemented('evolve', '702.100'),
	unimplemented('extort', '702.101'),
	unimplemented('fabricate', '702.123', 'number'),
	unimplemented('fading', '702.32', 'number'),
	unimplemented('flanking', '702.25'),
	unimplemented('forecast', '702.57', 'text'),
	unimplemented('foretell', '702.143', 'cost'),
	unimplemented('fortify', '702.67', 'cost'),
	unimplemented('frenzy', '702.68', 'number'),
	unimplemented('friends forever', '702.124i'),
	unimplemented('gift', '702.174', 'quality'),
	unimplemented('graft', '702.58', 'number'),
	unimplemented('gravestorm', '702.69'),
	unimplemented('haunt', '702.55'),
	unimplemented('hidden agenda', '702.106'),
	unimplemented('hideaway', '702.75', 'number'),
	unimplemented('improvise', '702.126'),
	unimplemented('impending', '702.176', 'text'),
	unimplemented('ingest', '702.115'),
	unimplemented('jump-start', '702.133'),
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
	unimplemented('level up', '702.87', 'cost'),
	unimplemented('living metal', '702.161'),
	unimplemented('madness', '702.35', 'cost'),
	faceDownCostKeyword('megamorph', '702.37b', 'megamorph', 'Cast face down (Megamorph)'),
	unimplemented('melee', '702.121'),
	unimplemented('mentor', '702.134'),
	unimplemented('miracle', '702.94', 'cost'),
	unimplemented('modular', '702.43', 'number'),
	faceDownCostKeyword('morph', '702.37', 'morph', 'Cast face down (Morph)'),
	unimplemented('more than meets the eye', '702.162', 'cost'),
	unimplemented('mutate', '702.140', 'cost'),
	unimplemented('myriad', '702.116'),
	unimplemented('nightbound', '702.145'),
	unimplemented('ninjutsu', '702.49', 'cost'),
	unimplemented('offering', '702.48', 'quality'),
	unimplemented('offspring', '702.175', 'cost'),
	unimplemented('outlast', '702.107', 'cost'),
	unimplemented('persist', '702.79'),
	unimplemented('plot', '702.170', 'cost'),
	unimplemented('poisonous', '702.70', 'number'),
	unimplemented('prototype', '702.160', 'text'),
	unimplemented('provoke', '702.39'),
	unimplemented('prowl', '702.76', 'cost'),
	unimplemented('rampage', '702.23', 'number'),
	unimplemented('ravenous', '702.156'),
	unimplemented('read ahead', '702.155'),
	unimplemented('rebound', '702.88'),
	unimplemented('reconfigure', '702.151', 'cost'),
	unimplemented('recover', '702.59', 'cost'),
	unimplemented('reinforce', '702.77', 'text'),
	unimplemented('renown', '702.112', 'number'),
	unimplemented('replicate', '702.56', 'cost'),
	unimplemented('retrace', '702.81'),
	unimplemented('riot', '702.136'),
	unimplemented('ripple', '702.60', 'number'),
	unimplemented('saddle', '702.171', 'number'),
	unimplemented('scavenge', '702.97', 'cost'),
	unimplemented('skulk', '702.118'),
	unimplemented('soulbond', '702.95'),
	unimplemented('soulshift', '702.46', 'number'),
	unimplemented('space sculptor', '702.158'),
	unimplemented('spectacle', '702.137', 'cost'),
	unimplemented('splice', '702.47', 'text'),
	unimplemented('split second', '702.61'),
	unimplemented('squad', '702.157', 'cost'),
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
	unimplemented('sunburst', '702.44'),
	unimplemented('surge', '702.117', 'cost'),
	unimplemented('totem armor', '702.89'),
	unimplemented('training', '702.149'),
	unimplemented('transfigure', '702.71', 'cost'),
	unimplemented('transmute', '702.53', 'cost'),
	unimplemented('tribute', '702.104', 'number'),
	unimplemented('umbra armor', '702.89'),
	unimplemented('undaunted', '702.125'),
	unimplemented('undying', '702.93'),
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
	unimplemented('unleash', '702.98'),
	unimplemented('vanishing', '702.63', 'number'),
	unimplemented('visit', '702.159'),
	unimplemented('toxic', '702.164', 'number'),
	unimplemented('station', '702.184'),
	unimplemented('exhaust', '702.177', 'text'),
	unimplemented('harmonize', '702.180', 'cost'),
	unimplemented('mobilize', '702.181', 'number'),
	unimplemented('web-slinging', '702.188', 'cost'),
	unimplemented('sneak', '702.190', 'cost'),
	unimplemented('firebending', '702.189', 'number'),
	unimplemented('waterbend', '701.67', 'cost'),
	unimplemented('job select', '702.182'),
	unimplemented('warp', '702.185', 'cost')
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

/** Bare keywords accepted in static continuous ability grants ("Creatures you control have ..."). */
export const STATIC_CONTINUOUS_KEYWORDS: ReadonlySet<string> = new Set(
	REGISTRY_ENTRIES.filter(([name, spec]) => isSimpleContinuousGrantable(name, spec)).map(([name]) => name)
);

/** Bare keywords accepted by effect "gains <keyword>" clauses ("gains flying, battle cry until end of turn"). */
export const GRANTABLE_KEYWORDS: readonly string[] = REGISTRY_ENTRIES.filter(([name, spec]) =>
	isSimpleContinuousGrantable(name, spec)
).map(([name]) => name);

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
