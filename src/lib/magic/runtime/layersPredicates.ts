/**
 * Phase 6 / Wave 2: Layer predicates, filter/amount/condition evaluators, work-state helpers,
 * and BigInt read-tracking flags extracted from runtime/layers.ts (strictly below layers.ts in DAG).
 */
import { compileCard } from '../compiler/index.ts';
import { KEYWORD_LABELS } from '../keywords.ts';
import type {
	AbilityDef,
	ActivatedAbility,
	Amount,
	CardDefinition,
	Condition,
	ObjectFilter,
	PlayerRef,
	ReplacementDef,
	Span,
	StaticDef,
	TriggeredAbility
} from '../ir.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	GameState,
	ManaColor,
	ScryfallCard
} from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './faces.ts';
import { getBoardSnapshot, type BoardSnapshot } from './layerCache.ts';
import { evaluateKickedCountAmount, evaluateKickerCondition } from './kicker.ts';
import { evaluateAmount, matchesObjectFilter, playerCommanderCastCount } from './objectFilter.ts';
import { compareNumbers, countDistinctCardTypesInZone } from './staticsLayersAndRestrictions.ts';
import { evaluateP10Condition, resolveQuotedAbilityDefs } from './reflexiveManaAndActions.ts';
import { PROTECTION_KEYWORD_BY_COLOR } from './tuckFreezeChosen.ts';
import { collectBackupGrantedAbilityDefs } from './keywordsWave4.ts';
import {
	KEYWORD_COUNTER_TYPES,
	PARTY_ROLE_SUBTYPES,
	computeKeywordCounterMask,
	computePartyCountFromRoleMasks
} from './staticsDynamicAndCosts.ts';
import { evaluateP13Condition } from './effectsWave5.ts';
import { evaluateP20bAmount, evaluateP20bCondition } from './costsWave7.ts';
import {
	OUTLAW_SUBTYPES,
	cardHasAdventure,
	evaluateP16bCondition,
	objectHasXInManaCost
} from './triggersWave6.ts';
import {
	cardHasGraveyardContinuousStatic,
	collectGraveyardContinuousStaticsForPlayer,
	computeWorkListDevotionToColors,
	evaluateWave5Amount,
	evaluateWave5Condition,
	type ProtectionAttachmentExemptionInfo
} from './staticsAndCostsWave5.ts';
import { evaluateP17bAmount, evaluateP17bCondition } from './costsWave6.ts';
import {
	countOpponentsWithLifeLessThanHalfStarting,
	evaluateChosenPlayerZoneCount,
	evaluateLifeCompareHalfStarting,
	evaluateMostCommonColorFromCounts,
	matchesManaValueParity
} from './staticsWave7.ts';
import {
	evaluateCreaturesDiedThisTurnWave8,
	evaluateDistinctNamesFilterCountWave8,
	evaluatePlayerCountersAmountWave8,
	evaluateSpellsCastThisTurnWave8,
	evaluateWave8Condition,
	matchesChosenCardType,
	pluralizeCardTypeForProtection
} from './staticsWave8.ts';
import {
	evaluateLayerAmountWave9,
	matchesLayerFilterWave9
} from './staticsWave9.ts';

// --- Track P16a ---
export const P16A_EXTRA_KEYWORD_COUNTERS = ['shadow', 'exalted', 'decayed'] as const;
const P16A_ARBITRARY_PT_COUNTER_RE = /^([+-]\d+)\/([+-]\d+)$/;

export function collectP16aArbitraryPtCounters(
	counters: Record<string, number>
): Array<{ key: string; count: number; dp: number; dt: number }> | null {
	let items: Array<{ key: string; count: number; dp: number; dt: number }> | null = null;
	for (const key in counters) {
		if (key === '+1/+1' || key === '-1/-1') continue;
		const count = counters[key];
		if (!count || count <= 0) continue;
		if (key.charCodeAt(0) !== 43 && key.charCodeAt(0) !== 45) continue;
		const m = P16A_ARBITRARY_PT_COUNTER_RE.exec(key);
		if (!m) continue;
		const cp = parseInt(m[1], 10);
		const ct = parseInt(m[2], 10);
		(items ??= []).push({ key, count, dp: cp * count, dt: ct * count });
	}
	if (items && items.length > 1) {
		items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}
	return items;
}
// --- End Track P16a ---

export interface AttributedKeywordOrEffect {
	id: string;
	canonicalKey: string;
	name: string;
	kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod';
	isInnate: boolean;
	sources: string[];
	/** Number of non-innate grants of this item (CR 702.108b: multiple instances of prowess each trigger separately, even from same-named sources). */
	grantCount?: number;
	/** Granted activated ability IR and granting source metadata (derived/cached only, never stored in GameState). */
	grantedAbility?: ActivatedAbility;
	// --- Track P11 ---
	grantedTriggeredAbility?: TriggeredAbility;
	grantedStaticAbility?: StaticDef;
	grantedReplacementAbility?: ReplacementDef;
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	// --- End Track P11 ---
	// --- Track P14 ---
	protectionExemption?: ProtectionAttachmentExemptionInfo;
	// --- End Track P14 ---
	// --- Track P20a ---
	protectedFromPlayerId?: string;
	// --- End Track P20a ---
	grantSourceCard?: ScryfallCard;
	grantSourceId?: string;
	removed: boolean;
	removedBy: string[];
}

export interface CardContinuousBreakdown {
	baseTypeLine: string;
	effectiveTypeLine: string;
	typeModified: boolean;
	typeModifiedBy: string[];
	basePower: number | null;
	baseToughness: number | null;
	effectivePower: number | null;
	effectiveToughness: number | null;
	ptModifiedBy: string[];
	items: AttributedKeywordOrEffect[];
}

export interface EvaluatedPermanent {
	instanceId: string;
	controllerId: string;
	effectiveName: string;
	effectiveTypeLine: string;
	typeLine: string;
	isCreature: boolean;
	isArtifact: boolean;
	isEnchantment: boolean;
	isLand: boolean;
	isPlaneswalker: boolean;
	isLegendary: boolean;
	hasAllCreatureTypes: boolean;
	losesAllAbilities: boolean;
	hasLostAllAbilities: boolean;
	lostAllAbilitiesBy: string[];
	power: number;
	toughness: number;
	unclampedToughness?: number | null;
	colors: ManaColor[];
	activeKeywords: string[];
	keywords: string[];
	breakdown: CardContinuousBreakdown;
	hasSubType: (subType: string) => boolean;
	// --- Track P20a ---
	protectionFromPlayerIds?: string[];
	// --- End Track P20a ---
}

/**
 * CR 205.3m: Split the right-hand subtype list of a type line, preserving the
 * two-word creature subtype "Time Lord" as a single subtype token.
 */
export function splitSubtypes(right: string): string[] {
	const out: string[] = [];
	for (const m of right.matchAll(/Time\s+Lord|\S+/gi)) {
		out.push(/^time\s+lord$/i.test(m[0]) ? 'Time Lord' : m[0]);
	}
	return out;
}

const LOWER_SUBTYPES = new Map<string, Set<string> | null>();

/**
 * The lowercased subtypes after the type line's dash, or null when it has no dash. A pure memo
 * keyed by the type line string, so it can't go stale; `hasSubType` asks it on every call (SBAs ask
 * every permanent each pass), and splitting the line each time was a hot spot (Phase 6d).
 */
export function lowerSubtypesOf(typeLine: string): Set<string> | null {
	let subs = LOWER_SUBTYPES.get(typeLine);
	if (subs === undefined) {
		const dashIdx = typeLine.indexOf('—');
		subs =
			dashIdx === -1
				? null
				: new Set(splitSubtypes(typeLine.slice(dashIdx + 1).trim()).map((s) => s.toLowerCase()));
		if (LOWER_SUBTYPES.size > 10_000) LOWER_SUBTYPES.clear();
		LOWER_SUBTYPES.set(typeLine, subs);
	}
	return subs;
}

export function normalizeSubtypes(subs: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < subs.length; i++) {
		if (
			subs[i].toLowerCase() === 'time' &&
			i + 1 < subs.length &&
			subs[i + 1].toLowerCase() === 'lord'
		) {
			out.push('Time Lord');
			i++;
		} else {
			out.push(subs[i]);
		}
	}
	return out;
}

// ---- Constants & Formatting -----------------------------------------------------------------

export const BASIC_LAND_MANA_BY_SUBTYPE: Record<string, { subtype: string; sym: string }> = {
	plains: { subtype: 'Plains', sym: 'W' },
	island: { subtype: 'Island', sym: 'U' },
	swamp: { subtype: 'Swamp', sym: 'B' },
	mountain: { subtype: 'Mountain', sym: 'R' },
	forest: { subtype: 'Forest', sym: 'G' }
};

export const BASIC_LAND_SUBTYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

export const LAND_SUBTYPES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Gate',
	'Locus',
	'Cave',
	'Desert',
	'Lair',
	'Sphere',
	'Tower',
	'Mine',
	'Power-Plant',
	'Town',
	"Urza's"
]);

export const NON_CREATURE_SUBTYPES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Gate',
	'Locus',
	'Cave',
	'Desert',
	'Sphere',
	'Tower',
	'Mine',
	'Power-Plant',
	"Urza's",
	'Equipment',
	'Treasure',
	'Clue',
	'Food',
	'Blood',
	'Map',
	'Powerstone',
	'Gold',
	'Shard',
	'Lander',
	'Mutagen',
	'Heartwood',
	'Junk',
	'Vibranium',
	'Vehicle',
	'Fortification',
	'Contraption',
	'Attraction',
	'Aura',
	'Saga',
	'Class',
	'Case',
	'Room',
	'Background',
	'Shrine',
	'Role',
	'Cartouche',
	'Curse',
	'Rune',
	'Arcane',
	'Adventure',
	'Lesson',
	'Trap',
	'Chorus',
	// --- Track P15 ---
	'Siege',
	'Omen',
	'Spacecraft'
	// --- End Track P15 ---
]);

export { KEYWORD_LABELS };

const KEYWORD_ORDER = new Map<string, number>(
	Object.keys(KEYWORD_LABELS).map((k, idx) => [k, idx])
);

export function sortGrantedKeywords(keywords: readonly string[]): string[] {
	return [...keywords].sort((a, b) => {
		const idxA = KEYWORD_ORDER.get(a.toLowerCase()) ?? 999;
		const idxB = KEYWORD_ORDER.get(b.toLowerCase()) ?? 999;
		return idxA - idxB;
	});
}

export function formatKeywordLabel(kw: string): string {
	const low = kw.trim().toLowerCase();
	if (KEYWORD_LABELS[low]) return KEYWORD_LABELS[low];
	if (low.startsWith('protection from ')) {
		return `Protection from ${kw.trim().slice('protection from '.length)}`;
	}
	if (low.startsWith('hexproof from ')) {
		return `Hexproof from ${kw.trim().slice('hexproof from '.length)}`;
	}
	if (low.startsWith('ward ')) {
		const rest = kw
			.trim()
			.slice(5)
			.trim()
			.replace(/\{([^}]+)\}/g, (_, sym: string) => `{${sym.toUpperCase()}}`);
		return `Ward ${rest}`;
	}
	if (low.startsWith('ward—')) {
		const rest = kw
			.trim()
			.slice(5)
			.trim()
			.replace(/\{([^}]+)\}/g, (_, sym: string) => `{${sym.toUpperCase()}}`);
		return `Ward—${rest}`;
	}
	// --- Track P9 ---
	if (low.startsWith('toxic ')) {
		return `Toxic ${kw.trim().slice(6).trim()}`;
	}
	return kw.charAt(0).toUpperCase() + kw.slice(1);
}

export function addSubtypeToTypeLine(typeLine: string, subtype: string): string {
	if (new RegExp(`\\b${subtype}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		return `${typeLine} ${subtype}`;
	}
	return `${typeLine} — ${subtype}`;
}

export function addCardTypeToTypeLine(typeLine: string, cardType: string): string {
	if (new RegExp(`\\b${cardType}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		const [left, right] = typeLine.split('—');
		return `${left.trim()} ${cardType} — ${right.trim()}`;
	}
	return `${typeLine.trim()} ${cardType}`;
}

export function formatSignedDelta(dp: number, dt: number): string {
	const sp = dp >= 0 ? `+${dp}` : `${dp}`;
	const st = dt >= 0 ? `+${dt}` : `${dt}`;
	return `${sp}/${st}`;
}

// ---- Innate Keywords & Abilities from IR ----------------------------------------------------

type InnateEntry = { canonicalKey: string; name: string; kind: 'keyword' | 'ability' };

const INNATE_MEMO = new WeakMap<
	ScryfallCard,
	{
		typeLine: string;
		keywords: string[];
		keywordsKey: string;
		result: ReadonlyArray<InnateEntry>;
	}
>();

function formatManaProductionFromIR(ab: ActivatedAbility): string {
	const step = ab.effect.find((e) => e.verb === 'addMana');
	if (!step) return 'Mana';
	if (step.params?.manaChoice === 'commanderIdentity') {
		return "one mana of any color in your commander's color identity";
	}
	if (step.params?.manaChoice === 'any') {
		return 'one mana of any color';
	}
	const syms = Array.isArray(step.params?.mana)
		? (step.params.mana as string[]).map((c) => `{${c}}`).join('')
		: '{C}';
	if (step.amount?.k === 'count' && step.amount.of.subtypes?.length) {
		const sub = step.amount.of.subtypes[0];
		const who = step.amount.of.controller === 'you' ? ' you control' : ' on the battlefield';
		return `${syms} for each ${sub}${who}`;
	}
	return syms;
}

function extractInnateFromIR(
	card: ScryfallCard,
	faceOpts?: ResolveObjectFacesOptions
): InnateEntry[] {
	const results: InnateEntry[] = [];
	const seenKeys = new Set<string>();
	const addResult = (canonicalKey: string, name: string, kind: 'keyword' | 'ability') => {
		const k = canonicalKey.toLowerCase();
		const dedupKey =
			// --- Track P18a: Absorb, Frenzy, and Poisonous stack across multiple instances (CR 702.64c, 702.68b, 702.70b) ---
			k === 'toxic' || k === 'absorb' || k === 'frenzy' || k === 'poisonous'
				? `${k}::${results.length}`
				: // --- End Track P18a ---
					k === 'protection' ||
					  k === 'ward' ||
					  k === 'afterlife' ||
					  k === 'bushido' ||
					  k === 'annihilator' ||
					  k === 'affinity' ||
					  k === 'modular' ||
					  k === 'soulshift' ||
					  k === 'fabricate' ||
					  k === 'bloodthirst' ||
					  // --- Track P18a ---
					  k === 'tribute' ||
					  k === 'hideaway' ||
					  k === 'fortify' ||
					  k === 'mutate' ||
					  k === 'teamwork'
					  // --- End Track P18a ---
					? `${k}::${name.toLowerCase()}`
					: k;
		if (seenKeys.has(dedupKey)) return;
		seenKeys.add(dedupKey);
		results.push({ canonicalKey: k, name, kind });
	};

	const view = resolveObjectFaces(card, faceOpts);
	if (view.isFaceDown) {
		if (view.wardCost) {
			addResult('ward', `Ward ${view.wardCost}`, 'keyword');
		}
		return results;
	}
	const chars = activeCharacteristics(card, faceOpts);
	const abilities = activeAbilityDefs(card, faceOpts);
	const isEquipment = chars.subtypes.includes('Equipment');
	const isAura = chars.subtypes.includes('Aura');

	const grantedToOthersKeywords = new Set<string>();
	const selfGrantedKeywords = new Set<string>();

	for (const ab of abilities) {
		if (ab.kind === 'keyword') {
			const kwName = ab.keyword.name.toLowerCase();
			if (kwName === 'enchant') {
				if (isAura) addResult('enchant', `Enchant ${ab.keyword.param ?? 'permanent'}`, 'keyword');
			} else if (kwName === 'equip') {
				const costStr =
					ab.keyword.cost ?? (ab.keyword.n !== undefined ? `${ab.keyword.n}` : '{0}');
				addResult('equip', `Equip ${costStr}`, 'keyword');
			} else if (kwName === 'ward') {
				const costStr = ab.keyword.cost
					? ` ${ab.keyword.cost}`
					: ab.keyword.param
						? `—${ab.keyword.param}`
						: ab.keyword.n !== undefined
							? ` ${ab.keyword.n}`
							: '';
				addResult('ward', `Ward${costStr}`, 'keyword');
			} else if (kwName === 'protection') {
				addResult('protection', `Protection from ${ab.keyword.param ?? ''}`.trim(), 'keyword');
			} else if (kwName === 'hexproof' && ab.keyword.param) {
				const full = `hexproof from ${ab.keyword.param}`.toLowerCase();
				addResult(full, formatKeywordLabel(full), 'keyword');
			} else if (kwName === 'afterlife') {
				addResult('afterlife', `Afterlife ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'bushido') {
				addResult('bushido', `Bushido ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'annihilator') {
				addResult('annihilator', `Annihilator ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'affinity') {
				addResult('affinity', `Affinity ${ab.keyword.param ?? ''}`.trim(), 'keyword');
			} else if (kwName === 'toxic') {
				addResult('toxic', `Toxic ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'modular') {
				addResult('modular', `Modular ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'soulshift') {
				addResult('soulshift', `Soulshift ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'fabricate') {
				addResult('fabricate', `Fabricate ${ab.keyword.n ?? 0}`, 'keyword');
			} else if (kwName === 'bloodthirst') {
				addResult(
					'bloodthirst',
					`Bloodthirst ${ab.keyword.param === 'X' ? 'X' : (ab.keyword.n ?? 0)}`,
					'keyword'
				);
			// --- Track P15 ---
			} else if (kwName === 'reconfigure') {
				const costStr = ab.keyword.cost ?? (ab.keyword.n !== undefined ? `${ab.keyword.n}` : '');
				addResult('reconfigure', `Reconfigure ${costStr}`.trim(), 'keyword');
				selfGrantedKeywords.add('reconfigure');
			} else if (kwName === 'impending') {
				const nStr = ab.keyword.impendingN ?? ab.keyword.n ?? 1;
				const costStr = ab.keyword.cost ? `—${ab.keyword.cost}` : '';
				addResult('impending', `Impending ${nStr}${costStr}`, 'keyword');
				selfGrantedKeywords.add('impending');
			} else if (kwName === 'amplify') {
				addResult('amplify', `Amplify ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('amplify');
			} else if (kwName === 'ripple') {
				addResult('ripple', `Ripple ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('ripple');
			// --- End Track P15 ---
			// --- Track P18a ---
			} else if (kwName === 'absorb') {
				addResult('absorb', `Absorb ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('absorb');
			} else if (kwName === 'frenzy') {
				addResult('frenzy', `Frenzy ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('frenzy');
			} else if (kwName === 'poisonous') {
				addResult('poisonous', `Poisonous ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('poisonous');
			} else if (kwName === 'tribute') {
				addResult('tribute', `Tribute ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('tribute');
			} else if (kwName === 'hideaway') {
				addResult('hideaway', `Hideaway ${ab.keyword.n ?? 4}`, 'keyword');
				selfGrantedKeywords.add('hideaway');
			} else if (kwName === 'fortify') {
				const costStr = ab.keyword.cost ?? (ab.keyword.n !== undefined ? `${ab.keyword.n}` : '{0}');
				addResult('fortify', `Fortify ${costStr}`, 'keyword');
				selfGrantedKeywords.add('fortify');
			} else if (kwName === 'mutate') {
				const costStr = ab.keyword.cost ?? ab.keyword.param ?? '';
				addResult('mutate', `Mutate ${costStr}`.trim(), 'keyword');
				selfGrantedKeywords.add('mutate');
			} else if (kwName === 'teamwork') {
				addResult('teamwork', `Teamwork ${ab.keyword.n ?? 1}`, 'keyword');
				selfGrantedKeywords.add('teamwork');
			// --- End Track P18a ---
			} else {
				addResult(kwName, formatKeywordLabel(kwName), 'keyword');
				selfGrantedKeywords.add(kwName);
			}
		} else if (ab.kind === 'static') {
			const st = ab.static;
			if (st.k === 'restriction' && st.affected === 'self' && !st.condition) {
				if (st.restriction === 'cantBeCountered') {
					addResult("can't be countered", "Can't be countered", 'keyword');
				} else if (st.restriction === 'cantBeBlocked') {
					addResult('unblockable', 'Unblockable', 'keyword');
				}
			} else if (st.k === 'continuous') {
				if (st.mod.k === 'addKeywords') {
					const isSelfInclusiveSubtypeLord =
						chars.types.includes('Creature') &&
						!st.condition &&
						typeof st.affected === 'object' &&
						!st.affected.other &&
						st.affected.controller === 'you' &&
						Boolean(st.affected.subtypes?.some((sub) => chars.subtypes.includes(sub)));
					for (const kw of st.mod.keywords) {
						const kwLow = kw.toLowerCase();
						if ((st.affected === 'self' && !st.condition) || isSelfInclusiveSubtypeLord) {
							selfGrantedKeywords.add(kwLow);
							if (kwLow.startsWith('protection from ')) {
								addResult('protection', formatKeywordLabel(kwLow), 'keyword');
							} else if (kwLow.startsWith('toxic ')) {
								addResult('toxic', formatKeywordLabel(kwLow), 'keyword');
							} else {
								addResult(kwLow, formatKeywordLabel(kwLow), 'keyword');
							}
						} else {
							grantedToOthersKeywords.add(kwLow);
							if (kwLow.startsWith('protection from ')) {
								grantedToOthersKeywords.add('protection');
							} else if (kwLow.startsWith('toxic ')) {
								grantedToOthersKeywords.add('toxic');
							}
						}
					}
				} else if (st.mod.k === 'removeKeywords') {
					for (const kw of st.mod.keywords) {
						grantedToOthersKeywords.add(kw.toLowerCase());
					}
				}
			}
		} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
			for (const step of ab.effect) {
				if (step.verb === 'grant') {
					for (const kw of step.params?.keywords ?? []) {
						grantedToOthersKeywords.add(kw.toLowerCase());
					}
					for (const kw of step.params?.removeKeywords ?? []) {
						grantedToOthersKeywords.add(kw.toLowerCase());
					}
				}
			}
		}
	}

	// Check card/face keywords for innate keywords not exclusively granted to others
	for (const rawKw of view.keywords.length > 0 ? view.keywords : card.keywords || []) {
		const kwLow = rawKw.toLowerCase();
		const isSupportedKeywordBadge =
			Boolean(KEYWORD_LABELS[kwLow]) ||
			kwLow.startsWith('protection from ') ||
			kwLow.startsWith('hexproof from ') ||
			kwLow.startsWith('ward ');
		if (
			!isSupportedKeywordBadge ||
			seenKeys.has(kwLow) ||
			kwLow === 'equip' ||
			kwLow === 'enchant' ||
			kwLow === 'protection' ||
			kwLow === 'ward' ||
			(kwLow === 'hexproof' && [...seenKeys].some((k) => k.startsWith('hexproof from ')))
		) {
			continue;
		}
		if (
			(isEquipment || isAura) &&
			!chars.types.includes('Creature') &&
			kwLow !== 'flash' &&
			kwLow !== 'indestructible' &&
			kwLow !== 'phasing' &&
			// --- Track P15 ---
			kwLow !== 'reconfigure' &&
			kwLow !== 'job select' &&
			kwLow !== 'living metal' &&
			kwLow !== 'aura swap'
			// --- End Track P15 ---
		) {
			continue;
		}
		if (grantedToOthersKeywords.has(kwLow) && !selfGrantedKeywords.has(kwLow)) {
			continue;
		}
		addResult(kwLow, formatKeywordLabel(kwLow), 'keyword');
	}

	// 2. Summarize innate abilities from compiled abilities in order
	for (const ab of abilities) {
		if (ab.kind === 'triggered') {
			const trig = ab.trigger;
			if (trig.event === 'zoneChange' && trig.filter?.to === 'battlefield') {
				if (trig.filter.object === 'self') {
					addResult('ability_etb', 'Enters Battlefield Trigger', 'ability');
				} else if (
					typeof trig.filter.object === 'object' &&
					trig.filter.object.types?.includes('Land')
				) {
					addResult('ability_landfall', 'Landfall Trigger', 'ability');
				}
			} else if (trig.event === 'attacks') {
				addResult('ability_attack', 'Attack Trigger', 'ability');
			} else if (trig.event === 'dealsDamage' && trig.filter?.combat) {
				addResult('ability_combat_dmg', 'Combat Damage Trigger', 'ability');
			} else if (trig.event === 'cast') {
				addResult('ability_cast_trig', 'Spell Cast Trigger', 'ability');
			} else if (
				trig.event === 'phaseBegin' &&
				trig.filter?.phase === 'end_step' &&
				ab.effect.some((s) => s.verb === 'proliferate')
			) {
				addResult('ability_endstep_proliferate', 'End Step: Proliferate', 'ability');
			}
		} else if (ab.kind === 'activated') {
			if (ab.intrinsic) {
				addResult('ability_activated', 'Activated Ability', 'ability');
			} else if (ab.isMana && ab.cost.length === 1 && ab.cost[0].k === 'tapSelf') {
				addResult('ability_mana', `Mana Ability: Add ${formatManaProductionFromIR(ab)}`, 'ability');
			} else if (
				ab.effect.some(
					(s) =>
						s.verb === 'grant' &&
						Boolean(s.params?.removeKeywords?.length) &&
						s.subject.k === 'all' &&
						s.subject.filter.controller === 'opponent'
				)
			) {
				addResult('ability_strip_kw', 'Removes Opponent Keywords', 'ability');
			} else {
				addResult('ability_activated', 'Activated Ability', 'ability');
			}
		} else if (ab.kind === 'static') {
			const st = ab.static;
			if (st.k === 'costModifier' && st.activeZones?.includes('command')) {
				addResult('ability_eminence', 'Eminence Ability', 'ability');
			} else if (
				st.k === 'costModifier' &&
				st.affects.k === 'spell' &&
				st.who.relation === 'you' &&
				st.delta.mode === 'reduce'
			) {
				addResult('ability_cost_mod', 'Spell Cost Reduction', 'ability');
			} else if (st.k === 'ruleModifier') {
				if (st.rule === 'noMaxHandSize') {
					addResult('ability_no_max_hand', 'No Maximum Hand Size', 'ability');
				} else if (st.rule === 'searchControl') {
					addResult(
						'ability_search_control',
						'Control Opponents Searching Libraries',
						'ability'
					);
				}
			} else if (st.k === 'multiplier') {
				if (st.what === 'counters' && st.counter === '+1/+1') {
					addResult('ability_counter_doubler', 'Doubles +1/+1 Counters', 'ability');
				} else if (st.what === 'triggers') {
					addResult('ability_trigger_doubler', 'Doubles Triggered Abilities', 'ability');
				}
			} else if (st.k === 'continuous') {
				if (st.affected === 'attachedTo') {
					if (isEquipment) {
						addResult('ability_equip_buff', 'Grants Equipped Creature Buff', 'ability');
					} else {
						addResult('ability_enchant_mod', 'Modifies Enchanted Permanent', 'ability');
					}
				} else if (st.mod.k === 'grantAbility') {
					addResult('ability_activated', 'Activated Ability', 'ability');
				} else if (
					st.mod.k === 'removeKeywords' &&
					typeof st.affected === 'object' &&
					st.affected.controller === 'opponent'
				) {
					addResult('ability_strip_kw', 'Removes Opponent Keywords', 'ability');
				} else if (
					typeof st.affected === 'object' &&
					st.affected.controller === 'you' &&
					st.affected.types?.includes('Creature') &&
					(st.mod.k === 'pt' || st.mod.k === 'addKeywords')
				) {
					addResult('ability_lord', 'Anthem / Lord Effect', 'ability');
				}
			}
		} else if (ab.kind === 'unsupported' && ab.id?.startsWith('act_')) {
			addResult('ability_activated', 'Activated Ability', 'ability');
		}
	}

	return results;
}

export function innateKeywordsAndAbilitiesOf(
	card: ScryfallCard,
	faceOpts?: ResolveObjectFacesOptions
): ReadonlyArray<InnateEntry> {
	const canUseDefaultMemo =
		!faceOpts ||
		(!faceOpts.isFaceDown &&
			(faceOpts.faceIndex ?? 0) === 0 &&
			!faceOpts.unlockedFaces?.length &&
			!faceOpts.copiableState &&
			!faceOpts.fused &&
			// --- Track P18a ---
			!faceOpts.mergedComponents?.length &&
			// --- End Track P18a ---
			(card.layout === undefined || card.layout === 'normal'));
	if (!canUseDefaultMemo) {
		return extractInnateFromIR(card, faceOpts);
	}
	const keywordsKey = (card.keywords || []).join('\u0000');
	const hit = INNATE_MEMO.get(card);
	if (
		hit &&
		hit.typeLine === card.typeLine &&
		hit.keywords === card.keywords &&
		hit.keywordsKey === keywordsKey
	) {
		return hit.result;
	}
	const result = extractInnateFromIR(card, faceOpts);
	INNATE_MEMO.set(card, {
		typeLine: card.typeLine,
		keywords: card.keywords,
		keywordsKey,
		result
	});
	return result;
}

// ---- Board-Wide Layer Evaluation ------------------------------------------------------------

export interface PermWorkState {
	inst: CardInstance;
	controllerId: string;
	baseCard: ScryfallCard;
	timestamp: number;
	name: string;
	// --- Track P14 ---
	manaCost: string;
	// --- End Track P14 ---
	manaValue: number;
	isFaceDown: boolean;
	baseTypeLine: string;
	effectiveTypeLine: string;
	supertypes: string[];
	types: string[];
	subtypes: string[];
	colors: ManaColor[];
	isLegendary: boolean;
	prefixLegendary: string;
	hasAllCreatureTypes: boolean;
	basePower: number | null;
	baseToughness: number | null;
	workingPower: number | null;
	workingToughness: number | null;
	typeModifiedBy: string[];
	ptModifiedBy: string[];
	allAbilityRemovalSources: string[];
	abilityRemovalEvents: Array<{
		sourceName: string;
		timestamp: number;
		// --- Track P17a ---
		keepManaAbilities?: boolean;
		// --- End Track P17a ---
		fromLayer6?: boolean;
		sourceId?: string;
	}>;
	// --- Track P17a ---
	latestSetLandSubtypesTs?: number;
	// --- End Track P17a ---
	pendingLandSubtypes?: Array<{
		rawSourceName: string;
		removalSourceName: string;
		timestamp: number;
		sourceId: string;
		hasBasic: boolean;
	}>;
	skippedLayer4SetSubtypes?: boolean;
	skippedLayer4Additive?: boolean;
	layer7bSetters: Array<{
		sourceName: string;
		power?: number | null;
		toughness?: number | null;
		timestamp: number;
	}>;
	items: AttributedKeywordOrEffect[];
	itemTimestamps: Map<string, number>;
	itemSourceIds?: Map<string, Set<string>>;
	statics: StaticDef[];
	grantsKeywordViaAbility: Set<string>;
	strippedByAttachment: boolean;
}

export function recordAbilityRemoval(
	work: PermWorkState,
	sourceName: string,
	timestamp: number,
	// --- Track P17a ---
	keepManaAbilities = false,
	// --- End Track P17a ---
	fromLayer6 = false,
	sourceId?: string
): void {
	const existing = work.abilityRemovalEvents.find(
		(e) =>
			e.sourceName === sourceName &&
			e.timestamp === timestamp &&
			Boolean(e.keepManaAbilities) === keepManaAbilities &&
			e.sourceId === sourceId
	);
	if (existing) {
		if (fromLayer6) existing.fromLayer6 = true;
	} else {
		work.abilityRemovalEvents.push({
			sourceName,
			timestamp,
			...(keepManaAbilities ? { keepManaAbilities: true } : {}),
			...(fromLayer6 ? { fromLayer6: true } : {}),
			...(sourceId ? { sourceId } : {})
		});
	}
	if (!work.allAbilityRemovalSources.includes(sourceName)) {
		work.allAbilityRemovalSources.push(sourceName);
	}
	if (work.allAbilityRemovalSources.length > 1) {
		const minTs = new Map<string, number>();
		for (const ev of work.abilityRemovalEvents) {
			const prev = minTs.get(ev.sourceName);
			if (prev === undefined || ev.timestamp < prev) minTs.set(ev.sourceName, ev.timestamp);
		}
		work.allAbilityRemovalSources.sort((a, b) => (minTs.get(a) ?? 0) - (minTs.get(b) ?? 0));
	}
}

export interface GrantedAbilityMeta {
	grantedAbility?: ActivatedAbility;
	// --- Track P11 ---
	grantedTriggeredAbility?: TriggeredAbility;
	grantedStaticAbility?: StaticDef;
	grantedReplacementAbility?: ReplacementDef;
	grantFaceIndex?: number;
	grantAbilityIndex?: number;
	// --- End Track P11 ---
	// --- Track P14 ---
	protectionExemption?: ProtectionAttachmentExemptionInfo;
	// --- End Track P14 ---
	// --- Track P20a ---
	protectedFromPlayerId?: string;
	// --- End Track P20a ---
	grantSourceCard?: ScryfallCard;
	grantSourceId?: string;
	sourceInstanceId?: string;
}

export const ZERO_SPAN: Span = { start: 0, end: 0 };

export function makeIntrinsicBasicManaAbility(sym: ManaColor): ActivatedAbility {
	return {
		kind: 'activated',
		id: `granted_mana_${sym.toLowerCase()}`,
		cost: [{ k: 'tapSelf' }],
		targets: [],
		effect: [
			{
				verb: 'addMana',
				subject: { k: 'none' },
				amount: { k: 'const', n: 1 },
				params: { mana: [sym] },
				span: ZERO_SPAN
			}
		],
		timing: 'mana',
		isMana: true,
		intrinsic: true,
		text: `{T}: Add {${sym}}.`,
		span: ZERO_SPAN
	};
}

export function describeGrantedActivatedAbility(
	ab: ActivatedAbility,
	sourceInstanceId: string
): { key: string; name: string } {
	if (
		ab.isMana &&
		ab.cost.length === 1 &&
		ab.cost[0].k === 'tapSelf' &&
		ab.effect.length === 1 &&
		ab.effect[0].verb === 'addMana' &&
		ab.effect[0].amount?.k === 'const' &&
		ab.effect[0].amount.n === 1
	) {
		const manaArr = ab.effect[0].params?.mana;
		if (Array.isArray(manaArr) && manaArr.length === 1) {
			const sym = manaArr[0] as ManaColor;
			return { key: `mana_${sym.toLowerCase()}`, name: `Mana Ability: Add {${sym}}` };
		}
		if (ab.effect[0].params?.manaChoice === 'any') {
			return { key: 'mana_any', name: 'Mana Ability: Add Any Color' };
		}
	}
	const key = `granted_ab_${sourceInstanceId}_${ab.id}`;
	const text = ab.text ?? 'Granted';
	const name = ab.isMana ? `Mana Ability: ${text}` : `Activated Ability: ${text}`;
	return { key, name };
}

export function grantItem(
	work: PermWorkState,
	canonicalKey: string,
	name: string,
	kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod',
	sourceName: string,
	grantTimestamp = 0,
	grantMeta?: GrantedAbilityMeta
): void {
	const keyLow = canonicalKey.toLowerCase();
	const existingActive =
		keyLow === 'toxic' ||
		// --- Track P14 (CR 702.16n): Keep attachment-exempt protection grants distinct ---
		(keyLow === 'protection' && Boolean(grantMeta?.protectionExemption)) ||
		// --- End Track P14 ---
		// --- Track P20a ---
		(keyLow === 'protection' && Boolean(grantMeta?.protectedFromPlayerId))
		// --- End Track P20a ---
			? undefined
			: work.items.find(
					(it) =>
						it.canonicalKey === keyLow &&
						!it.removed &&
						it.kind === kind &&
						// --- Track P14 ---
						!it.protectionExemption &&
						// --- End Track P14 ---
						(keyLow !== 'protection' && keyLow !== 'ward'
							? true
							: it.name.toLowerCase() === name.toLowerCase())
				);
	if (existingActive) {
		if (!existingActive.sources.includes(sourceName)) {
			existingActive.sources.push(sourceName);
		}
		if (grantMeta?.sourceInstanceId) {
			let set = work.itemSourceIds?.get(existingActive.id);
			if (!set) {
				set = new Set<string>();
				(work.itemSourceIds ??= new Map()).set(existingActive.id, set);
			}
			set.add(grantMeta.sourceInstanceId);
		}
		existingActive.grantCount = (existingActive.grantCount ?? 0) + 1;
		const prevTs = work.itemTimestamps.get(existingActive.id) ?? -Infinity;
		if (grantTimestamp >= prevTs) {
			if (grantTimestamp > prevTs) {
				work.itemTimestamps.set(existingActive.id, grantTimestamp);
			}
			if (grantMeta) {
				if (grantMeta.grantedAbility) existingActive.grantedAbility = grantMeta.grantedAbility;
				// --- Track P11 ---
				if (grantMeta.grantedTriggeredAbility) {
					existingActive.grantedTriggeredAbility = grantMeta.grantedTriggeredAbility;
				}
				if (grantMeta.grantedStaticAbility) {
					existingActive.grantedStaticAbility = grantMeta.grantedStaticAbility;
				}
				if (grantMeta.grantedReplacementAbility) {
					existingActive.grantedReplacementAbility = grantMeta.grantedReplacementAbility;
				}
				if (grantMeta.grantFaceIndex !== undefined) {
					existingActive.grantFaceIndex = grantMeta.grantFaceIndex;
				}
				if (grantMeta.grantAbilityIndex !== undefined) {
					existingActive.grantAbilityIndex = grantMeta.grantAbilityIndex;
				}
				// --- End Track P11 ---
				if (grantMeta.grantSourceCard) existingActive.grantSourceCard = grantMeta.grantSourceCard;
				if (grantMeta.grantSourceId) existingActive.grantSourceId = grantMeta.grantSourceId;
			}
		}
		return;
	}
	const id = `granted_${work.items.length}_${keyLow}`;
	work.itemTimestamps.set(id, grantTimestamp);
	if (grantMeta?.sourceInstanceId) {
		(work.itemSourceIds ??= new Map()).set(id, new Set([grantMeta.sourceInstanceId]));
	}
	work.items.push({
		id,
		canonicalKey: keyLow,
		name,
		kind,
		isInnate: false,
		sources: [sourceName],
		grantCount: 1,
		...(grantMeta
			? {
					...(grantMeta.grantedAbility ? { grantedAbility: grantMeta.grantedAbility } : {}),
					// --- Track P11 ---
					...(grantMeta.grantedTriggeredAbility
						? { grantedTriggeredAbility: grantMeta.grantedTriggeredAbility }
						: {}),
					...(grantMeta.grantedStaticAbility
						? { grantedStaticAbility: grantMeta.grantedStaticAbility }
						: {}),
					...(grantMeta.grantedReplacementAbility
						? { grantedReplacementAbility: grantMeta.grantedReplacementAbility }
						: {}),
					...(grantMeta.grantFaceIndex !== undefined
						? { grantFaceIndex: grantMeta.grantFaceIndex }
						: {}),
					...(grantMeta.grantAbilityIndex !== undefined
						? { grantAbilityIndex: grantMeta.grantAbilityIndex }
						: {}),
					// --- End Track P11 ---
					// --- Track P14 ---
					...(grantMeta.protectionExemption
						? { protectionExemption: grantMeta.protectionExemption }
						: {}),
					// --- End Track P14 ---
					// --- Track P20a ---
					...(grantMeta.protectedFromPlayerId
						? { protectedFromPlayerId: grantMeta.protectedFromPlayerId }
						: {}),
					// --- End Track P20a ---
					...(grantMeta.grantSourceCard ? { grantSourceCard: grantMeta.grantSourceCard } : {}),
					...(grantMeta.grantSourceId ? { grantSourceId: grantMeta.grantSourceId } : {})
				}
			: {}),
		removed: false,
		removedBy: []
	});
}

// --- Track P11 ---
const STATIC_LOCATORS_BY_DEF = new WeakMap<
	CardDefinition,
	ReadonlyMap<StaticDef, { faceIndex: number; abilityIndex: number }>
>();

export function lookupStaticLocator(
	card: ScryfallCard,
	st: StaticDef
): { faceIndex: number; abilityIndex: number } | undefined {
	const def = compileCard(card);
	let map = STATIC_LOCATORS_BY_DEF.get(def);
	if (!map) {
		const built = new Map<StaticDef, { faceIndex: number; abilityIndex: number }>();
		for (let fi = 0; fi < def.faces.length; fi++) {
			const faceAbs = def.faces[fi]?.abilities ?? [];
			for (let ai = 0; ai < faceAbs.length; ai++) {
				const fab = faceAbs[ai];
				if (fab.kind === 'static') {
					built.set(fab.static, { faceIndex: fi, abilityIndex: ai });
				}
			}
		}
		map = built;
		STATIC_LOCATORS_BY_DEF.set(def, map);
	}
	return map.get(st);
}

export function grantNonActivatedAbility(
	target: PermWorkState,
	source: PermWorkState,
	st: StaticDef,
	ab: AbilityDef
): boolean {
	const loc = lookupStaticLocator(source.baseCard, st);
	const faceIndex = loc?.faceIndex ?? 0;
	const abilityIndex = loc?.abilityIndex ?? 0;
	const srcId = source.inst.instanceId;
	if (ab.kind === 'triggered') {
		const key = `granted_trig_${srcId}_${faceIndex}_${abilityIndex}`;
		const name = `Triggered Ability: ${ab.text || 'Granted'}`;
		grantItem(target, key, name, 'ability', source.name, source.timestamp, {
			grantedTriggeredAbility: ab,
			grantSourceCard: source.baseCard,
			grantSourceId: srcId,
			grantFaceIndex: faceIndex,
			grantAbilityIndex: abilityIndex
		});
		return false;
	} else if (ab.kind === 'static') {
		const key = `granted_static_${srcId}_${faceIndex}_${abilityIndex}`;
		const name = 'Granted Static Ability';
		grantItem(target, key, name, 'ability', source.name, source.timestamp, {
			grantedStaticAbility: ab.static,
			grantSourceCard: source.baseCard,
			grantSourceId: srcId,
			grantFaceIndex: faceIndex,
			grantAbilityIndex: abilityIndex
		});
		return true;
	} else if (ab.kind === 'replacement') {
		const key = `granted_repl_${srcId}_${faceIndex}_${abilityIndex}`;
		const name = 'Granted Replacement Effect';
		grantItem(target, key, name, 'ability', source.name, source.timestamp, {
			grantedReplacementAbility: ab.replacement,
			grantSourceCard: source.baseCard,
			grantSourceId: srcId,
			grantFaceIndex: faceIndex,
			grantAbilityIndex: abilityIndex
		});
		return false;
	} else if (ab.kind === 'keyword') {
		const kwLow = ab.keyword.name.toLowerCase();
		const kwLabel = ab.keyword.dynamicAmount
			? `${ab.keyword.name.charAt(0).toUpperCase()}${ab.keyword.name.slice(1)} X`
			: ab.keyword.n !== undefined
				? `${ab.keyword.name.charAt(0).toUpperCase()}${ab.keyword.name.slice(1)} ${ab.keyword.n}`
				: formatKeywordLabel(kwLow);
		const canonKey = ab.keyword.n !== undefined ? `${kwLow} ${ab.keyword.n}` : kwLow;
		grantItem(target, canonKey, kwLabel, 'keyword', source.name, source.timestamp);
		return false;
	}
	return false;
}
// --- End Track P11 ---

const BASIC_SUBTYPE_BY_INTRINSIC_MANA_ID: Record<string, string> = {
	granted_mana_w: 'Plains',
	granted_mana_u: 'Island',
	granted_mana_b: 'Swamp',
	granted_mana_r: 'Mountain',
	granted_mana_g: 'Forest'
};

export function applyRemovalsUpTo(work: PermWorkState, cutoffTimestamp: number): void {
	for (const ev of work.abilityRemovalEvents) {
		if (ev.timestamp > cutoffTimestamp) continue;
		for (const item of work.items) {
			if (item.kind !== 'keyword' && item.kind !== 'ability' && !item.isInnate) continue;
			// --- Track P17a ---
			if (ev.keepManaAbilities && item.grantedAbility?.timing === 'mana') continue;
			// --- End Track P17a ---
			const itemTs = work.itemTimestamps.get(item.id) ?? -Infinity;
			const isIntrinsicBasicMana =
				Boolean(item.grantedAbility?.intrinsic) &&
				item.grantedAbility!.id.startsWith('granted_mana_');
			const itemSourceIds = work.itemSourceIds?.get(item.id);
			const fromSameSource =
				ev.sourceId && itemSourceIds?.size
					? itemSourceIds.has(ev.sourceId)
					: item.sources.includes(ev.sourceName);
			if (!ev.fromLayer6) {
				// CR 305.7: Setting a basic land subtype removes rules-text (innate) abilities,
				// not abilities granted by other Layer 6 effects; only clean up orphaned Layer 4
				// intrinsic basic-land mana if an earlier subtype was overwritten in Layer 4.
				const reqSub = isIntrinsicBasicMana
					? BASIC_SUBTYPE_BY_INTRINSIC_MANA_ID[item.grantedAbility!.id]
					: undefined;
				const orphanedIntrinsicMana =
					isIntrinsicBasicMana &&
					itemTs <= ev.timestamp &&
					!fromSameSource &&
					Boolean(reqSub && !hasSubtypeInWork(work, reqSub));
				if (item.isInnate || orphanedIntrinsicMana) {
					item.removed = true;
					if (!item.removedBy.includes(ev.sourceName)) {
						item.removedBy.push(ev.sourceName);
					}
				}
				continue;
			}
			const removedByLayer6Intrinsic =
				!ev.keepManaAbilities &&
				!fromSameSource &&
				isIntrinsicBasicMana;
			if (itemTs < ev.timestamp || removedByLayer6Intrinsic) {
				item.removed = true;
				if (!item.removedBy.includes(ev.sourceName)) {
					item.removedBy.push(ev.sourceName);
				}
			}
		}
	}
}

export function grantKeywordString(
	work: PermWorkState,
	rawKw: string,
	sourceLabel: string,
	grantTimestamp: number
): void {
	const gLow = rawKw.toLowerCase();
	const gKey = gLow.startsWith('protection from ')
		? 'protection'
		: gLow.startsWith('ward ') || gLow.startsWith('ward—')
			? 'ward'
			: gLow.startsWith('toxic ')
				? 'toxic'
				: gLow;
	const formattedLabel = formatKeywordLabel(gKey === 'ward' ? rawKw : gLow);
	grantItem(work, gKey, formattedLabel, 'keyword', sourceLabel, grantTimestamp);
}

export function removeMatchingKeywordsUpTo(
	work: PermWorkState,
	keywords: readonly string[],
	sourceName: string,
	cutoffTimestamp: number
): void {
	for (const kw of keywords) {
		const kwLow = kw.toLowerCase();
		for (const item of work.items) {
			if (item.kind !== 'keyword') continue;
			const itemTs = work.itemTimestamps.get(item.id) ?? -Infinity;
			if (itemTs > cutoffTimestamp) continue;
			// --- Track P18a ---
			const { name: itemLabel } = item;
			const itemLabelLow = itemLabel.toLowerCase();
			// --- End Track P18a ---
			if (
				item.canonicalKey === kwLow ||
				(kwLow === 'hexproof' && item.canonicalKey.startsWith('hexproof from ')) ||
				(kwLow === 'protection' && item.canonicalKey.startsWith('protection')) ||
				(kwLow === 'ward' && item.canonicalKey.startsWith('ward')) ||
				(kwLow === 'toxic' && item.canonicalKey === 'toxic') ||
				(kwLow.startsWith('toxic ') && item.name.toLowerCase() === kwLow) ||
				// --- Track P18a ---
				(kwLow === 'absorb' &&
					(item.canonicalKey === 'absorb' || item.canonicalKey.startsWith('absorb '))) ||
				(kwLow.startsWith('absorb ') && itemLabelLow === kwLow) ||
				(kwLow === 'frenzy' &&
					(item.canonicalKey === 'frenzy' || item.canonicalKey.startsWith('frenzy '))) ||
				(kwLow.startsWith('frenzy ') && itemLabelLow === kwLow) ||
				(kwLow === 'poisonous' &&
					(item.canonicalKey === 'poisonous' || item.canonicalKey.startsWith('poisonous '))) ||
				(kwLow.startsWith('poisonous ') && itemLabelLow === kwLow)
				// --- End Track P18a ---
			) {
				item.removed = true;
				if (!item.removedBy.includes(sourceName)) {
					item.removedBy.push(sourceName);
				}
			}
		}
	}
}

export function hasSubtypeInWork(work: PermWorkState, sub: string): boolean {
	const low = sub.toLowerCase();
	if (work.subtypes.some((s) => s.toLowerCase() === low)) return true;
	// --- Track P11 (CR 702.73a, CR 700.8b): normalizeLayerCardType returns lowercase ('creature' | 'kindred') ---
	if (
		work.types.some(
			(t) => normalizeLayerCardType(t) === 'creature' || normalizeLayerCardType(t) === 'kindred'
		) &&
		work.hasAllCreatureTypes &&
		!NON_CREATURE_SUBTYPES.has(sub)
	) {
		return true;
	}
	// --- End Track P11 ---
	return false;
}

// --- Track P8 ---
export function normalizeLayerCardType(t: string): string {
	const low = t.toLowerCase();
	return low === 'tribal' ? 'kindred' : low;
}

export function workHasActiveKeyword(work: PermWorkState, kw: string): boolean {
	const kwLow = kw.toLowerCase();
	for (const it of work.items) {
		if (it.removed || it.kind !== 'keyword') continue;
		const nameLow = it.name.toLowerCase();
		const keyLow = it.canonicalKey.toLowerCase();
		if (
			keyLow === kwLow ||
			nameLow === kwLow ||
			nameLow.startsWith(`${kwLow} `) ||
			nameLow.startsWith(`${kwLow}—`)
		) {
			return true;
		}
	}
	return false;
}

export function offBattlefieldFilterNeedsExtendedMatch(f: ObjectFilter): boolean {
	return Boolean(
		f.allTypes?.length ||
			f.notTypes?.length ||
			f.notSubtypes?.length ||
			f.supertypes?.length ||
			f.notSupertypes?.length ||
			f.colors?.length ||
			f.notColors?.length ||
			f.multicolored !== undefined ||
			f.monocolored !== undefined ||
			f.hasKeywords?.length ||
			f.lacksKeywords?.length ||
			f.manaValue !== undefined ||
			f.power !== undefined ||
			f.toughness !== undefined ||
			// --- Track P11 ---
			f.ofChosenName ||
			f.attachedToRef !== undefined ||
			f.historic !== undefined ||
			// --- End Track P11 ---
			// --- Track P13 ---
			f.anyOf?.length ||
			f.controllerRef !== undefined ||
			f.faceDown !== undefined ||
			f.kickedSpell !== undefined ||
			f.castNotFromHand !== undefined ||
			f.castFromZoneFilter !== undefined ||
			f.enteredThisTurn !== undefined ||
			f.dealtDamageThisTurn !== undefined ||
			f.attackingOrBlocking !== undefined ||
			// --- End Track P13 ---
			// --- Track P14 ---
			f.sameNameAsSource ||
			f.sharesColorWithSelf ||
			f.hasAnyCounter !== undefined ||
			f.equipped !== undefined ||
			f.enchanted !== undefined ||
			// --- End Track P14 ---
			// --- Track P15 ---
			f.isPrepared !== undefined ||
			Boolean(f.sharesCreatureTypeWithSelf) ||
			// --- End Track P15 ---
			// --- Track P16b & P17b ---
			Boolean(f.allSubtypes?.length) ||
			f.modified !== undefined ||
			f.outlaw !== undefined ||
			f.hasAdventure !== undefined ||
			f.hasXInManaCost !== undefined ||
			f.powerEqualsToughness !== undefined ||
			f.manaValueEqualsSourcePower !== undefined ||
			// --- End Track P16b & P17b ---
			// --- Track P20a ---
			f.pairedWithSource !== undefined ||
			f.toughnessGreaterThanPower !== undefined ||
			f.manaValueParity !== undefined ||
			f.controlledByChosenPlayer !== undefined
			// --- End Track P20a ---
	);
}

export function resolveLayerPlayerRef(
	ref: PlayerRef,
	state: GameState,
	source: PermWorkState,
	target: PermWorkState
): string {
	switch (ref.k) {
		case 'you':
			return source.controllerId;
		case 'activePlayer':
			layerReads |= READ_ACTIVE_PLAYER;
			return state.players[state.activePlayerIndex]?.playerId ?? source.controllerId;
		case 'ownerOf':
			return ref.of.k === 'affected' ? target.inst.ownerId : source.inst.ownerId;
		case 'controllerOf':
			return ref.of.k === 'affected' ? target.controllerId : source.controllerId;
		default:
			return source.controllerId;
	}
}

export function matchesLayerFilter(
	filter: ObjectFilter,
	target: PermWorkState,
	source: PermWorkState,
	state: GameState,
	workList: PermWorkState[] = [],
	compareAgainst: PermWorkState = source
): boolean {
	if (
		filter.other &&
		target.inst.instanceId === (filter.sameNameAsAffected ? compareAgainst : source).inst.instanceId
	) {
		return false;
	}
	if (filter.controller === 'you' && target.controllerId !== source.controllerId) {
		return false;
	}
	if (filter.controller === 'opponent' && target.controllerId === source.controllerId) {
		return false;
	}
	// --- Track P13 ---
	if (filter.controllerRef) {
		const wantPid = resolveLayerPlayerRef(filter.controllerRef, state, source, target);
		if (target.controllerId !== wantPid) return false;
	}
	// --- End Track P13 ---
	if (filter.owner === 'you' && target.inst.ownerId !== source.controllerId) {
		return false;
	}
	if (filter.owner === 'opponent' && target.inst.ownerId === source.controllerId) {
		return false;
	}
	if (filter.isCommander !== undefined && Boolean(target.inst.isCommander) !== filter.isCommander) {
		return false;
	}
	if (filter.supertypes?.length) {
		if (
			!filter.supertypes.some((st) =>
				target.supertypes.some((ts) => ts.toLowerCase() === st.toLowerCase())
			)
		) {
			return false;
		}
	}
	if (filter.notSupertypes?.length) {
		if (
			filter.notSupertypes.some((st) =>
				target.supertypes.some((ts) => ts.toLowerCase() === st.toLowerCase())
			)
		) {
			return false;
		}
	}
	if (filter.types?.length) {
		if (
			!filter.types.some((t) => {
				const want = normalizeLayerCardType(t);
				return target.types.some((tt) => normalizeLayerCardType(tt) === want);
			})
		) {
			return false;
		}
	}
	// --- Track P8 ---
	if (filter.allTypes?.length) {
		if (
			!filter.allTypes.every((t) => {
				const want = normalizeLayerCardType(t);
				return target.types.some((tt) => normalizeLayerCardType(tt) === want);
			})
		) {
			return false;
		}
	}
	// --- Track P9 ---
	if (filter.allTypes?.length) {
		if (
			!filter.allTypes.every((t) => target.types.some((tt) => tt.toLowerCase() === t.toLowerCase()))
		) {
			return false;
		}
	}
	if (filter.notTypes?.length) {
		if (
			filter.notTypes.some((t) => {
				const want = normalizeLayerCardType(t);
				return target.types.some((tt) => normalizeLayerCardType(tt) === want);
			})
		) {
			return false;
		}
	}
	if (filter.subtypes?.length) {
		if (!filter.subtypes.some((sub) => hasSubtypeInWork(target, sub))) {
			return false;
		}
	}
	if (filter.notSubtypes?.length) {
		if (
			filter.notSubtypes.some((sub) =>
				target.subtypes.some((ts) => ts.toLowerCase() === sub.toLowerCase())
			)
		) {
			return false;
		}
	}
	if (filter.ofChosenType) {
		// --- Track P22a: Support both chosenSubType and chosenCardType (CR 614.12 / 300.1) ---
		const chosenSub = source.inst.chosenSubType;
		const chosenCardType = source.inst.chosenCardType;
		if (chosenSub) {
			if (!hasSubtypeInWork(target, chosenSub)) return false;
		} else if (chosenCardType) {
			layerReads |= READ_P22A;
			if (!matchesChosenCardType(target.types, chosenCardType)) return false;
		} else {
			return false;
		}
		// --- End Track P22a ---
	}
	if (filter.ofChosenColor) {
		const chosenCol = source.inst.chosenColor;
		if (!chosenCol || !target.colors.includes(chosenCol)) return false;
	}
	// --- Track P11 ---
	if (filter.ofChosenName) {
		layerReads |= READ_CHOSEN_CARD_NAME;
		const chosen = source.inst.chosenCardName;
		if (!chosen || target.isFaceDown || target.name.toLowerCase() !== chosen.toLowerCase()) {
			return false;
		}
	}
	if (filter.attachedToRef !== undefined) {
		// --- Track P21 ---
		if (filter.attachedToRef === 'hostOfSelf') {
			const hostId = source.inst.attachedToId;
			if (!hostId || target.inst.instanceId !== hostId) return false;
		} else if (filter.attachedToRef === 'reanimatedBySelf') {
			const link = target.inst.reanimatedByAura;
			if (
				!link ||
				link.sourceInstanceId !== source.inst.instanceId ||
				link.sourceObjectVersion !== (source.inst.objectVersion ?? 1)
			) {
				return false;
			}
		} else {
			// --- End Track P21 ---
			const wantHostId =
				filter.attachedToRef === 'self' ? source.inst.instanceId : source.inst.attachedToId;
			if (!wantHostId || target.inst.attachedToId !== wantHostId) return false;
			// --- Track P21 ---
		}
		// --- End Track P21 ---
	}
	if (filter.historic !== undefined) {
		const isHist =
			!target.isFaceDown &&
			(target.isLegendary ||
				target.types.some((t) => normalizeLayerCardType(t) === 'artifact') ||
				hasSubtypeInWork(target, 'Saga'));
		if (isHist !== filter.historic) return false;
	}
	// --- End Track P11 ---
	if (filter.colors?.length) {
		if (!matchesColorFilter(target.colors, filter.colors)) return false;
	}
	// --- Track P8 ---
	if (filter.notColors?.length) {
		if (filter.notColors.some((c) => target.colors.includes(c))) return false;
	}
	if (filter.multicolored !== undefined) {
		if ((target.colors.length >= 2) !== filter.multicolored) return false;
	}
	if (filter.monocolored !== undefined) {
		if ((target.colors.length === 1) !== filter.monocolored) return false;
	}
	if (filter.hasKeywords?.length) {
		if (!filter.hasKeywords.every((kw) => workHasActiveKeyword(target, kw))) return false;
	}
	if (filter.lacksKeywords?.length) {
		if (filter.lacksKeywords.some((kw) => workHasActiveKeyword(target, kw))) return false;
	}
	if (filter.hasCounters !== undefined) {
		layerReads |= READ_ALL_COUNTERS;
		if (filter.hasCounters === 'any') {
			const hasAny = Object.values(target.inst.counters).some((v) => v > 0);
			if (!hasAny) return false;
		} else {
			if (((target.inst.counters as Record<string, number>)[filter.hasCounters] ?? 0) <= 0) {
				return false;
			}
		}
	}
	if (filter.notHasCounters !== undefined) {
		layerReads |= READ_ALL_COUNTERS;
		if (filter.notHasCounters === 'any') {
			if (Object.values(target.inst.counters).some((v) => v > 0)) return false;
		} else if (((target.inst.counters as Record<string, number>)[filter.notHasCounters] ?? 0) > 0) {
			return false;
		}
	}
	if (filter.manaValue) {
		const expected = evaluateLayerAmount(filter.manaValue.value, state, workList, source, target);
		if (!compareNumbers(target.manaValue, filter.manaValue.op, expected)) return false;
	}
	if (filter.power) {
		if (!target.types.includes('Creature')) return false;
		const expected = evaluateLayerAmount(filter.power.value, state, workList, source, target);
		if (!compareNumbers(target.workingPower ?? 0, filter.power.op, expected)) return false;
	}
	if (filter.toughness) {
		if (!target.types.includes('Creature')) return false;
		const expected = evaluateLayerAmount(filter.toughness.value, state, workList, source, target);
		if (!compareNumbers(target.workingToughness ?? 0, filter.toughness.op, expected)) {
			return false;
		}
	}
	if (filter.attacking !== undefined) {
		layerReads |= READ_COMBAT;
		const isAtk = state.combat.attackers.some((a) => a.attackerInstanceId === target.inst.instanceId);
		if (isAtk !== filter.attacking) return false;
	}
	if (filter.blocking !== undefined) {
		layerReads |= READ_COMBAT;
		const isBlk = state.combat.attackers.some((a) =>
			a.blockerInstanceIds.includes(target.inst.instanceId)
		);
		if (isBlk !== filter.blocking) return false;
	}
	if (filter.tapped !== undefined) {
		layerReads |= READ_TAPPED;
		if (Boolean(target.inst.tapped) !== filter.tapped) return false;
	}
	if (filter.saddled !== undefined && Boolean(target.inst.saddledThisTurn) !== filter.saddled) {
		return false;
	}
	// --- Track P5 ---
	if (filter.monstrous !== undefined && Boolean(target.inst.isMonstrous) !== filter.monstrous) {
		return false;
	}
	// --- Track P10 ---
	if (filter.suspected !== undefined) {
		layerReads |= READ_P10_SUSPECT;
		if (Boolean(target.inst.isSuspected) !== filter.suspected) return false;
	}
	// --- End Track P10 ---
	// --- Track P15 ---
	if (filter.isPrepared !== undefined) {
		if (Boolean(target.inst.isPrepared) !== filter.isPrepared) return false;
	}
	if (filter.sharesCreatureTypeWithSelf) {
		const srcHasCreatSub =
			source.types.some(
				(t) => normalizeLayerCardType(t) === 'creature' || normalizeLayerCardType(t) === 'kindred'
			) &&
			(source.hasAllCreatureTypes || source.subtypes.some((s) => !NON_CREATURE_SUBTYPES.has(s)));
		const tgtHasCreatSub =
			target.types.some(
				(t) => normalizeLayerCardType(t) === 'creature' || normalizeLayerCardType(t) === 'kindred'
			) &&
			(target.hasAllCreatureTypes || target.subtypes.some((s) => !NON_CREATURE_SUBTYPES.has(s)));
		if (!srcHasCreatSub || !tgtHasCreatSub) return false;
		if (!source.hasAllCreatureTypes && !target.hasAllCreatureTypes) {
			const srcSubs = new Set(
				source.subtypes.filter((s) => !NON_CREATURE_SUBTYPES.has(s)).map((s) => s.toLowerCase())
			);
			const shared = target.subtypes.some(
				(s) => !NON_CREATURE_SUBTYPES.has(s) && srcSubs.has(s.toLowerCase())
			);
			if (!shared) return false;
		}
	}
	// --- End Track P15 ---
	if (filter.token !== undefined && Boolean(target.inst.isToken) !== filter.token) return false;
	// --- Track P13 + Track P14 ---
	if (filter.anyOf?.length) {
		if (!filter.anyOf.some((sub) => matchesLayerFilter(sub, target, source, state, workList))) {
			return false;
		}
	}
	if (filter.attackingOrBlocking !== undefined) {
		layerReads |= READ_COMBAT;
		const isAtkOrBlk = state.combat.attackers.some(
			(a) =>
				a.attackerInstanceId === target.inst.instanceId ||
				a.blockerInstanceIds.includes(target.inst.instanceId)
		);
		if (isAtkOrBlk !== filter.attackingOrBlocking) return false;
	}
	if (filter.dealtDamageThisTurn !== undefined) {
		layerReads |= READ_P13;
		if (Boolean(target.inst.dealtDamageThisTurn) !== filter.dealtDamageThisTurn) return false;
	}
	if (filter.enteredThisTurn !== undefined) {
		layerReads |= READ_P13;
		if (Boolean(target.inst.enteredThisTurn) !== filter.enteredThisTurn) return false;
	}
	if (filter.faceDown !== undefined && target.isFaceDown !== filter.faceDown) {
		return false;
	}
	if (filter.kickedSpell !== undefined) {
		if (((target.inst.kickedCount ?? 0) > 0) !== filter.kickedSpell) return false;
	}
	if (filter.castNotFromHand !== undefined) {
		const isNotHand = Boolean(target.inst.wasCast) && target.inst.castFromZone !== 'hand';
		if (isNotHand !== filter.castNotFromHand) return false;
	}
	if (filter.castFromZoneFilter !== undefined) {
		const zones = Array.isArray(filter.castFromZoneFilter)
			? filter.castFromZoneFilter
			: [filter.castFromZoneFilter];
		const ok =
			Boolean(target.inst.wasCast) &&
			Boolean(target.inst.castFromZone && zones.includes(target.inst.castFromZone));
		if (!ok) return false;
	}
	if (filter.sameNameAsSource) {
		if (
			target.isFaceDown ||
			source.isFaceDown ||
			!target.name ||
			!source.name ||
			target.name !== source.name
		) {
			return false;
		}
	}
	if (filter.sharesColorWithSelf) {
		if (
			target.colors.length === 0 ||
			source.colors.length === 0 ||
			!target.colors.some((c) => source.colors.includes(c))
		) {
			return false;
		}
	}
	if (filter.hasAnyCounter !== undefined) {
		layerReads |= READ_ALL_COUNTERS;
		const hasAny = Object.values(target.inst.counters).some((v) => v > 0);
		if (hasAny !== filter.hasAnyCounter) return false;
	}
	if (filter.equipped !== undefined) {
		const isEq = workList.some(
			(w) =>
				w.inst.attachedToId === target.inst.instanceId &&
				w.types.includes('Artifact') &&
				w.subtypes.includes('Equipment')
		);
		if (isEq !== filter.equipped) return false;
	}
	if (filter.enchanted !== undefined) {
		const isEnch = workList.some(
			(w) =>
				w.inst.attachedToId === target.inst.instanceId &&
				w.types.includes('Enchantment') &&
				w.subtypes.includes('Aura')
		);
		if (isEnch !== filter.enchanted) return false;
	}
	// --- End Track P13 + Track P14 ---
	// --- Track P16b & P17b ---
	if (filter.allSubtypes?.length) {
		if (!filter.allSubtypes.every((sub) => hasSubtypeInWork(target, sub))) {
			return false;
		}
	}
	if (filter.modified !== undefined) {
		layerReads |= READ_ALL_COUNTERS;
		const hasCtr = Object.values(target.inst.counters).some((v) => v > 0);
		const isEq = workList.some(
			(w) =>
				w.inst.attachedToId === target.inst.instanceId &&
				w.types.includes('Artifact') &&
				w.subtypes.includes('Equipment')
		);
		const isAuraControlledByYou = workList.some(
			(w) =>
				w.inst.attachedToId === target.inst.instanceId &&
				w.controllerId === source.controllerId &&
				w.types.includes('Enchantment') &&
				w.subtypes.includes('Aura')
		);
		const isMod = target.types.includes('Creature') && (hasCtr || isEq || isAuraControlledByYou);
		if (isMod !== filter.modified) return false;
	}
	if (filter.outlaw !== undefined) {
		const isOutlaw =
			target.hasAllCreatureTypes ||
			target.subtypes.some((st) => (OUTLAW_SUBTYPES as readonly string[]).includes(st));
		if (isOutlaw !== filter.outlaw) return false;
	}
	if (filter.hasAdventure !== undefined) {
		const hasAdv =
			!target.isFaceDown && cardHasAdventure(target.inst.copiableCard ?? target.inst.card);
		if (hasAdv !== filter.hasAdventure) return false;
	}
	if (filter.hasXInManaCost !== undefined) {
		const hasX = objectHasXInManaCost(target.inst, 'battlefield');
		if (hasX !== filter.hasXInManaCost) return false;
	}
	if (filter.powerGreaterThanBase !== undefined) {
		const gt =
			target.types.includes('Creature') &&
			(target.workingPower ?? 0) > (target.basePower ?? 0);
		if (gt !== filter.powerGreaterThanBase) return false;
	}
	if (filter.powerEqualsToughness !== undefined) {
		const eq =
			target.types.includes('Creature') &&
			target.workingPower !== null &&
			target.workingToughness !== null &&
			target.workingPower === target.workingToughness;
		if (eq !== filter.powerEqualsToughness) return false;
	}
	if (filter.controlledByEnchantedPlayer !== undefined) {
		const enchPid = source.inst.attachedToId ?? null;
		const ok = Boolean(enchPid && target.controllerId === enchPid);
		if (ok !== filter.controlledByEnchantedPlayer) return false;
	}
	if (filter.renowned !== undefined) {
		layerReads |= READ_P16B;
		if (Boolean(target.inst.isRenowned) !== filter.renowned) return false;
	}
	if (filter.goaded !== undefined) {
		layerReads |= READ_P16B;
		const isGoaded = (target.inst.goadedByPlayerIds?.length ?? 0) > 0;
		if (isGoaded !== filter.goaded) return false;
	}
	// --- End Track P16b & P17b ---
	// --- Track P16a ---
	if (filter.assimilatedWithSelf) {
		layerReads |= READ_P16A;
		const aBy = target.inst.assimilatedBy;
		const srcVer = source.inst.objectVersion ?? 1;
		if (
			!aBy ||
			aBy.sourceInstanceId !== source.inst.instanceId ||
			aBy.sourceObjectVersion !== srcVer
		) {
			return false;
		}
	}
	// --- End Track P16a ---
	// --- Track P20a ---
	if (filter.pairedWithSource) {
		layerReads |= READ_P20A;
		const pairedId = source.inst.pairedWithId;
		if (!pairedId) return false;
		if (target.inst.instanceId !== source.inst.instanceId && target.inst.instanceId !== pairedId) {
			return false;
		}
	}
	if (filter.controlledByChosenPlayer) {
		layerReads |= READ_P20A;
		const chosenPid = source.inst.chosenPlayerId;
		if (!chosenPid || target.controllerId !== chosenPid) return false;
	}
	if (filter.toughnessGreaterThanPower) {
		if (!target.types.includes('Creature')) return false;
		if (
			target.workingPower === null ||
			target.workingToughness === null ||
			target.workingToughness <= target.workingPower
		) {
			return false;
		}
	}
	if (filter.manaValueParity !== undefined) {
		layerReads |= READ_P20A;
		if (!matchesManaValueParity(target.manaValue, filter.manaValueParity, source.inst)) {
			return false;
		}
	}
	// --- End Track P20a ---
	// --- Track P21 ---
	if (filter.hasAnotherAuraAttached !== undefined) {
		const foundOtherAura = workList.some(
			(w) =>
				w.inst.instanceId !== source.inst.instanceId &&
				w.inst.attachedToId === target.inst.instanceId &&
				w.types.includes('Enchantment') &&
				w.subtypes.includes('Aura')
		);
		if (foundOtherAura !== filter.hasAnotherAuraAttached) return false;
	}
	// --- End Track P21 ---
	// --- Track P22a ---
	if (filter.manaValueEqualsChosenNumber) {
		layerReads |= READ_P22A;
		const chosenNum = source.inst.chosenNumber;
		if (chosenNum === undefined || target.manaValue !== chosenNum) return false;
	}
	if (filter.chosenObject) {
		layerReads |= READ_P22A;
		const chosenObjId = source.inst.chosenObjectId;
		if (!chosenObjId || target.inst.instanceId !== chosenObjId) return false;
	}
	// --- End Track P22a ---
	if (!matchesLayerFilterWave9(filter, target, source, compareAgainst, workList, state)) {
		return false;
	}
	return true;
}

export function evaluateLayerAmount(
	amount: Amount,
	state: GameState,
	workList: PermWorkState[],
	source: PermWorkState,
	affected: PermWorkState
): number {
	switch (amount.k) {
		case 'const':
			return amount.n;
		case 'x':
			return 0;
		case 'stat': {
			const refPerm = amount.of.k === 'affected' ? affected : source;
			if (amount.stat === 'manaValue') return refPerm.manaValue;
			if (amount.stat === 'power') return refPerm.workingPower ?? 0;
			if (amount.stat === 'toughness') return refPerm.workingToughness ?? 0;
			return 0;
		}
		case 'life': {
			layerReads |= READ_LIFE;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			return p?.life ?? 0;
		}
		case 'energyCount': {
			layerReads |= READ_ENERGY;
			if (amount.player.k === 'you') {
				const p = state.players.find((pl) => pl.playerId === source.controllerId);
				return p?.energyCounters ?? 0;
			}
			if (amount.player.k === 'activePlayer') {
				layerReads |= READ_ACTIVE_PLAYER;
				return state.players[state.activePlayerIndex]?.energyCounters ?? 0;
			}
			return 0;
		}
		case 'cardsIn': {
			layerReads |= READ_ZONE_SIZES;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			if (!p) return 0;
			if (amount.zone === 'hand') return p.hand.length;
			if (amount.zone === 'graveyard') return p.graveyard.length;
			if (amount.zone === 'library') return p.library.length;
			if (amount.zone === 'exile') return p.exile.length;
			if (amount.zone === 'command') return p.command.length;
			return 0;
		}
		case 'commanderCastCount': {
			layerReads |= READ_COMMANDER_CAST_COUNT;
			return playerCommanderCastCount(state, source.controllerId);
		}
		case 'stormCount':
			return 0;
		case 'tappedCostPower':
			return 0;
		case 'countersOn': {
			const refPerm = amount.of.k === 'affected' ? affected : source;
			// --- Track P8 ---
			if (amount.counter === 'any') {
				layerReads |= READ_ALL_COUNTERS;
				let total = 0;
				for (const v of Object.values(refPerm.inst.counters)) {
					if (v > 0) total += v;
				}
				return total;
			}
			if (
				amount.counter !== '+1/+1' &&
				amount.counter !== '-1/-1' &&
				amount.counter !== 'charge' &&
				amount.counter !== 'level'
			) {
				layerReads |= READ_ALL_COUNTERS;
			}
			return refPerm.inst.counters[amount.counter] || 0;
		}
		case 'kickedCount':
			return evaluateKickedCountAmount(amount, {
				count: source.inst.kickedCount ?? 0,
				tags: source.inst.kickedTags ?? [],
				...(source.inst.kickedTagCounts ? { tagCounts: source.inst.kickedTagCounts } : {})
			});
		case 'negate':
			return -evaluateLayerAmount(amount.of, state, workList, source, affected);
		case 'sum':
			return amount.args.reduce(
				(s, a) => s + evaluateLayerAmount(a, state, workList, source, affected),
				0
			);
		case 'min':
			return Math.min(
				...amount.args.map((a) => evaluateLayerAmount(a, state, workList, source, affected))
			);
		case 'max':
			return Math.max(
				...amount.args.map((a) => evaluateLayerAmount(a, state, workList, source, affected))
			);
		// --- Track P11 ---
		case 'mul':
			return amount.factor * evaluateLayerAmount(amount.of, state, workList, source, affected);
		case 'domain': {
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'you'
					? source.controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId);
			let domainCount = 0;
			for (const basicSub of BASIC_LAND_SUBTYPES) {
				let foundSub = false;
				for (const w of workList) {
					if (w.controllerId !== pid) continue;
					if (!w.types.some((t) => normalizeLayerCardType(t) === 'land')) continue;
					if (hasSubtypeInWork(w, basicSub)) {
						foundSub = true;
						break;
					}
				}
				if (foundSub) domainCount += 1;
			}
			return domainCount;
		}
		case 'partyCount': {
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'you'
					? source.controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId);
			const roleMasks: number[] = [];
			for (const w of workList) {
				if (w.controllerId !== pid) continue;
				if (!w.types.some((t) => normalizeLayerCardType(t) === 'creature')) continue;
				let mask = 0;
				for (let r = 0; r < PARTY_ROLE_SUBTYPES.length; r++) {
					if (hasSubtypeInWork(w, PARTY_ROLE_SUBTYPES[r])) {
						mask |= 1 << r;
					}
				}
				if (mask !== 0) roleMasks.push(mask);
			}
			return computePartyCountFromRoleMasks(roleMasks);
		}
		case 'attachmentsOn': {
			const hostWork = amount.target === 'self' ? source : affected;
			const hostId = hostWork.inst.instanceId;
			let total = 0;
			for (const w of workList) {
				if (w.inst.attachedToId !== hostId) continue;
				if (amount.filter && !matchesLayerFilter(amount.filter, w, source, state, workList)) {
					continue;
				}
				total += 1;
			}
			return total;
		}
		// --- End Track P11 ---
		// --- Track P8 ---
		case 'distinctCardTypesInZone': {
			const zones = Array.isArray(amount.zone) ? amount.zone : [amount.zone];
			for (const z of zones) {
				if (z === 'graveyard') layerReads |= READ_GRAVEYARDS;
				else if (z === 'exile') layerReads |= READ_EXILE;
				else if (z === 'hand' || z === 'library' || z === 'command') layerReads |= READ_HIDDEN_ZONES;
			}
			if (zones.length === 1 && zones[0] === 'battlefield') {
				const seen = new Set<string>();
				for (const w of workList) {
					if (amount.whose === 'you' && w.controllerId !== source.controllerId) continue;
					if (amount.whose === 'opponents' && w.controllerId === source.controllerId) continue;
					for (const t of w.types) {
						const norm = t === 'Tribal' ? 'Kindred' : t;
						if (
							norm === 'Artifact' ||
							norm === 'Battle' ||
							norm === 'Creature' ||
							norm === 'Dungeon' ||
							norm === 'Enchantment' ||
							norm === 'Instant' ||
							norm === 'Kindred' ||
							norm === 'Land' ||
							norm === 'Planeswalker' ||
							norm === 'Sorcery'
						) {
							seen.add(norm);
						}
					}
				}
				return seen.size;
			}
			return countDistinctCardTypesInZone(state, source.controllerId, amount.zone, amount.whose);
		}
		case 'count': {
			const f = amount.of;
			const zone = f.zone ?? 'battlefield';
			if (zone === 'battlefield') {
				let total = 0;
				const compareRef = f.sameNameAsAffected ? affected : source;
				for (const w of workList) {
					if (matchesLayerFilter(f, w, source, state, workList, compareRef)) total += 1;
				}
				return total;
			}
			if (zone === 'graveyard') {
				layerReads |= READ_GRAVEYARDS;
				const needsExt = offBattlefieldFilterNeedsExtendedMatch(f);
				let total = 0;
				for (const pl of state.players) {
					if (f.controller === 'you' && pl.playerId !== source.controllerId) continue;
					if (f.controller === 'opponent' && pl.playerId === source.controllerId) continue;
					for (const g of pl.graveyard) {
						if (needsExt) {
							if (
								matchesObjectFilter(g, f, {
									state,
									controllerId: source.controllerId,
									source: source.inst,
									zone: 'graveyard'
								})
							) {
								total += 1;
							}
							continue;
						}
						const gChars = activeCharacteristics(
							effectiveCardForObject(g),
							instanceFaceOptions(g, 'graveyard')
						);
						if (
							f.types?.length &&
							!f.types.some((t) => gChars.types.some((gt) => gt.toLowerCase() === t.toLowerCase()))
						) {
							continue;
						}
						if (
							f.subtypes?.length &&
							!f.subtypes.some((s) =>
								gChars.subtypes.some((gs) => gs.toLowerCase() === s.toLowerCase())
							)
						) {
							continue;
						}
						if (f.ofChosenType) {
							const chosenSub = source.inst.chosenSubType;
							if (
								!chosenSub ||
								!gChars.subtypes.some((gs) => gs.toLowerCase() === chosenSub.toLowerCase())
							) {
								continue;
							}
						}
						if (f.ofChosenColor) {
							const chosenCol = source.inst.chosenColor;
							if (!chosenCol || !gChars.colors.includes(chosenCol)) continue;
						}
						total += 1;
					}
				}
				return total;
			}
			if (zone === 'exile') {
				layerReads |= READ_EXILE;
				const needsExt = offBattlefieldFilterNeedsExtendedMatch(f);
				const srcVer = source.inst.objectVersion ?? 1;
				let total = 0;
				for (const pl of state.players) {
					if (f.controller === 'you' && pl.playerId !== source.controllerId) continue;
					if (f.controller === 'opponent' && pl.playerId === source.controllerId) continue;
					for (const ex of pl.exile) {
						if (f.owner === 'you' && ex.ownerId !== source.controllerId) continue;
						if (f.owner === 'opponent' && ex.ownerId === source.controllerId) continue;
						if (f.exiledWithSelf) {
							if (
								!ex.exiledBy ||
								ex.exiledBy.sourceInstanceId !== source.inst.instanceId ||
								ex.exiledBy.sourceObjectVersion !== srcVer
							) {
								continue;
							}
						}
						if (needsExt) {
							if (
								matchesObjectFilter(ex, f, {
									state,
									controllerId: source.controllerId,
									source: source.inst,
									zone: 'exile'
								})
							) {
								total += 1;
							}
							continue;
						}
						if (f.types?.length || f.notTypes?.length || f.subtypes?.length) {
							const eChars = activeCharacteristics(
								effectiveCardForObject(ex),
								instanceFaceOptions(ex, 'exile')
							);
							if (
								f.types?.length &&
								!f.types.some((t) => eChars.types.some((et) => et.toLowerCase() === t.toLowerCase()))
							) {
								continue;
							}
							if (
								f.notTypes?.length &&
								f.notTypes.some((t) => eChars.types.some((et) => et.toLowerCase() === t.toLowerCase()))
							) {
								continue;
							}
							if (
								f.subtypes?.length &&
								!f.subtypes.some((s) =>
									eChars.subtypes.some((es) => es.toLowerCase() === s.toLowerCase())
								)
							) {
								continue;
							}
						}
						total += 1;
					}
				}
				return total;
			}
			// --- Track P17a ---
			if (zone === 'hand') {
				layerReads |= READ_ZONE_SIZES | READ_HIDDEN_ZONES;
				let total = 0;
				for (const pl of state.players) {
					if (pl.lost) continue;
					if (f.controller === 'you' && pl.playerId !== source.controllerId) continue;
					if (f.controller === 'opponent' && pl.playerId === source.controllerId) continue;
					for (const h of pl.hand) {
						if (
							matchesObjectFilter(h, f, {
								state,
								controllerId: source.controllerId,
								source: source.inst,
								zone: 'hand'
							})
						) {
							total += 1;
						}
					}
				}
				return total;
			}
			// --- End Track P17a ---
			return 0;
		}
		// --- Track P12 ---
		case 'devouredCount':
			return source.inst.devouredCount ?? 0;
		// --- End Track P12 ---
		// --- Track P13 + Track P14 ---
		case 'devotion': {
			let pid = source.controllerId;
			if (amount.player) {
				if (amount.player.k === 'activePlayer') {
					layerReads |= READ_ACTIVE_PLAYER;
					pid = state.players[state.activePlayerIndex]?.playerId ?? '';
				} else if (
					amount.player.k === 'controllerOf' &&
					amount.player.of.k === 'attachedTo' &&
					source.inst.attachedToId
				) {
					const host = workList.find((w) => w.inst.instanceId === source.inst.attachedToId);
					pid = host?.controllerId ?? '';
				} else if (amount.player.k === 'ownerOf' && amount.player.of.k === 'self') {
					pid = source.inst.ownerId;
				}
			}
			return computeWorkListDevotionToColors(workList, pid, amount.colors);
		}
		case 'unlockedDoorsCount': {
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'activePlayer'
					? (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId)
					: source.controllerId;
			let total = 0;
			for (const w of workList) {
				if (w.controllerId !== pid || !hasSubtypeInWork(w, 'Room')) continue;
				total += w.inst.unlockedFaces?.length ?? 0;
			}
			return total;
		}
		case 'colorsAmongPermanents': {
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'activePlayer'
					? (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId)
					: source.controllerId;
			const seen = new Set<ManaColor>();
			for (const w of workList) {
				if (w.controllerId !== pid) continue;
				if (amount.filter && !matchesLayerFilter(amount.filter, w, source, state, workList)) {
					continue;
				}
				for (const c of w.colors) seen.add(c);
			}
			return seen.size;
		}
		case 'half': {
			const inner = evaluateLayerAmount(amount.of, state, workList, source, affected);
			return amount.round === 'up' ? Math.ceil(inner / 2) : Math.floor(inner / 2);
		}
		case 'dungeonsCompleted': {
			layerReads |= READ_P13;
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'activePlayer'
					? (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId)
					: source.controllerId;
			const pl = state.players.find((p) => p.playerId === pid);
			return pl?.dungeonsCompletedCount ?? 0;
		}
		case 'colorsOfObject': {
			if (amount.of === 'affected') {
				return affected.colors.length;
			}
			if (amount.of === 'attachedTo') {
				if (source.inst.attachedToId === affected.inst.instanceId) {
					return affected.colors.length;
				}
				const host = workList.find((w) => w.inst.instanceId === source.inst.attachedToId);
				return host?.colors.length ?? 0;
			}
			return source.colors.length;
		}
		case 'greatestStatAmong':
		case 'totalStatAmong':
		case 'totalStatOf': {
			const z = amount.filter.zone ?? 'battlefield';
			if (z === 'battlefield') {
				let best = 0;
				let found = false;
				let sum = 0;
				for (let i = 0; i < workList.length; i++) {
					const w = workList[i];
					if (!matchesLayerFilter(amount.filter, w, source, state, workList)) continue;
					let val: number | null = null;
					if (amount.stat === 'manaValue') {
						val = w.manaValue;
					} else if (amount.stat === 'power') {
						val = w.types.includes('Creature') ? (w.workingPower ?? 0) : null;
					} else if (amount.stat === 'toughness') {
						val = w.types.includes('Creature') ? (w.workingToughness ?? 0) : null;
					}
					if (val === null) continue;
					if (!found || val > best) {
						best = val;
						found = true;
					}
					if (val > 0) sum += val;
				}
				if (amount.k === 'greatestStatAmong') return found ? Math.max(0, best) : 0;
				return sum;
			}
			if (z === 'graveyard') layerReads |= READ_GRAVEYARDS;
			else if (z === 'exile') layerReads |= READ_EXILE;
			else layerReads |= READ_HIDDEN_ZONES;
			return (
				evaluateWave5Amount(
					amount.k === 'totalStatAmong'
						? { k: 'totalStatOf', stat: amount.stat, filter: amount.filter }
						: amount,
					{
						state,
						controllerId: source.controllerId,
						source: source.inst
					}
				) ?? 0
			);
		}
		// --- End Track P13 + Track P14 ---
		// --- Track P15 ---
		case 'playerSpeed': {
			layerReads |= READ_P15;
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			const pid =
				amount.player.k === 'you'
					? source.controllerId
					: (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId);
			const p = state.players.find((pl) => pl.playerId === pid);
			return p?.speed ?? 0;
		}
		case 'gravestormCount':
			layerReads |= READ_P15;
			return state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0;
		// --- End Track P15 ---
		// --- Track P17b ---
		case 'p17bMetric':
			layerReads |=
				READ_P17B |
				READ_ALL_COUNTERS |
				READ_GRAVEYARDS |
				READ_HIDDEN_ZONES |
				READ_COMBAT |
				READ_LIFE |
				READ_ACTIVE_PLAYER;
			return evaluateP17bAmount(
				amount,
				{ state, controllerId: source.controllerId, source: source.inst },
				matchesObjectFilter
			);
		// --- End Track P17b ---
		// --- Track P16a ---
		case 'playerCounters': {
			layerReads |= READ_P16A;
			if (amount.player.k === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			// --- Track P22a ---
			if (amount.players) {
				layerReads |= READ_P22A;
				if (amount.players === 'defendingPlayer') layerReads |= READ_COMBAT;
				return evaluatePlayerCountersAmountWave8(
					state,
					source.controllerId,
					amount.counter,
					amount.player.k,
					amount.players,
					source.inst
				);
			}
			// --- End Track P22a ---
			const pid =
				amount.player.k === 'activePlayer'
					? (state.players[state.activePlayerIndex]?.playerId ?? source.controllerId)
					: source.controllerId;
			const p = state.players.find((pl) => pl.playerId === pid);
			if (!p) return 0;
			if (amount.counter === 'poison') return p.poison ?? 0;
			if (amount.counter === 'experience') return p.experienceCounters ?? 0;
			if (amount.counter === 'energy') return p.energyCounters ?? 0;
			if (amount.counter === 'rad') return p.radCounters ?? 0;
			if (amount.counter === 'ticket') return p.ticketCounters ?? 0;
			return 0;
		}
		// --- End Track P16a ---
		// --- Track P20a ---
		case 'manaSpentToCast':
			layerReads |= READ_P20A;
			return source.inst.manaSpentCount ?? 0;
		case 'chosenPlayerZoneCount': {
			layerReads |= READ_P20A | READ_ZONE_SIZES;
			if (amount.zone === 'graveyard') layerReads |= READ_GRAVEYARDS;
			else if (amount.zone === 'exile') layerReads |= READ_EXILE;
			else if (amount.zone !== 'battlefield') layerReads |= READ_HIDDEN_ZONES;
			if (amount.zone === 'battlefield') {
				const chosenPid = source.inst.chosenPlayerId;
				if (!chosenPid) return 0;
				let count = 0;
				for (const w of workList) {
					if (w.controllerId !== chosenPid) continue;
					if (amount.filter && !matchesLayerFilter(amount.filter, w, source, state, workList)) {
						continue;
					}
					count++;
				}
				return count;
			}
			return evaluateChosenPlayerZoneCount(
				state,
				source.inst,
				source.controllerId,
				amount.zone,
				amount.filter
			);
		}
		case 'opponentsWithLifeLessThanHalfStarting':
			layerReads |= READ_P20A | READ_LIFE;
			return countOpponentsWithLifeLessThanHalfStarting(state, source.controllerId);
		// --- End Track P20a ---
		// --- Track P20b ---
		case 'p20bCostPaidCount':
			layerReads |= READ_P20B;
			return evaluateP20bAmount(amount, {
				state,
				controllerId: source.controllerId,
				source: source.inst
			});
		// --- End Track P20b ---
		// --- Track P22a ---
		case 'distinctNamesCount': {
			const zone = amount.of.zone ?? 'battlefield';
			if (zone === 'battlefield') {
				const names = new Set<string>();
				for (const w of workList) {
					if (w.isFaceDown) continue;
					if (!matchesLayerFilter(amount.of, w, source, state, workList)) continue;
					const nm = w.name.trim();
					if (nm) names.add(nm);
				}
				return names.size;
			}
			layerReads |= READ_P22A | READ_ZONE_SIZES;
			if (zone === 'graveyard') layerReads |= READ_GRAVEYARDS;
			else if (zone === 'exile') layerReads |= READ_EXILE;
			else layerReads |= READ_HIDDEN_ZONES;
			return evaluateDistinctNamesFilterCountWave8(
				state,
				source.controllerId,
				amount.of,
				source.inst
			);
		}
		case 'creaturesDiedThisTurn':
			layerReads |= READ_P22A;
			return evaluateCreaturesDiedThisTurnWave8(state, source.controllerId, amount.controller);
		case 'spellsCastThisTurnCount':
			layerReads |= READ_P22A | READ_P12;
			if (amount.who === 'activePlayer') layerReads |= READ_ACTIVE_PLAYER;
			return evaluateSpellsCastThisTurnWave8(
				state,
				source.controllerId,
				amount.filter,
				amount.who
			);
		// --- End Track P22a ---
		default: {
			const w9 = evaluateLayerAmountWave9(amount, state, workList, source, affected);
			if (w9 !== null) return w9;
			return 0;
		}
	}
}

export function evaluateLayerCondition(
	cond: Condition,
	state: GameState,
	workList: PermWorkState[],
	source: PermWorkState,
	affected: PermWorkState,
	workMap?: Map<string, PermWorkState>
): boolean {
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) =>
				evaluateLayerCondition(c, state, workList, source, affected, workMap)
			);
		case 'or':
			return cond.of.some((c) =>
				evaluateLayerCondition(c, state, workList, source, affected, workMap)
			);
		case 'not':
			return !evaluateLayerCondition(cond.of, state, workList, source, affected, workMap);
		case 'isTurnOf': {
			layerReads |= READ_ACTIVE_PLAYER;
			const activePlayer = state.players[state.activePlayerIndex];
			return activePlayer?.playerId === source.controllerId;
		}
		case 'compare': {
			const left = evaluateLayerAmount(cond.left, state, workList, source, affected);
			const right = evaluateLayerAmount(cond.right, state, workList, source, affected);
			switch (cond.op) {
				case '=':
					return left === right;
				case '>=':
					return left >= right;
				case '<=':
					return left <= right;
				case '>':
					return left > right;
				case '<':
					return left < right;
			}
			return false;
		}
		case 'graveyardAbove':
			return false;
		case 'controlCommander':
			return workList.some(
				(w) => w.controllerId === source.controllerId && Boolean(w.inst.isCommander)
			);
		case 'kicked':
			return evaluateKickerCondition(cond, {
				count: source.inst.kickedCount ?? 0,
				tags: source.inst.kickedTags ?? [],
				...(source.inst.kickedTagCounts ? { tagCounts: source.inst.kickedTagCounts } : {})
			});
		case 'evoked':
			return Boolean(source.inst.evoked);
		case 'escaped':
			return Boolean(source.inst.escaped);
		case 'isMonarch': {
			layerReads |= READ_MONARCH;
			const monarchId = state.monarchPlayerId ?? null;
			if (!monarchId) return false;
			if (cond.player) {
				if (cond.player.k === 'you') return monarchId === source.controllerId;
				if (cond.player.k === 'activePlayer') {
					layerReads |= READ_ACTIVE_PLAYER;
					return monarchId === state.players[state.activePlayerIndex]?.playerId;
				}
				return false;
			}
			const rel = cond.relation ?? 'you';
			if (rel === 'you') return monarchId === source.controllerId;
			if (rel === 'opponent') return monarchId !== source.controllerId;
			return true;
		}
		case 'foretold':
			return Boolean(source.inst.foretold);
		case 'blitzed':
			return Boolean(source.inst.blitzed);
		case 'saddled':
			return Boolean(source.inst.saddledThisTurn);
		// --- Track P4 ---
		case 'exertedThisTurn':
			return Boolean(source.inst.exertedThisTurn);
		// --- Track P5 ---
		case 'monstrous':
			return Boolean(source.inst.isMonstrous);
		// --- Track P7 ---
		case 'creatureDiedThisTurn':
			layerReads |= READ_TURN_HISTORY;
			return Boolean(state.creatureDiedThisTurn);
		case 'attackedThisTurn': {
			layerReads |= READ_TURN_HISTORY;
			const ctrl = state.players.find((p) => p.playerId === source.controllerId);
			return Boolean(ctrl?.attackedThisTurn);
		}
		case 'permanentLeftBattlefieldThisTurn': {
			layerReads |= READ_TURN_HISTORY;
			const ctrl = state.players.find((p) => p.playerId === source.controllerId);
			return Boolean(ctrl?.permanentLeftBattlefieldThisTurn);
		}
		case 'gainedLifeThisTurn': {
			layerReads |= READ_TURN_HISTORY;
			const ctrl = state.players.find((p) => p.playerId === source.controllerId);
			const min = cond.min ? evaluateLayerAmount(cond.min, state, workList, source, affected) : 1;
			return (ctrl?.lifeGainedThisTurn ?? 0) >= min;
		}
		case 'wasCast': {
			if (!source.inst.wasCast) return false;
			if (cond.fromHand) return source.inst.castFromZone === 'hand';
			return true;
		}
		// --- Track P8 ---
		case 'opponentCount': {
			const oppCount = state.players.filter(
				(p) => !p.lost && p.playerId !== source.controllerId
			).length;
			return compareNumbers(oppCount, cond.op, cond.count);
		}
		case 'anyPlayerLife': {
			layerReads |= READ_LIFE;
			return state.players.some((p) => !p.lost && compareNumbers(p.life, cond.op, cond.count));
		}
		case 'distinctControlledCreaturePowers': {
			const powers = new Set<number>();
			for (const w of workList) {
				if (w.controllerId !== source.controllerId) continue;
				if (!w.types.includes('Creature')) continue;
				powers.add(w.workingPower ?? 0);
			}
			return powers.size >= cond.count;
		}
		case 'objectState': {
			const subj =
				cond.of === 'self'
					? source
					: source.inst.attachedToId
						? (workMap?.get(source.inst.attachedToId) ??
							workList.find((w) => w.inst.instanceId === source.inst.attachedToId))
						: undefined;
			if (!subj) return false;
			if (cond.tapped !== undefined) {
				layerReads |= READ_TAPPED;
				if (Boolean(subj.inst.tapped) !== cond.tapped) return false;
			}
			if (cond.attacking !== undefined) {
				layerReads |= READ_COMBAT;
				const isAtk = state.combat.attackers.some((a) => a.attackerInstanceId === subj.inst.instanceId);
				if (isAtk !== cond.attacking) return false;
			}
			if (cond.blocking !== undefined) {
				layerReads |= READ_COMBAT;
				const isBlk = state.combat.attackers.some((a) =>
					a.blockerInstanceIds.includes(subj.inst.instanceId)
				);
				if (isBlk !== cond.blocking) return false;
			}
			if (cond.monstrous !== undefined && Boolean(subj.inst.isMonstrous) !== cond.monstrous) {
				return false;
			}
			if (cond.saddled !== undefined && Boolean(subj.inst.saddledThisTurn) !== cond.saddled) {
				return false;
			}
			if (cond.equipped !== undefined) {
				const isEq = workList.some(
					(w) =>
						w.inst.attachedToId === subj.inst.instanceId &&
						w.types.includes('Artifact') &&
						w.subtypes.includes('Equipment')
				);
				if (isEq !== cond.equipped) return false;
			}
			if (cond.enchanted !== undefined) {
				const isEnch = workList.some(
					(w) =>
						w.inst.attachedToId === subj.inst.instanceId &&
						w.types.includes('Enchantment') &&
						w.subtypes.includes('Aura')
				);
				if (isEnch !== cond.enchanted) return false;
			}
			if (cond.filter && !matchesLayerFilter(cond.filter, subj, source, state, workList)) {
				return false;
			}
			return true;
		}
		// --- Track P10 ---
		case 'opponentLostLifeThisTurn':
		case 'descendedThisTurn':
		case 'hadCounterOnIt':
		case 'manaColorSpentToCast':
		case 'opponentComparison':
			layerReads |= READ_P10_SUSPECT;
			if (cond.k === 'opponentComparison' && cond.metric === 'life') {
				layerReads |= READ_LIFE;
			}
			return evaluateP10Condition(cond, {
				state,
				controllerId: source.controllerId,
				source: source.inst
			});
		// --- End Track P10 ---
		// --- Track P9 ---
		// --- Track P12 ---
		case 'classLevelIs':
			return (source.inst.classLevel ?? 1) === cond.level;
		case 'classLevelAtLeast':
			return (source.inst.classLevel ?? 1) >= cond.level;
		case 'caseSolved':
			return Boolean(source.inst.isSolved);
		case 'caseUnsolved':
			return !source.inst.isSolved;
		case 'isRenowned':
			return Boolean(source.inst.isRenowned);
		case 'boastAttackedThisTurn':
			return Boolean(source.inst.creatureAttackedThisTurn);
		case 'exhaustUnused':
			return !source.inst.exhaustedAbilityIds?.includes(cond.abilityId);
		case 'creaturesAttackedCountThisTurn':
			layerReads |= READ_P12;
			return (state.creaturesAttackedCountThisTurn ?? 0) >= cond.min;
		case 'totalPowerControlled': {
			let sum = 0;
			for (const w of workList) {
				if (w.controllerId === source.controllerId && w.types.includes('Creature')) {
					sum += Math.max(0, w.workingPower ?? 0);
				}
			}
			return sum >= cond.min;
		}
		case 'colorsAmongControlledPermanents': {
			const cSet = new Set<ManaColor>();
			for (const w of workList) {
				if (w.controllerId === source.controllerId) {
					for (const c of w.colors) cSet.add(c);
				}
			}
			return cSet.size >= cond.min;
		}
		case 'sourcesDealtDamageThisTurn': {
			layerReads |= READ_P12;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			return (p?.sourcesDealtDamageIdsThisTurn?.length ?? 0) >= cond.min;
		}
		case 'cardsPutIntoGraveyardFromAnywhereThisTurn':
			layerReads |= READ_P12;
			return (state.cardsPutIntoGraveyardThisTurn ?? 0) >= cond.min;
		case 'spellsCastThisTurnCount': {
			layerReads |= READ_P12;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			if (!p) return false;
			if (!cond.filter) return (p.spellsCastThisTurn ?? 0) >= cond.min;
			const cards = p.spellsCastThisTurnCards ?? [];
			let count = 0;
			for (const card of cards) {
				const stub: CardInstance = {
					instanceId: 'cast-hist',
					card,
					ownerId: p.playerId,
					controllerId: p.playerId,
					zone: 'stack',
					tapped: false,
					summoningSick: false,
					damageMarked: 0,
					deathtouchDamageMarked: false,
					counters: {} as CardInstance['counters'],
					tempPowerMod: 0,
					tempToughnessMod: 0,
					grantedKeywords: [],
					attachedToId: null,
					isToken: false,
					isCommander: false,
					commanderCastCount: 0,
					usedLoyaltyThisTurn: false,
					transformed: false
				};
				if (matchesObjectFilter(stub, cond.filter, { state, controllerId: source.controllerId, source: source.inst })) {
					count++;
				}
			}
			return count >= cond.min;
		}
		// --- End Track P12 ---
		// --- Track P13 ---
		case 'selfInZone':
		case 'spellsCastLastTurn':
		case 'hasCompletedDungeon':
		case 'hasInitiative':
		case 'hasCitysBlessing':
		case 'hasMaxSpeed':
		case 'opponentPoisonAtLeast':
		case 'nonlandEnteredThisTurn':
		case 'voidThisTurn':
		case 'sameColorManaSpentAtLeast':
			layerReads |= READ_P13;
			return (
				evaluateP13Condition(cond, {
					state,
					controllerId: source.controllerId,
					source: source.inst,
					zone: source.inst.zone
				}) ?? false
			);
		// --- End Track P13 ---
		// --- Track P14 ---
		case 'anyOpponentMetric': {
			if (cond.metric === 'life') layerReads |= READ_LIFE;
			else layerReads |= READ_ZONE_SIZES;
			return (
				evaluateWave5Condition(cond, {
					state,
					controllerId: source.controllerId,
					source: source.inst
				}) ?? false
			);
		}
		case 'cardsDrawnThisTurnAtLeast':
		case 'nthMatchingSpellThisTurn': {
			layerReads |= READ_P14;
			return (
				evaluateWave5Condition(cond, {
					state,
					controllerId: source.controllerId,
					source: source.inst
				}) ?? false
			);
		}
		// --- End Track P14 ---
		// --- Track P15 ---
		case 'maxSpeed': {
			layerReads |= READ_P15;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			return (p?.speed ?? 0) >= 4;
		}
		case 'citysBlessing': {
			layerReads |= READ_P15;
			const p = state.players.find((pl) => pl.playerId === source.controllerId);
			return Boolean(p?.hasCitysBlessing);
		}
		case 'giftPromised':
			return Boolean(source.inst.giftPromised);
		case 'isDay':
			layerReads |= READ_P15;
			return state.dayNight === 'day';
		case 'isNight':
			layerReads |= READ_P15;
			return state.dayNight === 'night';
		case 'isYourTurn': {
			layerReads |= READ_ACTIVE_PLAYER;
			return state.players[state.activePlayerIndex]?.playerId === source.controllerId;
		}
		case 'selfPrepared':
			return Boolean(source.inst.isPrepared);
		case 'isImpending':
			return Boolean(source.inst.castWithImpending) && (source.inst.counters.time || 0) > 0;
		case 'enteredWithXAtLeast':
			return (source.inst.enteredWithX ?? 0) >= cond.n;
		// --- End Track P15 ---
		// --- Wave 6 Shared ---
		case 'isPaired':
			return Boolean(source.inst.pairedWithId);
		case 'tributePaid':
			return Boolean(source.inst.tributePaid);
		case 'hasEnduringStory':
			// --- Track P18a ---
			layerReads |= READ_P18A;
			return Boolean(
				source.inst.hasEnduringStory ||
					state.players.find((pl) => pl.playerId === source.controllerId)?.hasEnduringStory
			);
		// --- End Track P18a ---
		case 'isHarnessed':
			return Boolean(source.inst.isHarnessed);
		// --- End Wave 6 Shared ---
		// --- Track P16b ---
		case 'attackingTotalPowerAtLeast':
			layerReads |= READ_COMBAT | READ_P16B;
			return (
				evaluateP16bCondition(
					cond,
					{ state, controllerId: source.controllerId, source: source.inst },
					matchesObjectFilter
				) ?? false
			);
		case 'firstCombatPhaseOfTurn':
		case 'eventPlayerHandCount':
		case 'notEventPlayerTurn':
		case 'cardLeftYourGraveyardThisTurn':
		case 'committedCrimeThisTurn':
		case 'controlledByOtherThanOwner':
		case 'youLostLifeThisTurn':
		case 'playerLostLifeAtLeastThisTurn':
		case 'moreCardsInHandThanEachOpponent':
		case 'eventObjectMatchedLki':
			layerReads |= READ_P16B | READ_ACTIVE_PLAYER;
			return (
				evaluateP16bCondition(
					cond,
					{ state, controllerId: source.controllerId, source: source.inst },
					matchesObjectFilter
				) ?? false
			);
		// --- End Track P16b ---
		// --- Track P17b ---
		case 'p17bCondition':
			layerReads |=
				READ_P17B |
				READ_ALL_COUNTERS |
				READ_GRAVEYARDS |
				READ_HIDDEN_ZONES |
				READ_COMBAT |
				READ_LIFE |
				READ_ACTIVE_PLAYER;
			return evaluateP17bCondition(
				cond,
				{ state, controllerId: source.controllerId, source: source.inst },
				matchesObjectFilter
			);
		// --- End Track P17b ---
		// --- Track P18b ---
		case 'anchorWordChosen':
			layerReads |= READ_P18B;
			return (source.inst.chosenAnchorWord ?? '').trim().toLowerCase() === cond.word.trim().toLowerCase();
		case 'youWereAttackedThisCombat':
			layerReads |= READ_COMBAT;
			return Boolean(
				state.combat.active &&
					state.combat.attackers.some(
						(a) =>
							a.defenderPlayerId === source.controllerId &&
							!a.defenderPlaneswalkerId &&
							!a.defenderBattleId
					)
			);
		// --- End Track P18b ---
		// --- Track P20a ---
		case 'lifeCompareHalfStarting':
			layerReads |= READ_P20A | READ_LIFE;
			return evaluateLifeCompareHalfStarting(state, source.controllerId, cond.who, cond.op);
		case 'mostCommonColorAmongPermanents': {
			layerReads |= READ_P20A;
			const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
			for (const w of workList) {
				for (const c of w.colors) {
					if (c === 'W' || c === 'U' || c === 'B' || c === 'R' || c === 'G') {
						counts[c] += 1;
					}
				}
			}
			return evaluateMostCommonColorFromCounts(counts, cond.color, cond.allowTie);
		}
		// --- End Track P20a ---
		// --- Track P20b ---
		case 'p20bCondition':
			layerReads |= READ_P20B | READ_HIDDEN_ZONES | READ_ACTIVE_PLAYER;
			return evaluateP20bCondition(
				cond,
				{ state, controllerId: source.controllerId, source: source.inst },
				matchesObjectFilter
			);
		// --- End Track P20b ---
		// --- Track P22a ---
		case 'lifeAtLeastAboveStarting':
			layerReads |= READ_P22A | READ_LIFE;
			return evaluateWave8Condition(cond, state, source.controllerId, source.inst) ?? false;
		case 'isAttackingAlone':
			layerReads |= READ_P22A | READ_COMBAT;
			return evaluateWave8Condition(cond, state, source.controllerId, source.inst) ?? false;
		case 'hasntDealtDamageYet':
			layerReads |= READ_P22A;
			return evaluateWave8Condition(cond, state, source.controllerId, source.inst) ?? false;
		case 'yourTurnsTakenAtLeast':
			layerReads |= READ_P22A | READ_ACTIVE_PLAYER;
			return evaluateWave8Condition(cond, state, source.controllerId, source.inst) ?? false;
		case 'enteredBattlefieldUnderYourControlThisTurn':
			layerReads |= READ_P22A;
			return evaluateWave8Condition(cond, state, source.controllerId, source.inst) ?? false;
		// --- End Track P22a ---
		default:
			return false;
	}
}

function hasAttachmentAbilityStrippingStatic(statics: StaticDef[]): boolean {
	for (const st of statics) {
		if (st.k !== 'continuous' || st.affected !== 'attachedTo') continue;
		if (
			st.layer === '4' &&
			st.mod.k === 'setTypes' &&
			st.mod.types.includes('Land') &&
			(st.mod.subtypes ?? []).some((sub) => BASIC_LAND_SUBTYPES.has(sub))
		) {
			return true;
		}
	}
	return false;
}

export function getAttachedAbilityStrippingAuraSources(
	stateOrSnap: GameState | BoardSnapshot,
	targetInstanceId: string,
	visited = new Set<string>()
): string[] {
	if (visited.has(targetInstanceId)) return [];
	visited.add(targetInstanceId);
	const snap = 'fingerprint' in stateOrSnap ? stateOrSnap : getBoardSnapshot(stateOrSnap);
	const attached = snap.attachedTo.get(targetInstanceId);
	if (!attached || attached.length === 0) return [];

	const sources: string[] = [];
	for (const entry of attached) {
		if (entry.perm.isFaceDown) continue;
		const abilities = activeAbilityDefs(entry.card, instanceFaceOptions(entry.perm, 'battlefield'));
		const statics = abilities
			.filter((a): a is { kind: 'static'; static: StaticDef; span: Span } => a.kind === 'static')
			.map((a) => a.static);
		if (!hasAttachmentAbilityStrippingStatic(statics)) continue;
		if (getAttachedAbilityStrippingAuraSources(snap, entry.perm.instanceId, visited).length > 0) {
			continue;
		}
		sources.push(entry.card.name);
	}
	return sources;
}

export const READ_TAPPED = 1n << 0n;
export const READ_LIFE = 1n << 1n;
export const READ_ZONE_SIZES = 1n << 2n;
export const READ_GRAVEYARDS = 1n << 3n;
export const READ_ACTIVE_PLAYER = 1n << 4n;
export const READ_COMMANDER_CAST_COUNT = 1n << 5n;
export const READ_EXILE = 1n << 6n;
export const READ_ENERGY = 1n << 7n;
export const READ_MONARCH = 1n << 8n;
// --- Track P8 ---
export const READ_COMBAT = 1n << 9n;
export const READ_ALL_COUNTERS = 1n << 10n;
export const READ_HIDDEN_ZONES = 1n << 11n;
// --- Track P7 ---
export const READ_TURN_HISTORY = 1n << 12n;
// --- Track P10 ---
export const READ_P10_SUSPECT = 1n << 13n;
// --- End Track P10 ---
// --- Track P11 ---
export const READ_KEYWORD_COUNTERS = 1n << 14n;
export const READ_CHOSEN_CARD_NAME = 1n << 15n;
// --- End Track P11 ---
// --- Track P12 ---
export const READ_P12 = 1n << 16n;
// --- End Track P12 ---
// --- Track P13 ---
export const READ_P13 = 1n << 17n;
// --- End Track P13 ---
// --- Track P14 ---
export const READ_P14 = 1n << 18n;
// --- End Track P14 ---
// --- Track P15 ---
export const READ_P15 = 1n << 19n;
// --- End Track P15 ---
// --- Track P16a ---
export const READ_P16A = 1n << 20n;
// --- End Track P16a ---
// --- Track P16b ---
export const READ_P16B = 1n << 21n;
// --- End Track P16b ---
// --- Track P17a ---
export const READ_P17A = 1n << 22n;
const NON_STANDARD_PT_COUNTER_RE = /^([+-]\d+)\/([+-]\d+)$/;

export function sumNonStandardPtCountersInLayer(counters: Record<string, number> | undefined): {
	power: number;
	toughness: number;
	entries: Array<[string, number]>;
} {
	let power = 0;
	let toughness = 0;
	const entries: Array<[string, number]> = [];
	if (!counters) return { power, toughness, entries };
	for (const key of Object.keys(counters)) {
		if (key === '+1/+1' || key === '-1/-1') continue;
		const count = counters[key];
		if (!count || count <= 0) continue;
		const m = NON_STANDARD_PT_COUNTER_RE.exec(key);
		if (!m) continue;
		const dp = Number.parseInt(m[1], 10);
		const dt = Number.parseInt(m[2], 10);
		if (!Number.isFinite(dp) || !Number.isFinite(dt)) continue;
		power += dp * count;
		toughness += dt * count;
		entries.push([key, count]);
	}
	if (entries.length > 1) entries.sort((a, b) => a[0].localeCompare(b[0]));
	return { power, toughness, entries };
}
// --- End Track P17a ---
// --- Track P17b ---
export const READ_P17B = 1n << 23n;
// --- End Track P17b ---
// --- Track P18a ---
export const READ_P18A = 1n << 24n;
// --- End Track P18a ---
// --- Track P18b ---
export const READ_P18B = 1n << 25n;
// --- End Track P18b ---
// --- Track P19a ---
export const READ_P19A = 1n << 26n;
// --- End Track P19a ---
// --- Track P20a ---
export const READ_P20A = 1n << 28n;
// --- End Track P20a ---
// --- Track P20b ---
export const READ_P20B = 1n << 29n;
// --- End Track P20b ---
// --- Track P22a ---
export const READ_P22A = 1n << 31n;
// --- End Track P22a ---
// --- Track P22b ---
export const READ_P22B = 1n << 27n;
// --- End Track P22b ---
// --- Track P22c ---
export const READ_P22C = 1n << 30n;
// --- End Track P22c ---
// --- Wave 12 ---
export const READ_WAVE9_MANA = 1n << 32n;
export const READ_WAVE9_ATTACKS = 1n << 33n;
export const READ_WAVE9_DYNAMIC = 1n << 34n;
// --- End Wave 12 ---

/** Inputs read by the evaluation in progress (bigint bitmask above; supports >32 flags). */
let layerReads = 0n;

export function noteLayerRead(flag: bigint): void {
	layerReads |= flag;
}

export function getLayerReads(): bigint {
	return layerReads;
}

export function resetLayerReads(value = 0n): void {
	layerReads = value;
}

export interface ExtraLayerReadHook {
	flag: bigint;
	read: (state: GameState) => unknown;
}

let extraLayerReadHook: ExtraLayerReadHook | null = null;

export function setExtraLayerReadHookForTest(hook: ExtraLayerReadHook | null): void {
	extraLayerReadHook = hook;
}

export function getExtraLayerReadHook(): ExtraLayerReadHook | null {
	return extraLayerReadHook;
}

