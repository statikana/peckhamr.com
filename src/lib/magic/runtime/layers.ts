/**
 * Phase 6: Continuous-effect layer engine (CR 613) evaluated from compiled IR, with caching.
 *
 * Reads only the compiled `CardDefinition` (`compileCard`) and `CardInstance` state on the board —
 * never raw rules text or card names. Results for all active battlefield permanents are computed in
 * layer order (1, 4, 5, 6, 7a, 7b, 7c, 7d) and memoised on the `BoardSnapshot` from `layerCache.ts`.
 */
import { compileCard } from '../compiler/index.ts';
import { getKeywordSpec, KEYWORD_LABELS } from '../keywords.ts';
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
	PlayerGameState,
	ScryfallCard,
	TimedContinuousEffect,
	TimedKeywordEffect
} from '../types.ts';
import {
	activeAbilityDefs,
	activeCharacteristics,
	instanceFaceOptions,
	matchesColorFilter,
	resolveObjectFaces,
	type ResolveObjectFacesOptions
} from './faces.ts';
import {
	// --- Track P7 ---
	activeTimedLayer1aForPermanent,
	// --- End Track P7 ---
	boardSnapshotMatches,
	buildBoardSnapshot,
	crossCheckLayerResult,
	getBoardSnapshot,
	layerCacheCheckEnabled,
	scopeTrust,
	verifyScopeTrust,
	type BoardSnapshot
} from './layerCache.ts';
import { evaluateKickedCountAmount, evaluateKickerCondition } from './kicker.ts';
import { evaluateAmount, matchesObjectFilter, playerCommanderCastCount } from './objectFilter.ts';
// --- Track P8 ---
import { compareNumbers, countDistinctCardTypesInZone } from './staticsLayersAndRestrictions.ts';
// --- Track P10 ---
import { evaluateP10Condition, resolveQuotedAbilityDefs } from './reflexiveManaAndActions.ts';
// --- End Track P10 ---
import { PROTECTION_KEYWORD_BY_COLOR } from './tuckFreezeChosen.ts';
// --- Track P12 ---
import { collectBackupGrantedAbilityDefs } from './keywordsWave4.ts';
// --- End Track P12 ---
// --- Track P11 ---
import {
	KEYWORD_COUNTER_TYPES,
	PARTY_ROLE_SUBTYPES,
	computeKeywordCounterMask,
	computePartyCountFromRoleMasks
} from './staticsDynamicAndCosts.ts';
// --- End Track P11 ---
// --- Track P13 ---
import { evaluateP13Condition } from './effectsWave5.ts';
// --- End Track P13 ---
// --- Track P14 ---
import {
	cardHasGraveyardContinuousStatic,
	collectGraveyardContinuousStaticsForPlayer,
	computeWorkListDevotionToColors,
	evaluateWave5Amount,
	evaluateWave5Condition,
	type ProtectionAttachmentExemptionInfo
} from './staticsAndCostsWave5.ts';
// --- End Track P14 ---

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
function lowerSubtypesOf(typeLine: string): Set<string> | null {
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

function normalizeSubtypes(subs: readonly string[]): string[] {
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

const BASIC_LAND_MANA_BY_SUBTYPE: Record<string, { subtype: string; sym: string }> = {
	plains: { subtype: 'Plains', sym: 'W' },
	island: { subtype: 'Island', sym: 'U' },
	swamp: { subtype: 'Swamp', sym: 'B' },
	mountain: { subtype: 'Mountain', sym: 'R' },
	forest: { subtype: 'Forest', sym: 'G' }
};

const BASIC_LAND_SUBTYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

const LAND_SUBTYPES = new Set([
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

const NON_CREATURE_SUBTYPES = new Set([
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

function sortGrantedKeywords(keywords: readonly string[]): string[] {
	return [...keywords].sort((a, b) => {
		const idxA = KEYWORD_ORDER.get(a.toLowerCase()) ?? 999;
		const idxB = KEYWORD_ORDER.get(b.toLowerCase()) ?? 999;
		return idxA - idxB;
	});
}

function formatKeywordLabel(kw: string): string {
	const low = kw.trim().toLowerCase();
	if (KEYWORD_LABELS[low]) return KEYWORD_LABELS[low];
	if (low.startsWith('protection from ')) {
		return `Protection from ${kw.trim().slice('protection from '.length)}`;
	}
	if (low.startsWith('hexproof from ')) {
		return `Hexproof from ${kw.trim().slice('hexproof from '.length)}`;
	}
	if (low.startsWith('ward ')) {
		return `Ward ${kw.trim().slice(5).trim()}`;
	}
	// --- Track P9 ---
	if (low.startsWith('toxic ')) {
		return `Toxic ${kw.trim().slice(6).trim()}`;
	}
	return kw.charAt(0).toUpperCase() + kw.slice(1);
}

function addSubtypeToTypeLine(typeLine: string, subtype: string): string {
	if (new RegExp(`\\b${subtype}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		return `${typeLine} ${subtype}`;
	}
	return `${typeLine} — ${subtype}`;
}

function addCardTypeToTypeLine(typeLine: string, cardType: string): string {
	if (new RegExp(`\\b${cardType}\\b`, 'i').test(typeLine)) return typeLine;
	if (typeLine.includes('—')) {
		const [left, right] = typeLine.split('—');
		return `${left.trim()} ${cardType} — ${right.trim()}`;
	}
	return `${typeLine.trim()} ${cardType}`;
}

function formatSignedDelta(dp: number, dt: number): string {
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
			k === 'toxic'
				? `toxic::${results.length}`
				: k === 'protection' ||
					  k === 'ward' ||
					  k === 'afterlife' ||
					  k === 'bushido' ||
					  k === 'annihilator' ||
					  k === 'affinity' ||
					  k === 'modular' ||
					  k === 'soulshift' ||
					  k === 'fabricate' ||
					  k === 'bloodthirst'
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

function innateKeywordsAndAbilitiesOf(
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

interface PermWorkState {
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
	abilityRemovalEvents: Array<{ sourceName: string; timestamp: number }>;
	layer7bSetters: Array<{
		sourceName: string;
		power?: number | null;
		toughness?: number | null;
		timestamp: number;
	}>;
	items: AttributedKeywordOrEffect[];
	itemTimestamps: Map<string, number>;
	statics: StaticDef[];
	grantsKeywordViaAbility: Set<string>;
	strippedByAttachment: boolean;
}

function recordAbilityRemoval(work: PermWorkState, sourceName: string, timestamp: number): void {
	if (!work.allAbilityRemovalSources.includes(sourceName)) {
		work.allAbilityRemovalSources.push(sourceName);
	}
	if (
		!work.abilityRemovalEvents.some(
			(e) => e.sourceName === sourceName && e.timestamp === timestamp
		)
	) {
		work.abilityRemovalEvents.push({ sourceName, timestamp });
	}
}

interface GrantedAbilityMeta {
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
	grantSourceCard?: ScryfallCard;
	grantSourceId?: string;
}

const ZERO_SPAN: Span = { start: 0, end: 0 };

function makeIntrinsicBasicManaAbility(sym: ManaColor): ActivatedAbility {
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

function describeGrantedActivatedAbility(
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

function grantItem(
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
		(keyLow === 'protection' && Boolean(grantMeta?.protectionExemption))
		// --- End Track P14 ---
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

function lookupStaticLocator(
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

function grantNonActivatedAbility(
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
	}
	return false;
}
// --- End Track P11 ---

function applyRemovalsUpTo(work: PermWorkState, cutoffTimestamp: number): void {
	for (const ev of work.abilityRemovalEvents) {
		if (ev.timestamp > cutoffTimestamp) continue;
		for (const item of work.items) {
			if (item.kind !== 'keyword' && item.kind !== 'ability' && !item.isInnate) continue;
			const itemTs = work.itemTimestamps.get(item.id) ?? -Infinity;
			if (itemTs < ev.timestamp) {
				item.removed = true;
				if (!item.removedBy.includes(ev.sourceName)) {
					item.removedBy.push(ev.sourceName);
				}
			}
		}
	}
}

function grantKeywordString(
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
	const formattedLabel = formatKeywordLabel(gLow);
	grantItem(work, gKey, formattedLabel, 'keyword', sourceLabel, grantTimestamp);
}

function removeMatchingKeywordsUpTo(
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
			if (
				item.canonicalKey === kwLow ||
				(kwLow === 'hexproof' && item.canonicalKey.startsWith('hexproof from ')) ||
				(kwLow === 'protection' && item.canonicalKey.startsWith('protection')) ||
				(kwLow === 'ward' && item.canonicalKey.startsWith('ward')) ||
				(kwLow === 'toxic' && item.canonicalKey === 'toxic') ||
				(kwLow.startsWith('toxic ') && item.name.toLowerCase() === kwLow)
			) {
				item.removed = true;
				if (!item.removedBy.includes(sourceName)) {
					item.removedBy.push(sourceName);
				}
			}
		}
	}
}

function hasSubtypeInWork(work: PermWorkState, sub: string): boolean {
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
function normalizeLayerCardType(t: string): string {
	const low = t.toLowerCase();
	return low === 'tribal' ? 'kindred' : low;
}

function workHasActiveKeyword(work: PermWorkState, kw: string): boolean {
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

function offBattlefieldFilterNeedsExtendedMatch(f: ObjectFilter): boolean {
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
			Boolean(f.sharesCreatureTypeWithSelf)
			// --- End Track P15 ---
	);
}

function matchesLayerFilter(
	filter: ObjectFilter,
	target: PermWorkState,
	source: PermWorkState,
	state: GameState,
	workList: PermWorkState[] = []
): boolean {
	if (filter.other && target.inst.instanceId === source.inst.instanceId) return false;
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
		const chosenSub = source.inst.chosenSubType;
		if (!chosenSub || !hasSubtypeInWork(target, chosenSub)) return false;
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
		const wantHostId =
			filter.attachedToRef === 'self' ? source.inst.instanceId : source.inst.attachedToId;
		if (!wantHostId || target.inst.attachedToId !== wantHostId) return false;
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
	return true;
}

function evaluateLayerAmount(
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
				for (const w of workList) {
					if (matchesLayerFilter(f, w, source, state, workList)) total += 1;
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
		default:
			return 0;
	}
}

function evaluateLayerCondition(
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
			return Boolean(source.inst.hasEnduringStory);
		case 'isHarnessed':
			return Boolean(source.inst.isHarnessed);
		// --- End Wave 6 Shared ---
		// --- Track P18b ---
		case 'anchorWordChosen':
			return (source.inst.chosenAnchorWord ?? '').trim().toLowerCase() === cond.word.trim().toLowerCase();
		// --- End Track P18b ---
		default:
			return false;
	}
}

function hasAttachmentAbilityStrippingStatic(statics: StaticDef[]): boolean {
	for (const st of statics) {
		if (st.k !== 'continuous' || st.affected !== 'attachedTo') continue;
		if (st.mod.k === 'removeAllAbilities') return true;
		if (
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

interface BoardLayerCache {
	dynamicFingerprint: unknown[];
	byInstance: Map<
		CardInstance,
		{
			breakdown: CardContinuousBreakdown;
			lost: { lost: boolean; sources: string[] };
			evaluated: EvaluatedPermanent;
		}
	>;
	/** Lazily built by `abilityActivePermanents` (Phase 6c). */
	abilityActive?: readonly AbilityActivePermanent[];
}

const BOARD_CACHE_KEY = 'phase6_board_layer_cache';

// ---- Read tracking (Phase 6d) ---------------------------------------------------------------
//
// Besides the board snapshot and each active permanent's own counters / temporary P/T / switch /
// suspend / granted keywords (always fingerprinted), a board evaluation reads game state only at
// these points, each of which sets its bit in `layerReads` while `computeBoardLayerCache` runs:
//
// - `matchesLayerFilter` with a `tapped` filter: every active permanent's `tapped`;
// - `evaluateLayerAmount` `life`: life totals; `cardsIn`: zone sizes; `count` in graveyards:
//   graveyard contents;
// - `evaluateLayerCondition` `isTurnOf`: the active player.
//
// The dynamic fingerprint holds only the inputs the evaluation actually read. That's sound: with
// every read input unchanged, re-running the evaluation takes the same path and reads the same
// inputs, so it produces the same result. Before 6d every evaluation was keyed on all of them, so
// a land tapping for mana, a card drawn or a point of damage re-evaluated the whole board even when
// no static ability looked at them.

const READ_TAPPED = 1;
const READ_LIFE = 2;
const READ_ZONE_SIZES = 4;
const READ_GRAVEYARDS = 8;
const READ_ACTIVE_PLAYER = 16;
const READ_COMMANDER_CAST_COUNT = 32;
const READ_EXILE = 64;
const READ_ENERGY = 128;
const READ_MONARCH = 256;
// --- Track P8 ---
const READ_COMBAT = 512;
const READ_ALL_COUNTERS = 1024;
const READ_HIDDEN_ZONES = 2048;
// --- Track P7 ---
const READ_TURN_HISTORY = 4096;
// --- Track P10 ---
const READ_P10_SUSPECT = 8192;
// --- End Track P10 ---
// --- Track P11 ---
const READ_KEYWORD_COUNTERS = 16384;
const READ_CHOSEN_CARD_NAME = 32768;
// --- End Track P11 ---
// --- Track P12 ---
const READ_P12 = 65536;
// --- End Track P12 ---
// --- Track P13 ---
const READ_P13 = 131072; // 1 << 17
// --- End Track P13 ---
// --- Track P14 ---
const READ_P14 = 262144; // 1 << 18
// --- End Track P14 ---
// --- Track P15 ---
const READ_P15 = 524288; // 1 << 19
// --- End Track P15 ---
// --- Track P16a ---
const READ_P16A = 1 << 20;
// --- End Track P16a ---
// --- Track P16b ---
const READ_P16B = 1 << 21;
// --- End Track P16b ---
// --- Track P17a ---
const READ_P17A = 1 << 22;
// --- End Track P17a ---
// --- Track P17b ---
const READ_P17B = 1 << 23;
// --- End Track P17b ---
// --- Track P18a ---
const READ_P18A = 1 << 24;
// --- End Track P18a ---
// --- Track P18b ---
const READ_P18B = 1 << 25;
// --- End Track P18b ---

/** Inputs read by the evaluation in progress (bits above). */
let layerReads = 0;

function buildDynamicFingerprint(state: GameState, snap: BoardSnapshot, reads: number): unknown[] {
	const fp: unknown[] = [(state as { version?: number }).version, reads];
	if (reads & READ_ACTIVE_PLAYER) fp.push(state.activePlayerIndex);
	if (reads & READ_MONARCH) fp.push(state.monarchPlayerId ?? null);
	// --- Track P8 ---
	if (reads & READ_COMBAT) {
		const attackers = state.combat.attackers;
		fp.push(attackers.length);
		for (const atk of attackers) {
			fp.push(
				atk.attackerInstanceId,
				atk.defenderPlayerId,
				Boolean(atk.wasBlocked),
				atk.blockerInstanceIds.length
			);
			for (const bid of atk.blockerInstanceIds) fp.push(bid);
		}
	}
	// --- Track P7 ---
	if (reads & READ_TURN_HISTORY) fp.push(Boolean(state.creatureDiedThisTurn));
	// --- Track P12 ---
	if (reads & READ_P12) {
		fp.push(
			state.creaturesAttackedCountThisTurn ?? 0,
			state.cardsPutIntoGraveyardThisTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(
				p.spellsCastThisTurn ?? 0,
				p.spellsCastThisTurnCards?.length ?? 0,
				p.sourcesDealtDamageIdsThisTurn?.length ?? 0
			);
		}
	}
	// --- End Track P12 ---
	// --- Track P13 ---
	if (reads & READ_P13) {
		fp.push(
			state.initiativePlayerId ?? null,
			state.spellsCastLastTurnTotal ?? 0,
			state.maxSpellsCastBySinglePlayerLastTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(
				p.dungeonsCompletedCount ?? 0,
				p.completedDungeonNames?.length ?? 0,
				Boolean(p.hasCitysBlessing),
				p.speed ?? 0,
				p.poison ?? 0,
				p.nonlandPermanentsEnteredThisTurn ?? 0,
				Boolean(p.nonlandPermanentLeftThisTurn),
				Boolean(p.spellWarpedThisTurn)
			);
		}
	}
	// --- End Track P13 ---
	// --- Track P15 ---
	if (reads & READ_P15) {
		fp.push(
			state.dayNight ?? null,
			state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0
		);
		for (const p of state.players) {
			fp.push(p.speed ?? 0, Boolean(p.hasCitysBlessing));
		}
	}
	// --- End Track P15 ---
	// --- Track P16a ---
	if (reads & READ_P16A) {
		fp.push(0);
	}
	// --- End Track P16a ---
	// --- Track P16b ---
	if (reads & READ_P16B) {
		fp.push(0);
	}
	// --- End Track P16b ---
	// --- Track P17a ---
	if (reads & READ_P17A) {
		fp.push(0);
	}
	// --- End Track P17a ---
	// --- Track P17b ---
	if (reads & READ_P17B) {
		fp.push(0);
	}
	// --- End Track P17b ---
	// --- Track P18a ---
	if (reads & READ_P18A) {
		fp.push(0);
	}
	// --- End Track P18a ---
	// --- Track P18b ---
	if (reads & READ_P18B) {
		fp.push(0);
	}
	// --- End Track P18b ---
	for (const p of state.players) {
		if (reads & READ_LIFE) fp.push(p.life);
		if (reads & READ_ENERGY) fp.push(p.energyCounters || 0);
		// --- Track P7 ---
		if (reads & READ_TURN_HISTORY) {
			fp.push(
				Boolean(p.attackedThisTurn),
				Boolean(p.permanentLeftBattlefieldThisTurn),
				p.lifeGainedThisTurn || 0
			);
		}
		// --- End Track P7 ---
		// --- Track P10 ---
		if (reads & READ_P10_SUSPECT) {
			fp.push(
				Boolean(p.descendedThisTurn),
				Boolean(p.lostLifeThisTurn),
				p.manaSpentOnSpellsThisTurn || 0,
				p.unemptiedManaColorsThisTurn?.length || 0
			);
		}
		// --- End Track P10 ---
		if (reads & READ_COMMANDER_CAST_COUNT) fp.push(playerCommanderCastCount(state, p.playerId));
		if (reads & READ_ZONE_SIZES) {
			fp.push(p.hand.length, p.graveyard.length, p.library.length, p.exile.length, p.command.length);
		}
		if (reads & READ_GRAVEYARDS) {
			fp.push(p.graveyard.length);
			for (const g of p.graveyard) {
				fp.push(g.card, g.copiableCard, g.copiableState);
			}
		}
		if (reads & READ_EXILE) {
			fp.push(p.exile.length);
			for (const ex of p.exile) {
				fp.push(
					ex.card,
					ex.copiableCard,
					ex.copiableState,
					ex.exiledBy?.sourceInstanceId,
					ex.exiledBy?.sourceObjectVersion
				);
			}
		}
		// --- Track P8 ---
		if (reads & READ_HIDDEN_ZONES) {
			fp.push(p.hand.length, p.library.length, p.command.length);
			for (const c of p.hand) fp.push(c.card, c.copiableCard, c.copiableState);
			for (const c of p.library) fp.push(c.card, c.copiableCard, c.copiableState);
			for (const c of p.command) fp.push(c.card, c.copiableCard, c.copiableState);
		}
		// --- Track P14 ---
		if (reads & READ_P14) {
			fp.push(
				p.cardsDrawnThisTurn ?? 0,
				p.spellsCastThisTurn ?? 0,
				p.spellsCastThisTurnCards?.length ?? 0
			);
			let gyStaticCount = 0;
			for (let gi = 0; gi < p.graveyard.length; gi++) {
				if (cardHasGraveyardContinuousStatic(effectiveCardForObject(p.graveyard[gi]))) {
					gyStaticCount += 1;
				}
			}
			fp.push(gyStaticCount);
			if (gyStaticCount > 0) {
				for (let gi = 0; gi < p.graveyard.length; gi++) {
					const g = p.graveyard[gi];
					const gCard = effectiveCardForObject(g);
					if (cardHasGraveyardContinuousStatic(gCard)) {
						fp.push(gCard, g.enteredTimestamp ?? 0);
					}
				}
			}
		}
		// --- End Track P14 ---
	}
	for (const entry of snap.active) {
		const perm = entry.perm;
		if (reads & READ_TAPPED) fp.push(perm.tapped);
		// --- Track P8 ---
		if (reads & READ_ALL_COUNTERS) {
			const cKeys = Object.keys(perm.counters).sort();
			fp.push(cKeys.length);
			for (const ck of cKeys) fp.push(ck, (perm.counters as Record<string, number>)[ck] || 0);
		}
		// --- Track P11 ---
		if (reads & READ_KEYWORD_COUNTERS) {
			const kwMask = computeKeywordCounterMask(perm.counters);
			fp.push(kwMask);
			if (kwMask !== 0) {
				for (const kw of KEYWORD_COUNTER_TYPES) {
					if ((perm.counters[kw] || 0) > 0) {
						fp.push(perm.counterTimestamps?.[kw] ?? 0);
					}
				}
			}
		}
		if (reads & READ_CHOSEN_CARD_NAME) {
			fp.push(perm.chosenCardName ?? '');
		}
		// --- End Track P11 ---
		// --- Track P13 ---
		if (reads & READ_P13) {
			fp.push(
				Boolean(perm.enteredThisTurn),
				Boolean(perm.dealtDamageThisTurn),
				perm.manaColorsAllSpent?.length ?? 0
			);
		}
		// --- End Track P13 ---
		fp.push(
			perm.counters['+1/+1'] || 0,
			perm.counters['-1/-1'] || 0,
			perm.counters.charge || 0,
			perm.counters.level || 0,
			perm.tempPowerMod || 0,
			perm.tempToughnessMod || 0,
			perm.switchedPTCount || 0,
			Boolean(perm.castViaSuspend),
			Boolean(perm.evoked),
			Boolean(perm.escaped),
			Boolean(perm.foretold),
			Boolean(perm.blitzed),
			Boolean(perm.dashed),
			Boolean(perm.riotHaste),
			Boolean(perm.saddledThisTurn),
			Boolean(perm.isMonstrous),
			// --- Track P7 ---
			Boolean(perm.wasCast),
			perm.castFromZone ?? '',
			// --- End Track P7 ---
			// --- Track P10 ---
			Boolean(perm.isSuspected),
			// --- End Track P10 ---
			// --- Track P12 ---
			perm.classLevel ?? 1,
			Boolean(perm.isSolved),
			Boolean(perm.isRenowned),
			Boolean(perm.isBestowed),
			Boolean(perm.creatureAttackedThisTurn),
			perm.devouredCount ?? 0,
			perm.exhaustedAbilityIds?.length ?? 0,
			// --- End Track P12 ---
			// --- Track P15 ---
			Boolean(perm.isPrepared),
			Boolean(perm.castWithImpending),
			perm.counters.time || 0,
			perm.enteredWithX ?? 0,
			Boolean(perm.giftPromised),
			// --- End Track P15 ---
			// --- Wave 6 Shared ---
			perm.pairedWithId ?? null,
			Boolean(perm.tributePaid),
			Boolean(perm.hasEnduringStory),
			Boolean(perm.isHarnessed),
			Boolean(perm.isFlipped),
			perm.mergedComponents?.length ?? 0,
			// --- End Wave 6 Shared ---
			// --- Track P18b ---
			perm.chosenAnchorWord ?? '',
			perm.meldedComponents?.length ?? 0,
			// --- End Track P18b ---
			perm.kickedCount || 0,
			perm.kickedTags?.length || 0,
			perm.grantedKeywords?.length || 0
		);
		if (perm.kickedTags?.length) {
			for (const tag of perm.kickedTags) fp.push(tag);
		}
		if (perm.grantedKeywords?.length) {
			for (const kw of perm.grantedKeywords) fp.push(kw);
		}
	}
	const timedKw = state.timedKeywordEffects;
	fp.push(timedKw?.length || 0);
	if (timedKw?.length) {
		for (const eff of timedKw) {
			fp.push(
				eff.timestamp,
				eff.sourceName,
				eff.controllerId,
				Boolean(eff.cantHaveOrGain),
				eff.affected.length,
				eff.addKeywords?.length || 0,
				eff.removeKeywords?.length || 0
			);
			for (const a of eff.affected) fp.push(a.instanceId, a.objectVersion ?? 1);
			if (eff.addKeywords?.length) for (const kw of eff.addKeywords) fp.push(kw);
			if (eff.removeKeywords?.length) for (const kw of eff.removeKeywords) fp.push(kw);
		}
	}
	const timedCont = state.timedContinuousEffects;
	fp.push(timedCont?.length || 0);
	if (timedCont?.length) {
		for (const eff of timedCont) {
			fp.push(
				eff.timestamp,
				eff.sourceName,
				eff.controllerId,
				eff.expires,
				eff.layer2?.controllerId,
				eff.layer2?.untilSourceLeaves?.sourceInstanceId,
				eff.layer2?.untilSourceLeaves?.sourceObjectVersion,
				eff.affected.length,
				eff.layer4?.addTypes?.length || 0,
				eff.layer4?.setTypes?.length || 0,
				eff.layer4?.addSubtypes?.length || 0,
				eff.layer4?.setSubtypes?.length || 0,
				eff.layer5?.setColors !== undefined ? 1 : 0,
				eff.layer5?.setColors?.length || 0,
				eff.layer5?.addColors?.length || 0,
				Boolean(eff.layer6?.cantHaveOrGain),
				eff.layer6?.addKeywords?.length || 0,
				eff.layer6?.removeKeywords?.length || 0,
				eff.layer7b ? 1 : 0,
				eff.layer7b?.setPower ?? 0,
				eff.layer7b?.setToughness ?? 0,
				// --- Track P7 ---
				eff.layer1a,
				// --- End Track P7 ---
				// --- Track P10 ---
				eff.layer6?.grantedAbilityTexts?.length || 0,
				// --- End Track P10 ---
				// --- Track P12 ---
				eff.backupGrant?.sourceCard,
				eff.backupGrant?.faceIndex ?? 0,
				eff.backupGrant?.startAbilityIndex ?? -1,
				// --- End Track P12 ---
				// --- Track P13 ---
				eff.layer7c ? 1 : 0,
				eff.layer7c?.power ?? 0,
				eff.layer7c?.toughness ?? 0
				// --- End Track P13 ---
			);
			for (const a of eff.affected) fp.push(a.instanceId, a.objectVersion ?? 1);
			if (eff.layer4?.addTypes?.length) for (const t of eff.layer4.addTypes) fp.push(t);
			if (eff.layer4?.setTypes?.length) for (const t of eff.layer4.setTypes) fp.push(t);
			if (eff.layer4?.addSubtypes?.length) for (const s of eff.layer4.addSubtypes) fp.push(s);
			if (eff.layer4?.setSubtypes?.length) for (const s of eff.layer4.setSubtypes) fp.push(s);
			if (eff.layer5?.setColors?.length) for (const c of eff.layer5.setColors) fp.push(c);
			if (eff.layer5?.addColors?.length) for (const c of eff.layer5.addColors) fp.push(c);
			if (eff.layer6?.addKeywords?.length) for (const kw of eff.layer6.addKeywords) fp.push(kw);
			if (eff.layer6?.removeKeywords?.length) for (const kw of eff.layer6.removeKeywords) fp.push(kw);
			// --- Track P10 ---
			if (eff.layer6?.grantedAbilityTexts?.length) {
				for (const gt of eff.layer6.grantedAbilityTexts) fp.push(gt);
			}
			// --- End Track P10 ---
		}
	}
	return fp;
}

/**
 * Compares `fp` (from `buildDynamicFingerprint`) against the current state in place, without
 * allocating, bailing at the first difference. Must read exactly what the builder pushes, in order.
 */
function dynamicFingerprintMatches(state: GameState, snap: BoardSnapshot, fp: unknown[]): boolean {
	let i = 0;
	if (fp[i++] !== (state as { version?: number }).version) return false;
	const reads = fp[i++] as number;
	if (reads & READ_ACTIVE_PLAYER && fp[i++] !== state.activePlayerIndex) return false;
	if (reads & READ_MONARCH && fp[i++] !== (state.monarchPlayerId ?? null)) return false;
	// --- Track P8 ---
	if (reads & READ_COMBAT) {
		const attackers = state.combat.attackers;
		if (fp[i++] !== attackers.length) return false;
		for (const atk of attackers) {
			if (
				fp[i++] !== atk.attackerInstanceId ||
				fp[i++] !== atk.defenderPlayerId ||
				fp[i++] !== Boolean(atk.wasBlocked) ||
				fp[i++] !== atk.blockerInstanceIds.length
			) {
				return false;
			}
			for (const bid of atk.blockerInstanceIds) {
				if (fp[i++] !== bid) return false;
			}
		}
	}
	// --- Track P7 ---
	if (reads & READ_TURN_HISTORY && fp[i++] !== Boolean(state.creatureDiedThisTurn)) return false;
	// --- Track P12 ---
	if (reads & READ_P12) {
		if (
			fp[i++] !== (state.creaturesAttackedCountThisTurn ?? 0) ||
			fp[i++] !== (state.cardsPutIntoGraveyardThisTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurnCards?.length ?? 0) ||
				fp[i++] !== (p.sourcesDealtDamageIdsThisTurn?.length ?? 0)
			) {
				return false;
			}
		}
	}
	// --- End Track P12 ---
	// --- Track P13 ---
	if (reads & READ_P13) {
		if (
			fp[i++] !== (state.initiativePlayerId ?? null) ||
			fp[i++] !== (state.spellsCastLastTurnTotal ?? 0) ||
			fp[i++] !== (state.maxSpellsCastBySinglePlayerLastTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (
				fp[i++] !== (p.dungeonsCompletedCount ?? 0) ||
				fp[i++] !== (p.completedDungeonNames?.length ?? 0) ||
				fp[i++] !== Boolean(p.hasCitysBlessing) ||
				fp[i++] !== (p.speed ?? 0) ||
				fp[i++] !== (p.poison ?? 0) ||
				fp[i++] !== (p.nonlandPermanentsEnteredThisTurn ?? 0) ||
				fp[i++] !== Boolean(p.nonlandPermanentLeftThisTurn) ||
				fp[i++] !== Boolean(p.spellWarpedThisTurn)
			) {
				return false;
			}
		}
	}
	// --- End Track P13 ---
	// --- Track P15 ---
	if (reads & READ_P15) {
		if (
			fp[i++] !== (state.dayNight ?? null) ||
			fp[i++] !== (state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0)
		) {
			return false;
		}
		for (const p of state.players) {
			if (fp[i++] !== (p.speed ?? 0) || fp[i++] !== Boolean(p.hasCitysBlessing)) {
				return false;
			}
		}
	}
	// --- End Track P15 ---
	// --- Track P16a ---
	if (reads & READ_P16A) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P16a ---
	// --- Track P16b ---
	if (reads & READ_P16B) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P16b ---
	// --- Track P17a ---
	if (reads & READ_P17A) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P17a ---
	// --- Track P17b ---
	if (reads & READ_P17B) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P17b ---
	// --- Track P18a ---
	if (reads & READ_P18A) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P18a ---
	// --- Track P18b ---
	if (reads & READ_P18B) {
		if (fp[i++] !== 0) return false;
	}
	// --- End Track P18b ---
	for (const p of state.players) {
		if (reads & READ_LIFE && fp[i++] !== p.life) return false;
		if (reads & READ_ENERGY && fp[i++] !== (p.energyCounters || 0)) return false;
		// --- Track P7 ---
		if (
			reads & READ_TURN_HISTORY &&
			(fp[i++] !== Boolean(p.attackedThisTurn) ||
				fp[i++] !== Boolean(p.permanentLeftBattlefieldThisTurn) ||
				fp[i++] !== (p.lifeGainedThisTurn || 0))
		) {
			return false;
		}
		// --- End Track P7 ---
		// --- Track P10 ---
		if (
			reads & READ_P10_SUSPECT &&
			(fp[i++] !== Boolean(p.descendedThisTurn) ||
				fp[i++] !== Boolean(p.lostLifeThisTurn) ||
				fp[i++] !== (p.manaSpentOnSpellsThisTurn || 0) ||
				fp[i++] !== (p.unemptiedManaColorsThisTurn?.length || 0))
		) {
			return false;
		}
		// --- End Track P10 ---
		if (reads & READ_COMMANDER_CAST_COUNT && fp[i++] !== playerCommanderCastCount(state, p.playerId)) {
			return false;
		}
		if (
			reads & READ_ZONE_SIZES &&
			(fp[i++] !== p.hand.length ||
				fp[i++] !== p.graveyard.length ||
				fp[i++] !== p.library.length ||
				fp[i++] !== p.exile.length ||
				fp[i++] !== p.command.length)
		) {
			return false;
		}
		if (reads & READ_GRAVEYARDS) {
			if (fp[i++] !== p.graveyard.length) return false;
			for (const g of p.graveyard) {
				if (fp[i++] !== g.card || fp[i++] !== g.copiableCard || fp[i++] !== g.copiableState) {
					return false;
				}
			}
		}
		if (reads & READ_EXILE) {
			if (fp[i++] !== p.exile.length) return false;
			for (const ex of p.exile) {
				if (
					fp[i++] !== ex.card ||
					fp[i++] !== ex.copiableCard ||
					fp[i++] !== ex.copiableState ||
					fp[i++] !== ex.exiledBy?.sourceInstanceId ||
					fp[i++] !== ex.exiledBy?.sourceObjectVersion
				) {
					return false;
				}
			}
		}
		// --- Track P8 ---
		if (reads & READ_HIDDEN_ZONES) {
			if (
				fp[i++] !== p.hand.length ||
				fp[i++] !== p.library.length ||
				fp[i++] !== p.command.length
			) {
				return false;
			}
			for (const c of p.hand) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
			for (const c of p.library) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
			for (const c of p.command) {
				if (fp[i++] !== c.card || fp[i++] !== c.copiableCard || fp[i++] !== c.copiableState) {
					return false;
				}
			}
		}
		// --- Track P14 ---
		if (reads & READ_P14) {
			if (
				fp[i++] !== (p.cardsDrawnThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurn ?? 0) ||
				fp[i++] !== (p.spellsCastThisTurnCards?.length ?? 0)
			) {
				return false;
			}
			let gyStaticCount = 0;
			for (let gi = 0; gi < p.graveyard.length; gi++) {
				if (cardHasGraveyardContinuousStatic(effectiveCardForObject(p.graveyard[gi]))) {
					gyStaticCount += 1;
				}
			}
			if (fp[i++] !== gyStaticCount) return false;
			if (gyStaticCount > 0) {
				for (let gi = 0; gi < p.graveyard.length; gi++) {
					const g = p.graveyard[gi];
					const gCard = effectiveCardForObject(g);
					if (cardHasGraveyardContinuousStatic(gCard)) {
						if (fp[i++] !== gCard || fp[i++] !== (g.enteredTimestamp ?? 0)) {
							return false;
						}
					}
				}
			}
		}
		// --- End Track P14 ---
	}
	const readsTapped = (reads & READ_TAPPED) !== 0;
	const readsAllCounters = (reads & READ_ALL_COUNTERS) !== 0;
	// --- Track P11 ---
	const readsKwCounters = (reads & READ_KEYWORD_COUNTERS) !== 0;
	const readsChosenName = (reads & READ_CHOSEN_CARD_NAME) !== 0;
	// --- End Track P11 ---
	// --- Track P13 ---
	const readsP13 = (reads & READ_P13) !== 0;
	// --- End Track P13 ---
	for (const entry of snap.active) {
		const perm = entry.perm;
		const kickedTags = perm.kickedTags;
		const kickedTagsLen = kickedTags?.length || 0;
		const granted = perm.grantedKeywords;
		const grantedLen = granted?.length || 0;
		if (readsTapped && fp[i++] !== perm.tapped) return false;
		// --- Track P8 ---
		if (readsAllCounters) {
			const cKeys = Object.keys(perm.counters).sort();
			if (fp[i++] !== cKeys.length) return false;
			for (const ck of cKeys) {
				if (fp[i++] !== ck || fp[i++] !== ((perm.counters as Record<string, number>)[ck] || 0)) {
					return false;
				}
			}
		}
		// --- Track P11 ---
		if (readsKwCounters) {
			const kwMask = computeKeywordCounterMask(perm.counters);
			if (fp[i++] !== kwMask) return false;
			if (kwMask !== 0) {
				for (const kw of KEYWORD_COUNTER_TYPES) {
					if ((perm.counters[kw] || 0) > 0) {
						if (fp[i++] !== (perm.counterTimestamps?.[kw] ?? 0)) return false;
					}
				}
			}
		}
		if (readsChosenName && fp[i++] !== (perm.chosenCardName ?? '')) return false;
		// --- End Track P11 ---
		// --- Track P13 ---
		if (
			readsP13 &&
			(fp[i++] !== Boolean(perm.enteredThisTurn) ||
				fp[i++] !== Boolean(perm.dealtDamageThisTurn) ||
				fp[i++] !== (perm.manaColorsAllSpent?.length ?? 0))
		) {
			return false;
		}
		// --- End Track P13 ---
		if (
			fp[i++] !== (perm.counters['+1/+1'] || 0) ||
			fp[i++] !== (perm.counters['-1/-1'] || 0) ||
			fp[i++] !== (perm.counters.charge || 0) ||
			fp[i++] !== (perm.counters.level || 0) ||
			fp[i++] !== (perm.tempPowerMod || 0) ||
			fp[i++] !== (perm.tempToughnessMod || 0) ||
			fp[i++] !== (perm.switchedPTCount || 0) ||
			fp[i++] !== Boolean(perm.castViaSuspend) ||
			fp[i++] !== Boolean(perm.evoked) ||
			fp[i++] !== Boolean(perm.escaped) ||
			fp[i++] !== Boolean(perm.foretold) ||
			fp[i++] !== Boolean(perm.blitzed) ||
			fp[i++] !== Boolean(perm.dashed) ||
			fp[i++] !== Boolean(perm.riotHaste) ||
			fp[i++] !== Boolean(perm.saddledThisTurn) ||
			fp[i++] !== Boolean(perm.isMonstrous) ||
			// --- Track P7 ---
			fp[i++] !== Boolean(perm.wasCast) ||
			fp[i++] !== (perm.castFromZone ?? '') ||
			// --- End Track P7 ---
			// --- Track P10 ---
			fp[i++] !== Boolean(perm.isSuspected) ||
			// --- End Track P10 ---
			// --- Track P12 ---
			fp[i++] !== (perm.classLevel ?? 1) ||
			fp[i++] !== Boolean(perm.isSolved) ||
			fp[i++] !== Boolean(perm.isRenowned) ||
			fp[i++] !== Boolean(perm.isBestowed) ||
			fp[i++] !== Boolean(perm.creatureAttackedThisTurn) ||
			fp[i++] !== (perm.devouredCount ?? 0) ||
			fp[i++] !== (perm.exhaustedAbilityIds?.length ?? 0) ||
			// --- End Track P12 ---
			// --- Track P15 ---
			fp[i++] !== Boolean(perm.isPrepared) ||
			fp[i++] !== Boolean(perm.castWithImpending) ||
			fp[i++] !== (perm.counters.time || 0) ||
			fp[i++] !== (perm.enteredWithX ?? 0) ||
			fp[i++] !== Boolean(perm.giftPromised) ||
			// --- End Track P15 ---
			// --- Wave 6 Shared ---
			fp[i++] !== (perm.pairedWithId ?? null) ||
			fp[i++] !== Boolean(perm.tributePaid) ||
			fp[i++] !== Boolean(perm.hasEnduringStory) ||
			fp[i++] !== Boolean(perm.isHarnessed) ||
			fp[i++] !== Boolean(perm.isFlipped) ||
			fp[i++] !== (perm.mergedComponents?.length ?? 0) ||
			// --- End Wave 6 Shared ---
			// --- Track P18b ---
			fp[i++] !== (perm.chosenAnchorWord ?? '') ||
			fp[i++] !== (perm.meldedComponents?.length ?? 0) ||
			// --- End Track P18b ---
			fp[i++] !== (perm.kickedCount || 0) ||
			fp[i++] !== kickedTagsLen ||
			fp[i++] !== grantedLen
		) {
			return false;
		}
		if (kickedTagsLen) {
			for (const tag of kickedTags!) if (fp[i++] !== tag) return false;
		}
		if (grantedLen) {
			for (const kw of granted) if (fp[i++] !== kw) return false;
		}
	}
	const timedKw = state.timedKeywordEffects;
	const timedLen = timedKw?.length || 0;
	if (fp[i++] !== timedLen) return false;
	if (timedLen) {
		for (const eff of timedKw!) {
			const affLen = eff.affected.length;
			const addLen = eff.addKeywords?.length || 0;
			const remLen = eff.removeKeywords?.length || 0;
			if (
				fp[i++] !== eff.timestamp ||
				fp[i++] !== eff.sourceName ||
				fp[i++] !== eff.controllerId ||
				fp[i++] !== Boolean(eff.cantHaveOrGain) ||
				fp[i++] !== affLen ||
				fp[i++] !== addLen ||
				fp[i++] !== remLen
			) {
				return false;
			}
			for (const a of eff.affected) {
				if (fp[i++] !== a.instanceId || fp[i++] !== (a.objectVersion ?? 1)) return false;
			}
			if (addLen) {
				for (const kw of eff.addKeywords!) if (fp[i++] !== kw) return false;
			}
			if (remLen) {
				for (const kw of eff.removeKeywords!) if (fp[i++] !== kw) return false;
			}
		}
	}
	const timedCont = state.timedContinuousEffects;
	const contLen = timedCont?.length || 0;
	if (fp[i++] !== contLen) return false;
	if (contLen) {
		for (const eff of timedCont!) {
			const affLen = eff.affected.length;
			const l4AddTypes = eff.layer4?.addTypes?.length || 0;
			const l4SetTypes = eff.layer4?.setTypes?.length || 0;
			const l4AddSubs = eff.layer4?.addSubtypes?.length || 0;
			const l4SetSubs = eff.layer4?.setSubtypes?.length || 0;
			const hasL5Set = eff.layer5?.setColors !== undefined ? 1 : 0;
			const l5SetLen = eff.layer5?.setColors?.length || 0;
			const l5AddLen = eff.layer5?.addColors?.length || 0;
			const l6Cant = Boolean(eff.layer6?.cantHaveOrGain);
			const l6Add = eff.layer6?.addKeywords?.length || 0;
			const l6Rem = eff.layer6?.removeKeywords?.length || 0;
			const hasL7b = eff.layer7b ? 1 : 0;
			const l7bP = eff.layer7b?.setPower ?? 0;
			const l7bT = eff.layer7b?.setToughness ?? 0;
			// --- Track P10 ---
			const l6Texts = eff.layer6?.grantedAbilityTexts?.length || 0;
			// --- End Track P10 ---
			if (
				fp[i++] !== eff.timestamp ||
				fp[i++] !== eff.sourceName ||
				fp[i++] !== eff.controllerId ||
				fp[i++] !== eff.expires ||
				fp[i++] !== eff.layer2?.controllerId ||
				fp[i++] !== eff.layer2?.untilSourceLeaves?.sourceInstanceId ||
				fp[i++] !== eff.layer2?.untilSourceLeaves?.sourceObjectVersion ||
				fp[i++] !== affLen ||
				fp[i++] !== l4AddTypes ||
				fp[i++] !== l4SetTypes ||
				fp[i++] !== l4AddSubs ||
				fp[i++] !== l4SetSubs ||
				fp[i++] !== hasL5Set ||
				fp[i++] !== l5SetLen ||
				fp[i++] !== l5AddLen ||
				fp[i++] !== l6Cant ||
				fp[i++] !== l6Add ||
				fp[i++] !== l6Rem ||
				fp[i++] !== hasL7b ||
				fp[i++] !== l7bP ||
				fp[i++] !== l7bT ||
				// --- Track P7 ---
				fp[i++] !== eff.layer1a ||
				// --- End Track P7 ---
				// --- Track P10 ---
				fp[i++] !== l6Texts ||
				// --- End Track P10 ---
				// --- Track P12 ---
				fp[i++] !== eff.backupGrant?.sourceCard ||
				fp[i++] !== (eff.backupGrant?.faceIndex ?? 0) ||
				fp[i++] !== (eff.backupGrant?.startAbilityIndex ?? -1) ||
				// --- End Track P12 ---
				// --- Track P13 ---
				fp[i++] !== (eff.layer7c ? 1 : 0) ||
				fp[i++] !== (eff.layer7c?.power ?? 0) ||
				fp[i++] !== (eff.layer7c?.toughness ?? 0)
				// --- End Track P13 ---
			) {
				return false;
			}
			for (const a of eff.affected) {
				if (fp[i++] !== a.instanceId || fp[i++] !== (a.objectVersion ?? 1)) return false;
			}
			if (l4AddTypes) for (const t of eff.layer4!.addTypes!) if (fp[i++] !== t) return false;
			if (l4SetTypes) for (const t of eff.layer4!.setTypes!) if (fp[i++] !== t) return false;
			if (l4AddSubs) for (const s of eff.layer4!.addSubtypes!) if (fp[i++] !== s) return false;
			if (l4SetSubs) for (const s of eff.layer4!.setSubtypes!) if (fp[i++] !== s) return false;
			if (l5SetLen) for (const c of eff.layer5!.setColors!) if (fp[i++] !== c) return false;
			if (l5AddLen) for (const c of eff.layer5!.addColors!) if (fp[i++] !== c) return false;
			if (l6Add) for (const kw of eff.layer6!.addKeywords!) if (fp[i++] !== kw) return false;
			if (l6Rem) for (const kw of eff.layer6!.removeKeywords!) if (fp[i++] !== kw) return false;
			// --- Track P10 ---
			if (l6Texts) for (const gt of eff.layer6!.grantedAbilityTexts!) if (fp[i++] !== gt) return false;
			// --- End Track P10 ---
		}
	}
	return i === fp.length;
}

function computeBoardLayerCache(state: GameState, snap: BoardSnapshot): BoardLayerCache {
	const outer = layerReads;
	layerReads = 0;
	try {
		const byInstance = evaluateBoard(state, snap);
		return {
			dynamicFingerprint: buildDynamicFingerprint(state, snap, layerReads),
			byInstance
		};
	} finally {
		layerReads |= outer;
	}
}

/** Evaluates layers 1–7d for every active permanent (the uncached computation). */
function evaluateBoard(state: GameState, snap: BoardSnapshot): BoardLayerCache['byInstance'] {
	// Split into one function per pass (Phase 6d): same code, but V8 optimises and re-optimises
	// the passes separately instead of recompiling one ~850-line function after every deopt.
	const workList: PermWorkState[] = [];
	const workMap = new Map<string, PermWorkState>();
	// --- Track P13 (CR 114.3, 114.4): Emblems in the command zone contribute continuous effects
	// without being permanents on the battlefield (so Humility / board filters never touch them). ---
	const emblemWorkList = buildEmblemWorkStates(state);
	// --- End Track P13 ---
	evaluateLayer1(state, snap, workList, workMap);
	evaluateLayer2Control(state, workList, workMap, emblemWorkList);
	evaluateAttachedTypes(state, snap, workList, workMap);
	evaluateTypeOverwrites(state, snap, workList, workMap, emblemWorkList);
	evaluateAdditiveTypesAndColors(state, snap, workList, workMap, emblemWorkList);
	evaluateLayer5Colors(state, workList, workMap, emblemWorkList);
	evaluateGlobalAbilityLoss(state, snap, workList, workMap, emblemWorkList);
	evaluatePerPermanent(state, snap, workList, workMap, emblemWorkList);
	return buildBoardResults(workList);
}

// --- Track P13 ---
function buildEmblemWorkStates(state: GameState): PermWorkState[] {
	const out: PermWorkState[] = [];
	for (const p of state.players) {
		if (p.lost || p.command.length === 0) continue;
		for (const cmd of p.command) {
			if (!cmd.isEmblem || cmd.isRingEmblem) continue;
			const statics: StaticDef[] = [];
			for (const ab of activeAbilityDefs(cmd.card, {
				zone: 'command',
				faceIndex: 0,
				isFaceDown: false
			})) {
				if (ab.kind === 'static') {
					statics.push(ab.static);
				} else if (ab.kind === 'keyword') {
					const kwSpec = getKeywordSpec(ab.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
							statics.push(st);
						}
					}
				}
			}
			if (statics.length === 0) continue;
			statics.sort((a, b) => staticLayerOrder(a) - staticLayerOrder(b));
			out.push({
				inst: cmd,
				controllerId: cmd.controllerId || p.playerId,
				baseCard: cmd.card,
				timestamp: cmd.enteredTimestamp ?? 0,
				name: cmd.card.name,
				manaCost: '',
				manaValue: 0,
				isFaceDown: false,
				baseTypeLine: 'Emblem',
				effectiveTypeLine: 'Emblem',
				supertypes: [],
				types: [],
				subtypes: [],
				colors: [],
				isLegendary: false,
				prefixLegendary: '',
				hasAllCreatureTypes: false,
				basePower: null,
				baseToughness: null,
				workingPower: null,
				workingToughness: null,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items: [],
				itemTimestamps: new Map(),
				statics,
				grantsKeywordViaAbility: new Set(),
				strippedByAttachment: false
			});
		}
	}
	return out;
}
// --- End Track P13 ---

// --- Track P11: Per-CardDefinition Layer 1 template memo for plain face-up permanents ---
interface PlainLayer1Template {
	cmc: number;
	keywordsRef: ScryfallCard['keywords'];
	keywordsJoin: string;
	name: string;
	// --- Track P14 ---
	manaCost: string;
	// --- End Track P14 ---
	manaValue: number;
	baseTypeLine: string;
	supertypes: readonly string[];
	types: readonly string[];
	subtypes: readonly string[];
	colors: readonly ManaColor[];
	isLegendary: boolean;
	prefixLegendary: string;
	hasAllCreatureTypes: boolean;
	basePower: number | null;
	baseToughness: number | null;
	innateItems: ReadonlyArray<{
		id: string;
		canonicalKey: string;
		name: string;
		kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod';
	}>;
	statics: readonly StaticDef[];
	grantsKeywordViaAbility: readonly string[];
}

const PLAIN_LAYER1_OPTS: ResolveObjectFacesOptions = {
	zone: 'battlefield',
	faceIndex: 0,
	isFaceDown: false
};

const PLAIN_LAYER1_BY_DEF = new WeakMap<CardDefinition, PlainLayer1Template>();

function staticLayerOrder(st: StaticDef): number {
	if (st.k !== 'continuous') return 99;
	switch (st.layer) {
		case '1':
			return 1;
		case '2':
			return 2;
		case '3':
			return 3;
		case '4':
			return 4;
		case '5':
			return 5;
		case '6':
			return 6;
		case '7a':
			return 7.1;
		case '7b':
			return 7.2;
		case '7c':
		default:
			return 7.3;
	}
}

function getPlainLayer1Template(baseCard: ScryfallCard): PlainLayer1Template {
	const def = compileCard(baseCard);
	const cached = PLAIN_LAYER1_BY_DEF.get(def);
	if (
		cached &&
		cached.cmc === baseCard.cmc &&
		(cached.keywordsRef === baseCard.keywords ||
			(baseCard.keywords?.join('\u0001') ?? '') === cached.keywordsJoin)
	) {
		return cached;
	}

	const view = resolveObjectFaces(baseCard, PLAIN_LAYER1_OPTS);
	const baseTypeLine = view.typeLine;
	const supertypes = [...view.supertypes];
	const types = [...view.types];
	const subtypes = normalizeSubtypes(view.subtypes);
	const colors = [...view.colors];
	const isLegendary = supertypes.includes('Legendary');
	const prefixLegendary = isLegendary ? 'Legendary ' : '';
	const basePower = view.power ?? null;
	const baseToughness = view.toughness ?? null;

	const innateList = innateKeywordsAndAbilitiesOf(baseCard, PLAIN_LAYER1_OPTS);
	const innateItems = innateList.map((entryItem, idx) => ({
		id: `innate_${idx}_${entryItem.canonicalKey}`,
		canonicalKey: entryItem.canonicalKey,
		name: entryItem.name,
		kind: entryItem.kind
	}));
	const hasAllCreatureTypes = innateItems.some((it) => it.canonicalKey === 'changeling');

	const statics: StaticDef[] = [];
	const grantsSet = new Set<string>();
	for (const ab of activeAbilityDefs(baseCard, PLAIN_LAYER1_OPTS)) {
		if (ab.kind === 'static') {
			// --- Track P14 (CR 113.6b): Graveyard-only statics do not function on the battlefield ---
			if (ab.static.k === 'continuous' && ab.static.activeInZone === 'graveyard') continue;
			// --- End Track P14 ---
			statics.push(ab.static);
		} else if (ab.kind === 'keyword') {
			const kwSpec = getKeywordSpec(ab.keyword.name);
			if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
				for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
					statics.push(st);
				}
			}
		} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
			for (const step of ab.effect) {
				if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
					for (const kw of step.params.keywords as string[]) {
						grantsSet.add(kw.toLowerCase());
					}
				}
			}
		}
	}
	statics.sort((a, b) => staticLayerOrder(a) - staticLayerOrder(b));

	const tpl: PlainLayer1Template = {
		cmc: baseCard.cmc,
		keywordsRef: baseCard.keywords,
		keywordsJoin: baseCard.keywords?.join('\u0001') ?? '',
		name: view.name,
		// --- Track P14 ---
		manaCost: view.manaCost,
		// --- End Track P14 ---
		manaValue: view.manaValue,
		baseTypeLine,
		supertypes,
		types,
		subtypes,
		colors,
		isLegendary,
		prefixLegendary,
		hasAllCreatureTypes,
		basePower,
		baseToughness,
		innateItems,
		statics,
		grantsKeywordViaAbility: [...grantsSet]
	};
	PLAIN_LAYER1_BY_DEF.set(def, tpl);
	return tpl;
}
// --- End Track P11 ---

function evaluateLayer1(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	for (const entry of snap.sorted) {
		const inst = entry.perm;
		const baseCard = entry.card;

		// Layer 1a (CR 613.2a): printed characteristics, active face, and copy effects/exceptions.
		// --- Track P7 ---
		const timedLayer1a = activeTimedLayer1aForPermanent(state, inst);
		const effectiveCopy = timedLayer1a ?? inst.copiableState;
		// --- End Track P7 ---
		const isFaceDown = Boolean(inst.isFaceDown);

		// --- Track P11: Fast path for plain face-up permanents without copy/transform/prototype ---
		if (
			!isFaceDown &&
			!effectiveCopy &&
			!inst.transformed &&
			!inst.activeFaceIndex &&
			!(inst as { faceIndex?: number }).faceIndex &&
			!inst.unlockedFaces?.length &&
			!inst.prototyped &&
			!inst.isBestowed
		) {
			const tpl = getPlainLayer1Template(baseCard);
			const itemTimestamps = new Map<string, number>();
			const items: AttributedKeywordOrEffect[] = new Array(tpl.innateItems.length);
			for (let i = 0; i < tpl.innateItems.length; i++) {
				const src = tpl.innateItems[i];
				itemTimestamps.set(src.id, -Infinity);
				items[i] = {
					id: src.id,
					canonicalKey: src.canonicalKey,
					name: src.name,
					kind: src.kind,
					isInnate: true,
					sources: ['innate'],
					removed: false,
					removedBy: []
				};
			}
			const strippedByAttachment =
				getAttachedAbilityStrippingAuraSources(snap, inst.instanceId).length > 0;
			const work: PermWorkState = {
				inst,
				controllerId: inst.defaultControllerId ?? inst.controllerId,
				baseCard,
				timestamp: entry.timestamp,
				name: tpl.name,
				// --- Track P14 ---
				manaCost: tpl.manaCost,
				// --- End Track P14 ---
				manaValue: tpl.manaValue,
				isFaceDown: false,
				baseTypeLine: tpl.baseTypeLine,
				effectiveTypeLine: tpl.baseTypeLine,
				supertypes: [...tpl.supertypes],
				types: [...tpl.types],
				subtypes: [...tpl.subtypes],
				colors: [...tpl.colors],
				isLegendary: tpl.isLegendary,
				prefixLegendary: tpl.prefixLegendary,
				hasAllCreatureTypes: tpl.hasAllCreatureTypes,
				basePower: tpl.basePower,
				baseToughness: tpl.baseToughness,
				workingPower: tpl.basePower,
				workingToughness: tpl.baseToughness,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items,
				itemTimestamps,
				statics: [...tpl.statics],
				grantsKeywordViaAbility: new Set(tpl.grantsKeywordViaAbility),
				strippedByAttachment
			};
			workList.push(work);
			workMap.set(inst.instanceId, work);
			continue;
		}
		// --- End Track P11 ---

		// --- Track P7 ---
		const baseFaceOpts = instanceFaceOptions(inst, 'battlefield');
		const layer1aOpts: ResolveObjectFacesOptions = {
			...baseFaceOpts,
			...(timedLayer1a
				? {
						copiableState: timedLayer1a,
						faceIndex: timedLayer1a.faceIndex ?? 0,
						isSingleFaceCopy: timedLayer1a.isSingleFaceCopy,
						prototyped: Boolean(timedLayer1a.prototyped)
					}
				: {}),
			isFaceDown: false,
			faceDownSpec: undefined,
			faceDownLabel: undefined
		};
		// --- End Track P7 ---
		const layer1aView = resolveObjectFaces(baseCard, layer1aOpts);

		// Layer 1b (CR 613.2b, CR 708.2): face-down status overrides Layer 1a copiable values.
		const view = isFaceDown
			? resolveObjectFaces(baseCard, {
					zone: 'battlefield',
					isFaceDown: true,
					faceDownSpec: inst.faceDownSpec,
					faceDownLabel: inst.faceDownLabel ?? 'Face-Down Creature'
				})
			: layer1aView;

		const baseTypeLine = view.typeLine;
		const supertypes = [...view.supertypes];
		const types = [...view.types];
		const subtypes = normalizeSubtypes(view.subtypes);
		const colors = [...view.colors];
		const isLegendary = supertypes.includes('Legendary');
		const prefixLegendary = isLegendary ? 'Legendary ' : '';

		const basePower = view.power ?? null;
		const baseToughness = view.toughness ?? null;

		const innateList = isFaceDown
			? innateKeywordsAndAbilitiesOf(baseCard, {
					zone: 'battlefield',
					isFaceDown: true,
					faceDownSpec: inst.faceDownSpec,
					faceDownLabel: inst.faceDownLabel ?? 'Face-Down Creature'
				})
			: innateKeywordsAndAbilitiesOf(baseCard, layer1aOpts);
		const itemTimestamps = new Map<string, number>();
		const items: AttributedKeywordOrEffect[] = innateList.map((entryItem, idx) => {
			const id = `innate_${idx}_${entryItem.canonicalKey}`;
			itemTimestamps.set(id, -Infinity);
			return {
				id,
				canonicalKey: entryItem.canonicalKey,
				name: entryItem.name,
				kind: entryItem.kind,
				isInnate: true,
				sources: ['innate'],
				removed: false,
				removedBy: []
			};
		});

		const statics: StaticDef[] = [];
		const grantsKeywordViaAbility = new Set<string>();
		if (!isFaceDown) {
			// --- Track P7 ---
			const hasCopyColorException = effectiveCopy?.except?.colors !== undefined;
			if (effectiveCopy?.except?.addKeywords?.length) {
				for (const rawKw of effectiveCopy.except.addKeywords) {
					const kwLow = rawKw.trim().toLowerCase();
					if (!kwLow) continue;
					if (!items.some((it) => it.canonicalKey === kwLow)) {
						const id = `innate_${items.length}_${kwLow}`;
						itemTimestamps.set(id, -Infinity);
						items.push({
							id,
							canonicalKey: kwLow,
							name: formatKeywordLabel(kwLow),
							kind: 'keyword',
							isInnate: true,
							sources: ['innate'],
							removed: false,
							removedBy: []
						});
					}
					const kwSpec = getKeywordSpec(kwLow);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics({ name: kwLow })) {
							if (hasCopyColorException && st.k === 'continuous' && st.layer === '5' && st.affected === 'self') {
								continue;
							}
							statics.push(st);
						}
					}
				}
			}
			// --- End Track P7 ---
			for (const ab of activeAbilityDefs(baseCard, layer1aOpts)) {
				if (ab.kind === 'static') {
					// --- Track P14 (CR 113.6b): Graveyard-only statics do not function on the battlefield ---
					if (ab.static.k === 'continuous' && ab.static.activeInZone === 'graveyard') continue;
					// --- End Track P14 ---
					statics.push(ab.static);
				} else if (ab.kind === 'keyword') {
					const kwSpec = getKeywordSpec(ab.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(ab.keyword)) {
							if (hasCopyColorException && st.k === 'continuous' && st.layer === '5' && st.affected === 'self') {
								continue;
							}
							statics.push(st);
						}
					}
				} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
					for (const step of ab.effect) {
						if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
							for (const kw of step.params.keywords as string[]) {
								grantsKeywordViaAbility.add(kw.toLowerCase());
							}
						}
					}
				}
			}
			// --- Track P12: Backup-granted statics & static keywords (CR 702.165a–d) ---
			for (const bAb of collectBackupGrantedAbilityDefs(state, inst)) {
				if (bAb.kind === 'static') {
					statics.push(bAb.static);
				} else if (bAb.kind === 'keyword') {
					const kwSpec = getKeywordSpec(bAb.keyword.name);
					if (kwSpec?.status === 'implemented' && kwSpec.implementation?.kind === 'static') {
						for (const st of kwSpec.implementation.buildStatics(bAb.keyword)) {
							statics.push(st);
						}
					}
				}
			}
			// --- End Track P12 ---
			const layerOrder = (st: StaticDef): number => {
				if (st.k !== 'continuous') return 99;
				switch (st.layer) {
					case '1':
						return 1;
					case '2':
						return 2;
					case '3':
						return 3;
					case '4':
						return 4;
					case '5':
						return 5;
					case '6':
						return 6;
					case '7a':
						return 7.1;
					case '7b':
						return 7.2;
					case '7c':
					default:
						return 7.3;
				}
			};
			statics.sort((a, b) => layerOrder(a) - layerOrder(b));
		}

		const strippedByAttachment =
			getAttachedAbilityStrippingAuraSources(snap, inst.instanceId).length > 0;

		const work: PermWorkState = {
			inst,
			controllerId: inst.defaultControllerId ?? inst.controllerId,
			baseCard,
			timestamp: entry.timestamp,
			name: view.name,
			// --- Track P14 ---
			manaCost:
				isFaceDown || effectiveCopy?.except?.noManaCost
					? ''
					: view.manaCost,
			// --- End Track P14 ---
			// --- Track P7 ---
			manaValue: !isFaceDown && effectiveCopy?.except?.noManaCost ? 0 : view.manaValue,
			// --- End Track P7 ---
			isFaceDown,
			baseTypeLine,
			effectiveTypeLine: baseTypeLine,
			supertypes,
			types,
			subtypes,
			colors,
			isLegendary,
			prefixLegendary,
			hasAllCreatureTypes: !isFaceDown && items.some((it) => it.canonicalKey === 'changeling'),
			basePower,
			baseToughness,
			workingPower: basePower,
			workingToughness: baseToughness,
			typeModifiedBy: [],
			ptModifiedBy: [],
			allAbilityRemovalSources: [],
			abilityRemovalEvents: [],
			layer7bSetters: [],
			items,
			itemTimestamps,
			statics,
			grantsKeywordViaAbility,
			strippedByAttachment
		};
		workList.push(work);
		workMap.set(inst.instanceId, work);
	}
}

function isTimedContinuousEffectActive(
	eff: TimedContinuousEffect,
	workMap: Map<string, PermWorkState>
): boolean {
	const usl = eff.layer2?.untilSourceLeaves;
	if (!usl) return true;
	const src = workMap.get(usl.sourceInstanceId);
	return Boolean(src && (src.inst.objectVersion ?? 1) === usl.sourceObjectVersion);
}

function resolveLayerPlayerRef(
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

/**
 * Pass 0 — Layer 2 continuous control-changing effects (CR 613.1b, CR 613.6, CR 613.7).
 * Evaluated BEFORE Layers 4–7 so `"creatures you control"` anthems and restrictions immediately
 * reflect the Layer 2 controller, and BEFORE Layer 6 ability removal per CR 613.6.
 */
function evaluateLayer2Control(
	state: GameState,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	type Layer2Op =
		| {
				kind: 'static';
				timestamp: number;
				order: number;
				source: PermWorkState;
				st: StaticDef & { k: 'continuous' };
		  }
		| { kind: 'timed'; timestamp: number; order: number; eff: TimedContinuousEffect };
	const ops: Layer2Op[] = [];
	let order = 0;

	const layer2Sources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of layer2Sources) {
		for (const st of source.statics) {
			if (st.k === 'continuous' && st.layer === '2' && st.mod.k === 'setController') {
				ops.push({ kind: 'static', timestamp: source.timestamp, order: order++, source, st });
			}
		}
	}

	if (state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer2) continue;
			if (!isTimedContinuousEffectActive(eff, workMap)) continue;
			const targetPlayer = state.players.find((pl) => pl.playerId === eff.layer2!.controllerId);
			if (!targetPlayer || targetPlayer.lost) continue;
			ops.push({ kind: 'timed', timestamp: eff.timestamp, order: order++, eff });
		}
	}

	if (ops.length === 0) return;
	ops.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

	for (const op of ops) {
		if (op.kind === 'static') {
			const { source, st } = op;
			if (st.mod.k !== 'setController') continue;
			if (st.affected === 'attachedTo') {
				if (!source.inst.attachedToId) continue;
				const target = workMap.get(source.inst.attachedToId);
				if (!target) continue;
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target)) {
					continue;
				}
				target.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, target);
			} else if (st.affected === 'self') {
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, source)) {
					continue;
				}
				source.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, source);
			} else if (typeof st.affected === 'object') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target, workMap)) {
						continue;
					}
					target.controllerId = resolveLayerPlayerRef(st.mod.controller, state, source, target);
				}
			}
		} else {
			const { eff } = op;
			const nextControllerId = eff.layer2!.controllerId;
			for (const aff of eff.affected) {
				const target = workMap.get(aff.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
				target.controllerId = nextControllerId;
			}
		}
	}
}

function evaluateAttachedTypes(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// --- Track P11: O(1) skip when nothing on the board is attached ---
	if (snap.attachedTo.size === 0) return;
	// --- End Track P11 ---
	// 2. Layer 4 Pass A: Attached type-setting effects, attached ability-removal registration, and attached 7b setters
	for (const target of workList) {
		for (const att of workList) {
			if (att.inst.attachedToId !== target.inst.instanceId) continue;
			if (att.strippedByAttachment) continue;

			let losesAbilities = false;
			for (const st of att.statics) {
				if (st.k !== 'continuous' || st.affected !== 'attachedTo') continue;
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, att, target)) {
					continue;
				}
				if (st.mod.k === 'removeAllAbilities') {
					losesAbilities = true;
				} else if (st.layer === '4' && st.mod.k === 'setTypes') {
					// CR 205.4b: Changing card types or subtypes does not change supertypes.
					target.types = [...st.mod.types];
					target.subtypes = [...(st.mod.subtypes ?? [])];
					target.hasAllCreatureTypes = false;
					const superPrefix =
						target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
					const typeStr = target.types.join(' ');
					const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
					target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
					if (!target.typeModifiedBy.includes(att.name)) target.typeModifiedBy.push(att.name);

					// CR 305.7: setting a basic land subtype on a land removes rules-text abilities
					if (
						target.types.includes('Land') &&
						target.subtypes.some((sub) => BASIC_LAND_SUBTYPES.has(sub))
					) {
						losesAbilities = true;
					}
					if (target.types.includes('Land') && !target.types.includes('Creature')) {
						target.layer7bSetters.push({
							sourceName: att.name,
							power: null,
							toughness: null,
							timestamp: att.timestamp
						});
					}
				} else if (st.layer === '7b' && st.mod.k === 'setBasePT') {
					const p = evaluateLayerAmount(st.mod.power, state, workList, att, target);
					const t = evaluateLayerAmount(st.mod.toughness, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						power: p,
						toughness: t,
						timestamp: att.timestamp
					});
				// --- Track P14 ---
				} else if (st.layer === '7b' && st.mod.k === 'setBasePower') {
					const p = evaluateLayerAmount(st.mod.power, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						power: p,
						timestamp: att.timestamp
					});
				} else if (st.layer === '7b' && st.mod.k === 'setBaseToughness') {
					const t = evaluateLayerAmount(st.mod.toughness, state, workList, att, target);
					target.layer7bSetters.push({
						sourceName: att.name,
						toughness: t,
						timestamp: att.timestamp
					});
				// --- End Track P14 ---
				}
			}
			if (losesAbilities) {
				recordAbilityRemoval(target, att.name, att.timestamp);
			}
		}
	}
}

function evaluateTypeOverwrites(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// 3. Layer 4 Pass B: Global type-overwriting effects ("Nonbasic lands are Mountains." — CR 613.8 before additive land types)
	const overwriteSources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of overwriteSources) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (
				st.k !== 'continuous' ||
				st.layer !== '4' ||
				st.mod.k !== 'setSubtypes' ||
				(typeof st.affected !== 'object' && st.affected !== 'attachedTo')
			) {
				continue;
			}
			const candidates =
				st.affected === 'attachedTo'
					? (() => {
							const hostId = source.inst.attachedToId;
							const host = hostId ? workMap.get(hostId) : undefined;
							return host ? [host] : [];
						})()
					: workList;
			for (const target of candidates) {
				if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
					continue;
				}
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target, workMap)) {
					continue;
				}
				// CR 205.1a, 205.4b, 305.7: Setting land subtypes replaces only land subtypes while
				// preserving supertypes, all card types (e.g. Artifact, Creature), and non-land subtypes.
				const settingLandSubtypes = st.mod.subtypes.some((sub) => LAND_SUBTYPES.has(sub));
				const retainedSubtypes = settingLandSubtypes
					? target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub))
					: [];
				target.subtypes = [...st.mod.subtypes, ...retainedSubtypes];
				const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
				const typeStr = target.types.join(' ');
				const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
				target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
				if (!target.typeModifiedBy.includes(source.name)) target.typeModifiedBy.push(source.name);
				if (st.mod.subtypes.some((sub) => BASIC_LAND_SUBTYPES.has(sub))) {
					recordAbilityRemoval(target, source.name, source.timestamp);
				}
			}
		}
	}
	if (state.timedContinuousEffects?.length) {
		const sorted = [...state.timedContinuousEffects]
			.filter(
				(e) =>
					isTimedContinuousEffectActive(e, workMap) &&
					(e.layer4?.setTypes?.length || e.layer4?.setSubtypes !== undefined)
			)
			.sort((a, b) => a.timestamp - b.timestamp);
		for (const eff of sorted) {
			for (const aff of eff.affected) {
				const target = workMap.get(aff.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
				const overwrittenByLaterAttached = workList.some(
					(att) =>
						att.inst.attachedToId === target.inst.instanceId &&
						!att.strippedByAttachment &&
						att.abilityRemovalEvents.length === 0 &&
						att.timestamp > eff.timestamp &&
						att.statics.some(
							(st) =>
								st.k === 'continuous' &&
								st.layer === '4' &&
								st.affected === 'attachedTo' &&
								st.mod.k === 'setTypes' &&
								(!st.condition || evaluateLayerCondition(st.condition, state, workList, att, target))
						)
				);
				if (overwrittenByLaterAttached) continue;
				if (eff.layer4?.setTypes?.length) {
					target.types = [...eff.layer4.setTypes];
					target.hasAllCreatureTypes = false;
				}
				if (eff.layer4?.setSubtypes !== undefined) {
					const settingLandSubtypes = eff.layer4.setSubtypes.some((sub) => LAND_SUBTYPES.has(sub));
					let retainedSubtypes: string[] = [];
					if (settingLandSubtypes) {
						retainedSubtypes = target.subtypes.filter((sub) => !LAND_SUBTYPES.has(sub));
					} else if (!eff.layer4.setTypes?.length) {
						// CR 205.1b: Additive card types (e.g. "[subtype] artifact creature") retain subtypes
						// correlated with retained non-creature card types (such as land subtypes).
						retainedSubtypes = target.subtypes.filter((sub) =>
							(target.types.includes('Land') && LAND_SUBTYPES.has(sub)) ||
							((target.types.includes('Artifact') || eff.layer4?.addTypes?.includes('Artifact')) &&
								(sub === 'Equipment' ||
									sub === 'Vehicle' ||
									sub === 'Fortification' ||
									sub === 'Treasure' ||
									sub === 'Clue' ||
									sub === 'Food' ||
									sub === 'Blood' ||
									sub === 'Map' ||
									sub === 'Powerstone' ||
									sub === 'Gold' ||
									sub === 'Junk'))
						);
					}
					target.subtypes = [...eff.layer4.setSubtypes, ...retainedSubtypes];
					target.hasAllCreatureTypes = false;
				}
				const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
				const typeStr = target.types.join(' ');
				const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
				target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
				if (!target.typeModifiedBy.includes(eff.sourceName)) target.typeModifiedBy.push(eff.sourceName);
			}
		}
	}

	// --- Track P15: CR 702.176a (Impending) & CR 702.151b (Reconfigure) Layer 4 Creature-type removal ---
	for (const target of workList) {
		if (target.strippedByAttachment || target.abilityRemovalEvents.length > 0) continue;
		const losesCreatureViaImpending =
			Boolean(target.inst.castWithImpending) &&
			(target.inst.counters.time || 0) > 0 &&
			workHasActiveKeyword(target, 'impending');
		const losesCreatureViaReconfigure =
			target.inst.attachedToId !== null &&
			workMap.has(target.inst.attachedToId) &&
			workHasActiveKeyword(target, 'reconfigure');
		if ((losesCreatureViaImpending || losesCreatureViaReconfigure) && target.types.includes('Creature')) {
			target.types = target.types.filter((t) => t !== 'Creature');
			const retainsCreatureSubtypes = target.types.some(
				(t) => normalizeLayerCardType(t) === 'kindred'
			);
			if (!retainsCreatureSubtypes) {
				target.subtypes = target.subtypes.filter((sub) => NON_CREATURE_SUBTYPES.has(sub));
				target.hasAllCreatureTypes = false;
			}
			const superPrefix = target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
			const typeStr = target.types.join(' ');
			const subStr = target.subtypes.length > 0 ? ` — ${target.subtypes.join(' ')}` : '';
			target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`;
			const srcReason = losesCreatureViaImpending ? 'Impending' : 'Reconfigure';
			if (!target.typeModifiedBy.includes(srcReason)) {
				target.typeModifiedBy.push(srcReason);
			}
		}
	}
	// --- End Track P15 ---
}

function evaluateAdditiveTypesAndColors(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	const latestSetTypesTimestampOn = (target: PermWorkState): number => {
		let maxTs = -Infinity;
		for (const att of workList) {
			if (
				att.inst.attachedToId !== target.inst.instanceId ||
				att.strippedByAttachment ||
				att.abilityRemovalEvents.length > 0
			) {
				continue;
			}
			for (const st of att.statics) {
				if (
					st.k === 'continuous' &&
					st.layer === '4' &&
					st.affected === 'attachedTo' &&
					st.mod.k === 'setTypes' &&
					(!st.condition || evaluateLayerCondition(st.condition, state, workList, att, target))
				) {
					if (att.timestamp > maxTs) maxTs = att.timestamp;
				}
			}
		}
		if (state.timedContinuousEffects?.length) {
			for (const eff of state.timedContinuousEffects) {
				if (!isTimedContinuousEffectActive(eff, workMap) || !eff.layer4?.setTypes?.length) continue;
				if (
					eff.affected.some(
						(a) =>
							a.instanceId === target.inst.instanceId &&
							(a.objectVersion ?? 1) === (target.inst.objectVersion ?? 1)
					)
				) {
					if (eff.timestamp > maxTs) maxTs = eff.timestamp;
				}
			}
		}
		return maxTs;
	};

	// 4. Layer 4 Pass C: Attached & global additive type effects (Awaken the Ancient, Opalescence, Urborg, Yavimaya, Mycosynth Lattice, Maskwood Nexus)
	// --- Track P14 ---
	const latestRemovedTypeTs = new Map<string, number>();
	// --- End Track P14 ---
	const additiveSources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of additiveSources) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '4') continue;
			if (
				st.affected !== 'self' &&
				st.affected !== 'attachedTo' &&
				typeof st.affected !== 'object'
			) {
				continue;
			}
			const candidateTargets: PermWorkState[] =
				st.affected === 'self'
					? [source]
					: st.affected === 'attachedTo'
						? source.inst.attachedToId && workMap.has(source.inst.attachedToId)
							? [workMap.get(source.inst.attachedToId)!]
							: []
						: workList;
			if (st.mod.k === 'addChosenSubtype') {
				const chosenSub = source.inst.chosenSubType;
				if (!chosenSub) continue;
				for (const target of candidateTargets) {
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (
						(st.affected === 'attachedTo' || st.affected === 'self') &&
						latestSetTypesTimestampOn(target) > source.timestamp
					) {
						continue;
					}
					if (!target.subtypes.some((s) => s.toLowerCase() === chosenSub.toLowerCase())) {
						target.subtypes.push(chosenSub);
					}
					const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, chosenSub);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
					}
					if (!target.typeModifiedBy.includes(source.name)) {
						target.typeModifiedBy.push(source.name);
					}
				}
			} else if (st.mod.k === 'addTypes') {
				for (const target of candidateTargets) {
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (st.affected === 'attachedTo' && latestSetTypesTimestampOn(target) > source.timestamp) {
						continue;
					}
					for (const ct of st.mod.types) {
						if (!target.types.includes(ct)) target.types.push(ct);
						const nextType = addCardTypeToTypeLine(target.effectiveTypeLine, ct);
						if (nextType !== target.effectiveTypeLine) {
							target.effectiveTypeLine = nextType;
							if (!target.typeModifiedBy.includes(source.name)) {
								target.typeModifiedBy.push(source.name);
							}
						}
					}
					for (const sub of st.mod.subtypes ?? []) {
						if (!target.subtypes.includes(sub)) target.subtypes.push(sub);
						const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, sub);
						if (nextType !== target.effectiveTypeLine) {
							target.effectiveTypeLine = nextType;
						}
						if (!target.typeModifiedBy.includes(source.name)) {
							target.typeModifiedBy.push(source.name);
						}
					}
				}
			} else if (st.mod.k === 'allCreatureTypes' && typeof st.affected === 'object') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					target.hasAllCreatureTypes = true;
					target.effectiveTypeLine = addSubtypeToTypeLine(target.effectiveTypeLine, 'All-Types');
					if (!target.typeModifiedBy.includes(source.name)) {
						target.typeModifiedBy.push(source.name);
					}
				}
			// --- Track P14 (CR 700.5, CR 613.1d, CR 205.1a): Layer 4 type removal (Theros Gods, etc.) ---
			} else if (st.mod.k === 'removeTypes') {
				for (const target of candidateTargets) {
					if (
						typeof st.affected === 'object' &&
						!matchesLayerFilter(st.affected, target, source, state, workList)
					) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (
						(st.affected === 'attachedTo' || st.affected === 'self') &&
						latestSetTypesTimestampOn(target) > source.timestamp
					) {
						continue;
					}
					let changed = false;
					let removedCreature = false;
					for (const rt of st.mod.types) {
						const rtLow = rt.toLowerCase();
						latestRemovedTypeTs.set(`${target.inst.instanceId}:${rtLow}`, source.timestamp);
						const beforeLen = target.types.length;
						target.types = target.types.filter((t) => t.toLowerCase() !== rtLow);
						if (target.types.length !== beforeLen) {
							changed = true;
							if (rtLow === 'creature') removedCreature = true;
						}
					}
					if (changed) {
						// CR 205.1a: Removing Creature (when neither Creature nor Kindred/Tribal remains)
						// also removes creature subtypes (such as God).
						if (
							removedCreature &&
							!target.types.some((t) => {
								const nl = normalizeLayerCardType(t);
								return nl === 'creature' || nl === 'kindred' || nl === 'planeswalker';
							})
						) {
							target.subtypes = target.subtypes.filter(
								(sub) => LAND_SUBTYPES.has(sub) || NON_CREATURE_SUBTYPES.has(sub)
							);
							target.hasAllCreatureTypes = false;
						}
						const superPrefix =
							target.supertypes.length > 0 ? `${target.supertypes.join(' ')} ` : '';
						const typeStr = target.types.join(' ');
						const rightParts = [...target.subtypes];
						if (
							target.hasAllCreatureTypes &&
							target.types.some((t) => {
								const nl = normalizeLayerCardType(t);
								return nl === 'creature' || nl === 'kindred';
							}) &&
							!rightParts.includes('All-Types')
						) {
							rightParts.push('All-Types');
						}
						const subStr = rightParts.length > 0 ? ` — ${rightParts.join(' ')}` : '';
						target.effectiveTypeLine = `${superPrefix}${typeStr}${subStr}`.trim();
						if (!target.typeModifiedBy.includes(source.name)) {
							target.typeModifiedBy.push(source.name);
						}
					}
				}
			}
			// --- End Track P14 ---
		}
	}
	if (state.timedContinuousEffects?.length) {
		const sorted = [...state.timedContinuousEffects]
			.filter(
				(e) =>
					isTimedContinuousEffectActive(e, workMap) &&
					(e.layer4?.addTypes?.length || e.layer4?.addSubtypes?.length)
			)
			.sort((a, b) => a.timestamp - b.timestamp);
		for (const eff of sorted) {
			for (const aff of eff.affected) {
				const target = workMap.get(aff.instanceId);
				if (!target || (target.inst.objectVersion ?? 1) !== (aff.objectVersion ?? 1)) continue;
				if (latestSetTypesTimestampOn(target) > eff.timestamp) continue;
				for (const ct of eff.layer4?.addTypes ?? []) {
					// --- Track P14 ---
					const remTs = latestRemovedTypeTs.get(`${target.inst.instanceId}:${ct.toLowerCase()}`);
					if (remTs !== undefined && remTs > eff.timestamp) continue;
					// --- End Track P14 ---
					if (!target.types.includes(ct)) target.types.push(ct);
					const nextType = addCardTypeToTypeLine(target.effectiveTypeLine, ct);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
						if (!target.typeModifiedBy.includes(eff.sourceName)) {
							target.typeModifiedBy.push(eff.sourceName);
						}
					}
				}
				for (const sub of eff.layer4?.addSubtypes ?? []) {
					if (!target.subtypes.includes(sub)) target.subtypes.push(sub);
					const nextType = addSubtypeToTypeLine(target.effectiveTypeLine, sub);
					if (nextType !== target.effectiveTypeLine) {
						target.effectiveTypeLine = nextType;
					}
					if (!target.typeModifiedBy.includes(eff.sourceName)) {
						target.typeModifiedBy.push(eff.sourceName);
					}
				}
			}
		}
	}
	// --- Track P13 (CR 701.54c, CR 613.1d): Ring Level >= 1 makes your Ring-bearer Legendary ---
	for (const p of state.players) {
		if (p.lost || (p.ringLevel ?? 0) < 1 || !p.ringBearerId) continue;
		const target = workMap.get(p.ringBearerId);
		if (!target || target.controllerId !== p.playerId || !target.types.includes('Creature')) {
			continue;
		}
		if (!target.supertypes.includes('Legendary')) {
			target.supertypes.unshift('Legendary');
		}
		target.isLegendary = true;
		target.prefixLegendary = 'Legendary ';
		if (!/\bLegendary\b/.test(target.effectiveTypeLine)) {
			target.effectiveTypeLine = `Legendary ${target.effectiveTypeLine}`;
		}
		if (!target.typeModifiedBy.includes('The Ring')) {
			target.typeModifiedBy.push('The Ring');
		}
	}
	// --- End Track P13 ---
}

function evaluateLayer5Colors(
	state: GameState,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	const applyColorMod = (
		target: PermWorkState,
		mod: { setColors?: ManaColor[]; addColors?: ManaColor[] }
	): void => {
		if (mod.setColors !== undefined) {
			target.colors = [...mod.setColors];
		}
		if (mod.addColors) {
			for (const c of mod.addColors) {
				if (!target.colors.includes(c)) target.colors.push(c);
			}
		}
	};

	// 5a. Layer 5 CDAs (CR 613.3: applied first; CR 613.6: unaffected by Layer 6 ability removal).
	for (const source of workList) {
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '5' || st.affected !== 'self') continue;
			if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, source)) {
				continue;
			}
			applyColorMod(source, {
				setColors: st.mod.k === 'setColors' ? st.mod.colors : undefined,
				addColors: st.mod.k === 'addColors' ? st.mod.colors : undefined
			});
		}
	}

	// 5b. Non-CDA Layer 5 effects (attached, global, timed) sorted by timestamp (CR 613.3, 613.7).
	interface Layer5Op {
		timestamp: number;
		target: PermWorkState;
		setColors?: ManaColor[];
		addColors?: ManaColor[];
	}
	const ops: Layer5Op[] = [];
	const layer5Sources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of layer5Sources) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '5') continue;
			if (st.affected === 'self' && st.mod.k !== 'setChosenColor') continue;
			if (
				st.mod.k !== 'setColors' &&
				st.mod.k !== 'addColors' &&
				st.mod.k !== 'setChosenColor'
			) {
				continue;
			}
			const chosenColors =
				st.mod.k === 'setChosenColor'
					? source.inst.chosenColor
						? source.inst.chosenColor === 'C'
							? []
							: [source.inst.chosenColor]
						: undefined
					: undefined;
			if (st.mod.k === 'setChosenColor' && chosenColors === undefined) continue;
			let targets: PermWorkState[] = [];
			if (st.affected === 'self') {
				targets = [source];
			} else if (st.affected === 'attachedTo') {
				const hostId = source.inst.attachedToId;
				const host = hostId ? workMap.get(hostId) : undefined;
				if (host) targets = [host];
			} else if (typeof st.affected === 'object') {
				targets = workList.filter((t) =>
					matchesLayerFilter(st.affected as ObjectFilter, t, source, state, workList)
				);
			}
			for (const target of targets) {
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
				) {
					continue;
				}
				ops.push({
					timestamp: source.timestamp,
					target,
					setColors:
						st.mod.k === 'setColors'
							? st.mod.colors
							: st.mod.k === 'setChosenColor'
								? chosenColors
								: undefined,
					addColors: st.mod.k === 'addColors' ? st.mod.colors : undefined
				});
			}
		}
	}
	if (state.timedContinuousEffects?.length) {
		for (const eff of state.timedContinuousEffects) {
			if (!eff.layer5 || !isTimedContinuousEffectActive(eff, workMap)) continue;
			for (const ref of eff.affected) {
				const target = workMap.get(ref.instanceId);
				if (!target) continue;
				if ((target.inst.objectVersion ?? 1) !== (ref.objectVersion ?? 1)) continue;
				ops.push({
					timestamp: eff.timestamp,
					target,
					setColors: eff.layer5.setColors,
					addColors: eff.layer5.addColors
				});
			}
		}
	}
	ops.sort((a, b) => a.timestamp - b.timestamp);
	for (const op of ops) {
		applyColorMod(op.target, op);
	}
}

function evaluateGlobalAbilityLoss(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// 5. Layer 6 Global "lose all abilities" (Humility, Dress Down)
	const abilityLossSources = emblemWorkList.length > 0 ? [...workList, ...emblemWorkList] : workList;
	for (const source of abilityLossSources) {
		if (source.strippedByAttachment || source.statics.length === 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || typeof st.affected !== 'object') continue;
			if (st.layer === '6' && st.mod.k === 'removeAllAbilities') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					recordAbilityRemoval(target, source.name, source.timestamp);
				}
			}
		}
	}
}

// --- Track P8 ---
function grantStatModItem(
	work: PermWorkState,
	canonicalKey: string,
	name: string,
	sourceName: string,
	grantTimestamp: number
): void {
	const keyLow = canonicalKey.toLowerCase();
	const id = `granted_${work.items.length}_${keyLow}`;
	work.itemTimestamps.set(id, grantTimestamp);
	const item: AttributedKeywordOrEffect = {
		id,
		canonicalKey: keyLow,
		name,
		kind: 'stat_mod',
		isInnate: false,
		sources: [sourceName],
		grantCount: 1,
		removed: false,
		removedBy: []
	};
	let lastInnate = -1;
	let lastFromSource = -1;
	for (let i = 0; i < work.items.length; i++) {
		if (work.items[i].isInnate) lastInnate = i;
		if (work.items[i].sources.includes(sourceName)) {
			lastFromSource = i;
		}
	}
	const insertAfter = Math.max(lastInnate, lastFromSource);
	if (lastFromSource >= 0 && insertAfter < work.items.length - 1) {
		work.items.splice(insertAfter + 1, 0, item);
	} else {
		work.items.push(item);
	}
}

function evaluatePerPermanent(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>,
	// --- Track P13 ---
	emblemWorkList: PermWorkState[] = []
	// --- End Track P13 ---
): void {
	// --- Track P8: Strict CR 613.1 layer ordering across all permanents ---
	// 6a. Pre-initialize Layer 6 working P/T (printed / Layer 1 copy values; * = 0 prior to Layer 7a).
	for (const target of workList) {
		if (!target.types.includes('Creature')) {
			target.workingPower = null;
			target.workingToughness = null;
		} else {
			if (target.workingPower === null) target.workingPower = 0;
			if (target.workingToughness === null) target.workingToughness = 0;
		}
	}

	// --- Track P11 + Track P13 ---
	let anyGrantedStaticInBoard = false;
	const staticSources =
		emblemWorkList.length > 0
			? [
					...workList.filter((w) => w.statics.length > 0 && !w.strippedByAttachment),
					...emblemWorkList.filter((e) => e.statics.length > 0)
				].sort((a, b) => a.timestamp - b.timestamp)
			: workList.filter((w) => w.statics.length > 0 && !w.strippedByAttachment);
	// --- End Track P11 + Track P13 ---
	// --- Track P14 (CR 113.6b): Graveyard continuous statics (Wonder, Brawn, Anger, Filth, Valor, Glory) ---
	layerReads |= READ_P14;
	const graveyardStaticSources: PermWorkState[] = [];
	for (let pi = 0; pi < state.players.length; pi++) {
		const pl = state.players[pi];
		if (pl.lost || pl.graveyard.length === 0) continue;
		const gyEntries = collectGraveyardContinuousStaticsForPlayer(pl);
		if (gyEntries.length === 0) continue;
		const byInst = new Map<CardInstance, StaticDef[]>();
		for (let gi = 0; gi < gyEntries.length; gi++) {
			const e = gyEntries[gi];
			let list = byInst.get(e.cardInst);
			if (!list) {
				list = [];
				byInst.set(e.cardInst, list);
			}
			list.push(e.staticDef);
		}
		for (const [gyInst, gyStatics] of byInst) {
			const gyCard = effectiveCardForObject(gyInst);
			const gyView = resolveObjectFaces(gyCard, instanceFaceOptions(gyInst, 'graveyard'));
			const gyWork: PermWorkState = {
				inst: gyInst,
				controllerId: pl.playerId,
				baseCard: gyCard,
				timestamp: gyInst.enteredTimestamp ?? 0,
				name: gyView.name,
				manaCost: gyView.manaCost,
				manaValue: gyView.manaValue,
				isFaceDown: false,
				baseTypeLine: gyView.typeLine,
				effectiveTypeLine: gyView.typeLine,
				supertypes: [...gyView.supertypes],
				types: [...gyView.types],
				subtypes: normalizeSubtypes(gyView.subtypes),
				colors: [...gyView.colors],
				isLegendary: gyView.supertypes.includes('Legendary'),
				prefixLegendary: gyView.supertypes.includes('Legendary') ? 'Legendary ' : '',
				hasAllCreatureTypes: false,
				basePower: gyView.power ?? null,
				baseToughness: gyView.toughness ?? null,
				workingPower: gyView.power ?? null,
				workingToughness: gyView.toughness ?? null,
				typeModifiedBy: [],
				ptModifiedBy: [],
				allAbilityRemovalSources: [],
				abilityRemovalEvents: [],
				layer7bSetters: [],
				items: [],
				itemTimestamps: new Map(),
				statics: gyStatics,
				grantsKeywordViaAbility: new Set(),
				strippedByAttachment: false
			};
			graveyardStaticSources.push(gyWork);
			staticSources.push(gyWork);
		}
	}
	if (graveyardStaticSources.length > 0) {
		staticSources.sort((a, b) => a.timestamp - b.timestamp);
	}
	// --- End Track P14 ---
	// 6b. Layer 6 across ALL permanents (CR 613.1f): innate removal, Layer 6 grants/removals, cantHaveLocks, Suspend/Blitz haste.
	for (const target of workList) {
		const targetVersion = target.inst.objectVersion ?? 1;
		const matchingTimedCont: TimedContinuousEffect[] = [];
		if (state.timedContinuousEffects?.length) {
			for (const eff of state.timedContinuousEffects) {
				if (!isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					matchingTimedCont.push(eff);
				}
			}
		}

		// Mark innate items as removed if any ability-removal source applies
		if (target.allAbilityRemovalSources.length > 0) {
			for (const item of target.items) {
				if (item.isInnate) {
					item.removed = true;
					for (const src of target.allAbilityRemovalSources) {
						if (!item.removedBy.includes(src)) {
							item.removedBy.push(src);
						}
					}
				}
			}
		}

		const targetTimedEffects: TimedKeywordEffect[] = [];
		const timedGrantedCounts = new Map<string, number>();
		if (state.timedKeywordEffects?.length) {
			for (const eff of state.timedKeywordEffects) {
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					targetTimedEffects.push(eff);
					for (const kw of eff.addKeywords ?? []) {
						const gLow = kw.toLowerCase();
						timedGrantedCounts.set(gLow, (timedGrantedCounts.get(gLow) ?? 0) + 1);
					}
				}
			}
		}
		for (const eff of matchingTimedCont) {
			// --- Track P10 ---
			let extraQuotedKws: string[] | undefined;
			if (eff.layer6?.grantedAbilityTexts?.length) {
				for (const gt of eff.layer6.grantedAbilityTexts) {
					for (const def of resolveQuotedAbilityDefs(gt, target.name)) {
						if (def.kind === 'keyword') {
							(extraQuotedKws ??= []).push(def.keyword.name);
						}
					}
				}
			}
			const combinedAddKws = extraQuotedKws
				? [...(eff.layer6?.addKeywords ?? []), ...extraQuotedKws]
				: eff.layer6?.addKeywords;
			// --- End Track P10 ---
			if (eff.layer6 && (combinedAddKws?.length || eff.layer6.removeKeywords?.length)) {
				targetTimedEffects.push({
					timestamp: eff.timestamp,
					sourceName: eff.sourceName,
					controllerId: eff.controllerId,
					affected: eff.affected,
					addKeywords: combinedAddKws,
					removeKeywords: eff.layer6.removeKeywords,
					cantHaveOrGain: eff.layer6.cantHaveOrGain
				});
			}
			// --- Track P12: Backup-granted keywords in Layer 6 (CR 702.165a–d) ---
			if (eff.backupGrant) {
				const bDef = compileCard(eff.backupGrant.sourceCard);
				const faceAbs =
					eff.backupGrant.faceIndex > 0 && bDef.faces?.[eff.backupGrant.faceIndex]
						? bDef.faces[eff.backupGrant.faceIndex].abilities
						: (bDef.faces[0]?.abilities ?? []);
				const grantedKws: string[] = [];
				for (let bi = Math.max(0, eff.backupGrant.startAbilityIndex); bi < faceAbs.length; bi++) {
					const fAb = faceAbs[bi];
					if (fAb.kind === 'keyword') grantedKws.push(fAb.keyword.name);
				}
				if (grantedKws.length > 0) {
					targetTimedEffects.push({
						timestamp: eff.timestamp,
						sourceName: eff.sourceName,
						controllerId: eff.controllerId,
						affected: eff.affected,
						addKeywords: grantedKws
					});
				}
			}
			// --- End Track P12 ---
		}
		// --- Track P11 (CR 122.1b, 613.7c): Keyword counters grant their keyword in Layer 6 at counter timestamp ---
		layerReads |= READ_KEYWORD_COUNTERS;
		const targetKwCounterMask = computeKeywordCounterMask(target.inst.counters);
		if (targetKwCounterMask !== 0) {
			for (let ki = 0; ki < KEYWORD_COUNTER_TYPES.length; ki++) {
				if (!(targetKwCounterMask & (1 << ki))) continue;
				const kw = KEYWORD_COUNTER_TYPES[ki];
				const kwTs = target.inst.counterTimestamps?.[kw] ?? target.timestamp;
				targetTimedEffects.push({
					timestamp: kwTs,
					sourceName: `${formatKeywordLabel(kw)} counter`,
					controllerId: target.controllerId,
					affected: [
						{ instanceId: target.inst.instanceId, objectVersion: target.inst.objectVersion ?? 1 }
					],
					addKeywords: [kw]
				});
			}
		}
		// --- End Track P11 ---
		if (targetTimedEffects.length > 1) {
			targetTimedEffects.sort((a, b) => a.timestamp - b.timestamp);
		}

		// Direct array mutations on `grantedKeywords` (e.g. unit tests bypassing `executeEffectSteps`)
		// carry no timestamp; apply those not already backed by `timedKeywordEffects` at timestamp 0.
		for (const gKw of target.inst.grantedKeywords || []) {
			const gLow = gKw.toLowerCase();
			const tracked = timedGrantedCounts.get(gLow) ?? 0;
			if (tracked > 0) {
				timedGrantedCounts.set(gLow, tracked - 1);
				continue;
			}
			let sourceLabel = 'Temporary Effect';
			for (const w of workList) {
				if (
					w.controllerId === target.controllerId &&
					w.grantsKeywordViaAbility.has(gLow)
				) {
					sourceLabel = w.baseCard.name;
					break;
				}
			}
			grantKeywordString(target, gKw, sourceLabel, 0);
		}

		const cantHaveLocks: Array<{ keywords: readonly string[]; sourceName: string }> = [];
		const applyTimedEffect = (eff: TimedKeywordEffect): void => {
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, eff.timestamp);
			}
			if (eff.addKeywords?.length) {
				const sourceLabel = eff.sourceName || 'Temporary Effect';
				for (const kw of eff.addKeywords) {
					grantKeywordString(target, kw, sourceLabel, eff.timestamp);
				}
			}
			if (eff.removeKeywords?.length) {
				removeMatchingKeywordsUpTo(target, eff.removeKeywords, eff.sourceName, eff.timestamp);
				if (eff.cantHaveOrGain) {
					cantHaveLocks.push({ keywords: eff.removeKeywords, sourceName: eff.sourceName });
				}
			}
		};

		let timedIdx = 0;

		// CR 702.152a: "As long as this permanent's blitz cost was paid, it has haste"
		if (
			target.inst.blitzed &&
			!target.isFaceDown &&
			!target.strippedByAttachment &&
			target.allAbilityRemovalSources.length === 0
		) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Blitz', target.timestamp);
		}
		// --- Track P9 ---
		// CR 702.109a: "As long as this permanent's dash cost was paid, it has haste."
		if (
			target.inst.dashed &&
			!target.isFaceDown &&
			!target.strippedByAttachment &&
			target.allAbilityRemovalSources.length === 0
		) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Dash', target.timestamp);
		}
		// CR 702.136a: Riot haste option ("If you don't, it gains haste").
		if (target.inst.riotHaste) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Riot', target.timestamp);
		}
		// --- Track P10 (CR 701.60c): Suspected permanents have menace ---
		if (target.inst.isSuspected) {
			grantItem(target, 'menace', 'Menace', 'keyword', 'Suspected', target.timestamp);
		}
		// --- End Track P10 ---

		for (const source of staticSources) {
			while (
				timedIdx < targetTimedEffects.length &&
				targetTimedEffects[timedIdx].timestamp <= source.timestamp
			) {
				applyTimedEffect(targetTimedEffects[timedIdx++]);
			}
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, source.timestamp);
			}

			const sourceLostAbilities = source.allAbilityRemovalSources.length > 0;

			// A. Attached Layer 4/6 effects on `target`
			if (source.inst.attachedToId === target.inst.instanceId) {
				let basePtSuffix = '';
				for (const st of source.statics) {
					if (
						st.k === 'continuous' &&
						st.layer === '7b' &&
						st.affected === 'attachedTo' &&
						st.mod.k === 'setBasePT'
					) {
						const p = evaluateLayerAmount(st.mod.power, state, workList, source, target);
						const t = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
						basePtSuffix = ` (${p}/${t})`;
					}
				}

				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected !== 'attachedTo' || st.mod.k === 'pt') continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					if (st.mod.k === 'setTypes') {
						if (st.mod.types.includes('Creature') && (st.mod.subtypes ?? []).length > 0) {
							const sub = st.mod.subtypes![0];
							const typeLabel = `${st.mod.types.join(' ')} — ${st.mod.subtypes!.join(' ')}${basePtSuffix}`;
							grantItem(
								target,
								`type_${sub.toLowerCase()}`,
								`Type: ${typeLabel}`,
								'type_mod',
								source.name,
								source.timestamp
							);
						} else if (st.mod.types.includes('Land')) {
							const sub = st.mod.subtypes?.[0];
							if (sub && BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()]) {
								const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
								grantItem(
									target,
									`mana_${info.sym.toLowerCase()}`,
									`Mana Ability: Add {${info.sym}}`,
									'ability',
									source.name,
									source.timestamp,
									{ grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor) }
								);
								grantItem(
									target,
									`type_${info.subtype.toLowerCase()}`,
									`Type: Land — ${info.subtype}`,
									'type_mod',
									source.name,
									source.timestamp
								);
							} else {
								for (const st2 of source.statics) {
									if (
										st2.k === 'continuous' &&
										st2.affected === 'attachedTo' &&
										st2.mod.k === 'grantAbility' &&
										st2.mod.ability.kind === 'activated'
									) {
										const desc = describeGrantedActivatedAbility(
											st2.mod.ability,
											source.inst.instanceId
										);
										grantItem(
											target,
											desc.key,
											desc.name,
											'ability',
											source.name,
											source.timestamp,
											{
												grantedAbility: st2.mod.ability,
												grantSourceCard: source.baseCard,
												grantSourceId: source.inst.instanceId
											}
										);
									}
								}
								grantItem(
									target,
									'type_land',
									'Type: Colorless Land',
									'type_mod',
									source.name,
									source.timestamp
								);
							}
						}
					} else if (st.mod.k === 'addTypes' && st.mod.types.includes('Creature')) {
						const sub = st.mod.subtypes?.[0] ?? 'creature';
						const subSuffix = st.mod.subtypes?.length ? ` — ${st.mod.subtypes.join(' ')}` : '';
						const typeLabel = `${st.mod.types.join(' ')}${subSuffix}${basePtSuffix}`;
						grantItem(
							target,
							`type_${sub.toLowerCase()}`,
							`Type: ${typeLabel}`,
							'type_mod',
							source.name,
							source.timestamp
						);
					} else if (st.mod.k === 'grantAbility' && st.mod.ability.kind === 'activated') {
						const alreadyGrantedInLandSet = source.statics.some(
							(s2) =>
								s2.k === 'continuous' &&
								s2.affected === 'attachedTo' &&
								s2.mod.k === 'setTypes' &&
								s2.mod.types.includes('Land') &&
								!(s2.mod.subtypes?.[0] && BASIC_LAND_MANA_BY_SUBTYPE[s2.mod.subtypes[0].toLowerCase()])
						);
						if (!alreadyGrantedInLandSet) {
							const desc = describeGrantedActivatedAbility(st.mod.ability, source.inst.instanceId);
							grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
								grantedAbility: st.mod.ability,
								grantSourceCard: source.baseCard,
								grantSourceId: source.inst.instanceId
							});
						}
					// --- Track P11 ---
					} else if (st.mod.k === 'grantAbility') {
						if (grantNonActivatedAbility(target, source, st, st.mod.ability)) {
							anyGrantedStaticInBoard = true;
						}
					// --- End Track P11 ---
					} else if (st.mod.k === 'addKeywords') {
						// --- Track P14 ---
						const protMeta: GrantedAbilityMeta | undefined = st.mod.protectionAttachmentExemption
							? {
									grantSourceId: source.inst.instanceId,
									protectionExemption: {
										mode: st.mod.protectionAttachmentExemption,
										sourceId: source.inst.instanceId,
										controllerId: source.controllerId
									}
								}
							: undefined;
						// --- End Track P14 ---
						for (const kw of sortGrantedKeywords(st.mod.keywords)) {
							const kwLow = kw.toLowerCase();
							if (kwLow.startsWith('ward')) {
								grantKeywordString(target, kw, source.name, source.timestamp);
								continue;
							}
							const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
							grantItem(
								target,
								key,
								formatKeywordLabel(kwLow),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								key === 'protection' ? protMeta : undefined
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenColor') {
						const chosenCol = source.inst.chosenColor;
						const kw = chosenCol ? PROTECTION_KEYWORD_BY_COLOR[chosenCol] : undefined;
						if (kw) {
							// --- Track P14 ---
							const chosenProtMeta: GrantedAbilityMeta | undefined = st.mod
								.protectionAttachmentExemption
								? {
										grantSourceId: source.inst.instanceId,
										protectionExemption: {
											mode: st.mod.protectionAttachmentExemption,
											sourceId: source.inst.instanceId,
											controllerId: source.controllerId
										}
									}
								: undefined;
							// --- End Track P14 ---
							grantItem(
								target,
								'protection',
								formatKeywordLabel(kw),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								chosenProtMeta
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'removeKeywords') {
						removeMatchingKeywordsUpTo(target, st.mod.keywords, source.name, source.timestamp);
						if (st.mod.cantHaveOrGain) {
							cantHaveLocks.push({ keywords: st.mod.keywords, sourceName: source.name });
						}
					}
				}
			}

			// B. Self & Global Layer 4/6 effects from `source` (only if `source` has not lost all abilities)
			if (!sourceLostAbilities) {
				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected === 'attachedTo') continue;
					if (st.layer !== '4' && st.layer !== '6') continue;
					if (st.affected === 'self') {
						if (source.inst.instanceId !== target.inst.instanceId) continue;
					} else {
						if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}

					if (st.layer === '4' && st.mod.k === 'setSubtypes') {
						const sub = st.mod.subtypes[0];
						const info = sub ? BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()] : undefined;
						if (info) {
							grantItem(
								target,
								`mana_${info.sym.toLowerCase()}`,
								`Mana Ability: Add {${info.sym}}`,
								'ability',
								source.name,
								source.timestamp,
								{ grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor) }
							);
							grantItem(
								target,
								`type_${info.subtype.toLowerCase()}`,
								`Type: Land — ${info.subtype}`,
								'type_mod',
								source.name,
								source.timestamp
							);
						}
					} else if (st.layer === '4' && st.mod.k === 'addTypes' && st.mod.subtypes?.length) {
						for (const sub of st.mod.subtypes) {
							const info = BASIC_LAND_MANA_BY_SUBTYPE[sub.toLowerCase()];
							if (info) {
								grantItem(
									target,
									`mana_${info.sym.toLowerCase()}`,
									`Mana Ability: Add {${info.sym}}`,
									'ability',
									source.name,
									source.timestamp,
									{ grantedAbility: makeIntrinsicBasicManaAbility(info.sym as ManaColor) }
								);
								grantItem(
									target,
									info.subtype === 'Forest'
										? 'type_forest_add'
										: `type_${info.subtype.toLowerCase()}`,
									`Subtype: +${info.subtype}`,
									'type_mod',
									source.name,
									source.timestamp
								);
							}
						}
					} else if (st.layer === '4' && st.mod.k === 'allCreatureTypes') {
						grantItem(
							target,
							'changeling',
							'Changeling (All Creature Types)',
							'keyword',
							source.name,
							source.timestamp
						);
					} else if (
						st.layer === '6' &&
						st.mod.k === 'grantAbility' &&
						st.mod.ability.kind === 'activated'
					) {
						const desc = describeGrantedActivatedAbility(st.mod.ability, source.inst.instanceId);
						grantItem(target, desc.key, desc.name, 'ability', source.name, source.timestamp, {
							grantedAbility: st.mod.ability,
							grantSourceCard: source.baseCard,
							grantSourceId: source.inst.instanceId
						});
					// --- Track P11 ---
					} else if (st.layer === '6' && st.mod.k === 'grantAbility') {
						if (grantNonActivatedAbility(target, source, st, st.mod.ability)) {
							anyGrantedStaticInBoard = true;
						}
					// --- End Track P11 ---
					} else if (st.layer === '6' && st.mod.k === 'addKeywords') {
						if (st.affected === 'self' && !st.condition) continue; // already in innate items
						// --- Track P14 ---
						const protMeta: GrantedAbilityMeta | undefined = st.mod.protectionAttachmentExemption
							? {
									grantSourceId: source.inst.instanceId,
									protectionExemption: {
										mode: st.mod.protectionAttachmentExemption,
										sourceId: source.inst.instanceId,
										controllerId: source.controllerId
									}
								}
							: undefined;
						// --- End Track P14 ---
						for (const kw of sortGrantedKeywords(st.mod.keywords)) {
							const kwLow = kw.toLowerCase();
							if (kwLow.startsWith('ward')) {
								grantKeywordString(target, kw, source.name, source.timestamp);
								continue;
							}
							const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
							grantItem(
								target,
								key,
								formatKeywordLabel(kwLow),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								key === 'protection' ? protMeta : undefined
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'protectionFromChosenColor') {
						const chosenCol = source.inst.chosenColor;
						const kw = chosenCol ? PROTECTION_KEYWORD_BY_COLOR[chosenCol] : undefined;
						if (kw) {
							// --- Track P14 ---
							const chosenProtMeta: GrantedAbilityMeta | undefined = st.mod
								.protectionAttachmentExemption
								? {
										grantSourceId: source.inst.instanceId,
										protectionExemption: {
											mode: st.mod.protectionAttachmentExemption,
											sourceId: source.inst.instanceId,
											controllerId: source.controllerId
										}
									}
								: undefined;
							// --- End Track P14 ---
							grantItem(
								target,
								'protection',
								formatKeywordLabel(kw),
								'keyword',
								source.name,
								source.timestamp,
								// --- Track P14 ---
								chosenProtMeta
								// --- End Track P14 ---
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'removeKeywords') {
						removeMatchingKeywordsUpTo(target, st.mod.keywords, source.name, source.timestamp);
						if (st.mod.cantHaveOrGain) {
							cantHaveLocks.push({ keywords: st.mod.keywords, sourceName: source.name });
						}
					}
				}
			}
		}

		while (timedIdx < targetTimedEffects.length) {
			applyTimedEffect(targetTimedEffects[timedIdx++]);
		}

		applyRemovalsUpTo(target, Infinity);

		if (target.inst.castViaSuspend && target.types.includes('Creature')) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Suspend');
		}

		// CR 113.11: "can't have or gain [keyword]" prevents any grant regardless of timestamp.
		for (const lock of cantHaveLocks) {
			removeMatchingKeywordsUpTo(target, lock.keywords, lock.sourceName, Infinity);
		}
	}

	// 7a. Layer 7a across ALL permanents: Characteristic-Defining Abilities (CR 604.3 / 613.4a / 707.9d)
	for (const target of workList) {
		if (!target.types.includes('Creature')) continue;
		if (target.allAbilityRemovalSources.length > 0) continue;
		const effectiveCopy7a = !target.isFaceDown
			? (activeTimedLayer1aForPermanent(state, target.inst) ?? target.inst.copiableState)
			: undefined;
		const exceptPower = effectiveCopy7a?.except?.power;
		const exceptToughness = effectiveCopy7a?.except?.toughness;
		for (const st of target.statics) {
			if (st.k !== 'continuous' || st.layer !== '7a' || st.affected !== 'self') continue;
			if (
				st.condition &&
				!evaluateLayerCondition(st.condition, state, workList, target, target, workMap)
			) {
				continue;
			}
			if (st.mod.k === 'setBasePT') {
				if (exceptPower !== undefined && exceptToughness !== undefined) continue;
				const p = evaluateLayerAmount(st.mod.power, state, workList, target, target);
				const t = evaluateLayerAmount(st.mod.toughness, state, workList, target, target);
				if (exceptPower === undefined) target.workingPower = p;
				if (exceptToughness === undefined) target.workingToughness = t;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${target.workingPower}/${target.workingToughness})`
				);
			} else if (st.mod.k === 'setBasePower') {
				if (exceptPower !== undefined) continue;
				const p = evaluateLayerAmount(st.mod.power, state, workList, target, target);
				target.workingPower = p;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${p}/${target.workingToughness ?? 0})`
				);
			} else if (st.mod.k === 'setBaseToughness') {
				if (exceptToughness !== undefined) continue;
				const t = evaluateLayerAmount(st.mod.toughness, state, workList, target, target);
				target.workingToughness = t;
				target.ptModifiedBy.push(
					`${target.baseCard.name} CDA (${target.workingPower ?? 0}/${t})`
				);
			}
		}
	}

	// 7b. Layer 7b across ALL permanents: P/T-setting effects in timestamp order (CR 613.4b & 613.7)
	for (const source of staticSources) {
		const startedEarlier = source.statics.some(
			(s2) =>
				s2.k === 'continuous' &&
				(s2.layer === '4' || s2.layer === '5' || s2.layer === '6')
		);
		if (source.allAbilityRemovalSources.length > 0 && !startedEarlier) continue;
		for (const st of source.statics) {
			if (
				st.k !== 'continuous' ||
				st.layer !== '7b' ||
				(st.mod.k !== 'setBasePT' &&
					st.mod.k !== 'setBasePower' &&
					st.mod.k !== 'setBaseToughness')
			) {
				continue;
			}
			if (st.affected === 'self') {
				if (!source.types.includes('Creature') || source.allAbilityRemovalSources.length > 0) {
					continue;
				}
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, source, workMap)
				) {
					continue;
				}
				const p =
					st.mod.k === 'setBasePT' || st.mod.k === 'setBasePower'
						? evaluateLayerAmount(st.mod.power, state, workList, source, source)
						: undefined;
				const t =
					st.mod.k === 'setBasePT' || st.mod.k === 'setBaseToughness'
						? evaluateLayerAmount(st.mod.toughness, state, workList, source, source)
						: undefined;
				source.layer7bSetters.push({
					sourceName: source.name,
					...(p !== undefined ? { power: p } : {}),
					...(t !== undefined ? { toughness: t } : {}),
					timestamp: source.timestamp
				});
			} else if (typeof st.affected === 'object') {
				for (const target of workList) {
					if (!target.types.includes('Creature')) continue;
					if (!matchesLayerFilter(st.affected, target, source, state, workList)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const p =
						st.mod.k === 'setBasePT' || st.mod.k === 'setBasePower'
							? evaluateLayerAmount(st.mod.power, state, workList, source, target)
							: undefined;
					const t =
						st.mod.k === 'setBasePT' || st.mod.k === 'setBaseToughness'
							? evaluateLayerAmount(st.mod.toughness, state, workList, source, target)
							: undefined;
					target.layer7bSetters.push({
						sourceName: source.name,
						...(p !== undefined ? { power: p } : {}),
						...(t !== undefined ? { toughness: t } : {}),
						timestamp: source.timestamp
					});
				}
			}
		}
	}

	for (const target of workList) {
		const isCreature = target.types.includes('Creature');
		const targetVersion = target.inst.objectVersion ?? 1;
		if (isCreature && state.timedContinuousEffects?.length) {
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer7b || !isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) => a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					target.layer7bSetters.push({
						sourceName: eff.sourceName,
						power: eff.layer7b.setPower,
						toughness: eff.layer7b.setToughness,
						timestamp: eff.timestamp
					});
				}
			}
		}
		// --- Track P11: Layer 6 granted Layer 7b base-P/T statics (CR 613.4b, 107.3j) ---
		if (anyGrantedStaticInBoard) {
			for (const item of target.items) {
				if (item.removed || !item.grantedStaticAbility) continue;
				const gst = item.grantedStaticAbility;
				if (gst.k !== 'continuous' || gst.layer !== '7b' || gst.mod.k !== 'setBasePT') continue;
				const itemTs = target.itemTimestamps.get(item.id) ?? target.timestamp;
				const srcName = item.sources[0] ?? target.name;
				if (gst.affected === 'self') {
					if (!isCreature) continue;
					if (
						gst.condition &&
						!evaluateLayerCondition(gst.condition, state, workList, target, target, workMap)
					) {
						continue;
					}
					const p = evaluateLayerAmount(gst.mod.power, state, workList, target, target);
					const t = evaluateLayerAmount(gst.mod.toughness, state, workList, target, target);
					target.layer7bSetters.push({
						sourceName: srcName,
						power: p,
						toughness: t,
						timestamp: itemTs
					});
				}
			}
		}
		// --- End Track P11 ---
		target.layer7bSetters.sort((a, b) => a.timestamp - b.timestamp);
		for (const setter of target.layer7bSetters) {
			if (setter.power !== undefined) target.workingPower = setter.power;
			if (setter.toughness !== undefined) target.workingToughness = setter.toughness;
			if (
				(setter.power !== undefined && setter.power !== null) ||
				(setter.toughness !== undefined && setter.toughness !== null)
			) {
				const label = `${setter.sourceName} (base ${target.workingPower ?? '*'}/${target.workingToughness ?? '*'})`;
				if (!target.ptModifiedBy.includes(label)) {
					target.ptModifiedBy.push(label);
				}
			}
		}
	}

	// 7c. Layer 7c across ALL permanents: counters, temp P/T, and continuous P/T modifications (CR 613.4c)
	for (const target of workList) {
		if (target.workingPower === null || target.workingToughness === null) continue;
		const plusOnes = target.inst.counters['+1/+1'] || 0;
		const minusOnes = target.inst.counters['-1/-1'] || 0;
		target.workingPower += plusOnes - minusOnes + target.inst.tempPowerMod;
		target.workingToughness += plusOnes - minusOnes + target.inst.tempToughnessMod;
		// --- Track P13 (CR 613.4c): Cross-turn / permanent Layer 7c P/T modifications ---
		if (state.timedContinuousEffects?.length) {
			const targetVersion = target.inst.objectVersion ?? 1;
			for (const eff of state.timedContinuousEffects) {
				if (!eff.layer7c || !isTimedContinuousEffectActive(eff, workMap)) continue;
				if (
					eff.affected.some(
						(a) =>
							a.instanceId === target.inst.instanceId && (a.objectVersion ?? 1) === targetVersion
					)
				) {
					target.workingPower += eff.layer7c.power;
					target.workingToughness += eff.layer7c.toughness;
					const deltaStr = formatSignedDelta(eff.layer7c.power, eff.layer7c.toughness);
					grantStatModItem(
						target,
						`pt_timed_${eff.timestamp}`,
						deltaStr,
						eff.sourceName,
						eff.timestamp
					);
					target.ptModifiedBy.push(`${deltaStr} (${eff.sourceName})`);
				}
			}
		}
		// --- End Track P13 ---
	}

	// --- Track P13 + Track P14 ---
	const layer7cSources = anyGrantedStaticInBoard
		? emblemWorkList.length > 0 || graveyardStaticSources.length > 0
			? [...workList, ...emblemWorkList, ...graveyardStaticSources].sort(
					(a, b) => a.timestamp - b.timestamp
				)
			: workList
		: staticSources;
	// --- End Track P13 + Track P14 ---
	for (const source of layer7cSources) {
		if (source.strippedByAttachment) continue;

		// A. Attached Layer 7c `pt` on host
		if (source.inst.attachedToId) {
			const target = workMap.get(source.inst.attachedToId);
			if (target && target.workingPower !== null && target.workingToughness !== null) {
				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected !== 'attachedTo' || st.mod.k !== 'pt') continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(target, `pt_${source.name}`, deltaStr, source.name, source.timestamp);
					target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
				}
			}
		}

		// B. Self & Global Layer 7c `pt` from `source`
		if (source.allAbilityRemovalSources.length === 0) {
			for (const st of source.statics) {
				if (
					st.k !== 'continuous' ||
					st.layer !== '7c' ||
					st.mod.k !== 'pt' ||
					st.affected === 'attachedTo'
				) {
					continue;
				}
				const candidates = st.affected === 'self' ? [source] : workList;
				for (const target of candidates) {
					if (target.workingPower === null || target.workingToughness === null) continue;
					if (typeof st.affected === 'object' && !matchesLayerFilter(st.affected, target, source, state, workList)) {
						continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(
						target,
						`pt_${source.inst.instanceId}`,
						deltaStr,
						source.name,
						source.timestamp
					);
					target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
				}
			}
		}
		// --- Track P11: Layer 6 granted Layer 7c P/T statics (CR 613.4c, 107.3j) ---
		if (anyGrantedStaticInBoard) {
			for (const item of source.items) {
				if (item.removed || !item.grantedStaticAbility) continue;
				const gst = item.grantedStaticAbility;
				if (
					gst.k !== 'continuous' ||
					gst.layer !== '7c' ||
					gst.mod.k !== 'pt' ||
					gst.affected === 'attachedTo'
				) {
					continue;
				}
				const itemTs = source.itemTimestamps.get(item.id) ?? source.timestamp;
				const srcName = item.sources[0] ?? source.name;
				const candidates = gst.affected === 'self' ? [source] : workList;
				for (const target of candidates) {
					if (target.workingPower === null || target.workingToughness === null) continue;
					if (
						typeof gst.affected === 'object' &&
						!matchesLayerFilter(gst.affected, target, source, state, workList)
					) {
						continue;
					}
					if (
						gst.condition &&
						!evaluateLayerCondition(gst.condition, state, workList, source, target, workMap)
					) {
						continue;
					}
					const dp = evaluateLayerAmount(gst.mod.power, state, workList, source, target);
					const dt = evaluateLayerAmount(gst.mod.toughness, state, workList, source, target);
					target.workingPower += dp;
					target.workingToughness += dt;
					const deltaStr = formatSignedDelta(dp, dt);
					grantStatModItem(target, `pt_grant_${item.id}`, deltaStr, srcName, itemTs);
					target.ptModifiedBy.push(`${deltaStr} (${srcName})`);
				}
			}
		}
		// --- End Track P11 ---
	}

	// Record counter & temporary P/T breakdown items and apply Layer 7d P/T switch (CR 613.4d)
	for (const target of workList) {
		if (target.workingPower === null || target.workingToughness === null) continue;
		const plusOnes = target.inst.counters['+1/+1'] || 0;
		const minusOnes = target.inst.counters['-1/-1'] || 0;
		if (plusOnes > 0) {
			grantItem(target, 'counters_plus', `+${plusOnes}/+${plusOnes}`, 'stat_mod', '+1/+1 Counters');
			target.ptModifiedBy.push(`+${plusOnes}/+${plusOnes} (+1/+1 Counters)`);
		}
		if (minusOnes > 0) {
			grantItem(
				target,
				'counters_minus',
				`-${minusOnes}/-${minusOnes}`,
				'stat_mod',
				'-1/-1 Counters'
			);
			target.ptModifiedBy.push(`-${minusOnes}/-${minusOnes} (-1/-1 Counters)`);
		}
		if (target.inst.tempPowerMod !== 0 || target.inst.tempToughnessMod !== 0) {
			const deltaStr = formatSignedDelta(target.inst.tempPowerMod, target.inst.tempToughnessMod);
			grantItem(target, 'temp_pt', deltaStr, 'stat_mod', 'Temporary Effect');
			target.ptModifiedBy.push(`${deltaStr} (Temporary Effect)`);
		}

		// Layer 7d: Effects that switch a creature's power and toughness (CR 613.4d)
		if ((target.inst.switchedPTCount || 0) % 2 === 1) {
			const prevP = target.workingPower;
			const prevT = target.workingToughness;
			target.workingPower = prevT;
			target.workingToughness = prevP;
			grantItem(
				target,
				'switched_pt',
				`Switched P/T (${target.workingPower}/${target.workingToughness})`,
				'stat_mod',
				'P/T Switch'
			);
			target.ptModifiedBy.push(`Switched P/T (${target.workingPower}/${target.workingToughness})`);
		}
	}
}

function buildBoardResults(workList: PermWorkState[]): BoardLayerCache['byInstance'] {
	// Build final results map
	const byInstance = new Map<
		CardInstance,
		{
			breakdown: CardContinuousBreakdown;
			lost: { lost: boolean; sources: string[] };
			evaluated: EvaluatedPermanent;
		}
	>();

	for (const work of workList) {
		const breakdown: CardContinuousBreakdown = {
			baseTypeLine: work.baseTypeLine,
			effectiveTypeLine: work.effectiveTypeLine,
			typeModified:
				work.effectiveTypeLine !== work.baseTypeLine || work.typeModifiedBy.length > 0,
			typeModifiedBy: work.typeModifiedBy,
			basePower: work.basePower,
			baseToughness: work.baseToughness,
			// CR 107.1b: power can be negative (not clamped to 0).
			effectivePower: work.workingPower,
			effectiveToughness:
				work.workingToughness !== null ? Math.max(0, work.workingToughness) : null,
			ptModifiedBy: work.ptModifiedBy,
			items: work.items
		};

		const lost = {
			lost: work.allAbilityRemovalSources.length > 0,
			sources: work.allAbilityRemovalSources
		};

		const tLine = breakdown.effectiveTypeLine;
		// --- Track P14 ---
		const activeKeywords: string[] = [];
		let seenProtLabels: Set<string> | undefined;
		for (let ki = 0; ki < breakdown.items.length; ki++) {
			const it = breakdown.items[ki];
			if (it.kind !== 'keyword' || it.removed) continue;
			if (it.canonicalKey === 'protection') {
				const pLow = it.name.toLowerCase();
				if (seenProtLabels?.has(pLow)) continue;
				(seenProtLabels ??= new Set()).add(pLow);
			}
			activeKeywords.push(it.name);
		}
		// --- End Track P14 ---
		// CR 613.1d, 613.5, 702.73a: Changeling applies in Layer 4 before Layer 6 ability removal.
		const hasAllCreatureTypes = work.hasAllCreatureTypes || tLine.includes('All-Types');

		const evaluated: EvaluatedPermanent = {
			instanceId: work.inst.instanceId,
			controllerId: work.controllerId,
			effectiveName: work.name,
			effectiveTypeLine: tLine,
			typeLine: tLine,
			isCreature: tLine.includes('Creature'),
			isArtifact: tLine.includes('Artifact'),
			isEnchantment: tLine.includes('Enchantment'),
			isLand: tLine.includes('Land'),
			isPlaneswalker: tLine.includes('Planeswalker'),
			isLegendary: tLine.includes('Legendary'),
			hasAllCreatureTypes,
			losesAllAbilities: lost.lost,
			hasLostAllAbilities: lost.lost,
			lostAllAbilitiesBy: [...lost.sources],
			power: breakdown.effectivePower ?? 0,
			toughness: breakdown.effectiveToughness ?? 0,
			unclampedToughness: work.workingToughness,
			colors: [...work.colors],
			activeKeywords,
			keywords: activeKeywords,
			breakdown,
			hasSubType: (subType: string) => {
				if (
					(tLine.includes('Creature') || tLine.includes('Kindred') || tLine.includes('Tribal')) &&
					hasAllCreatureTypes &&
					!NON_CREATURE_SUBTYPES.has(subType)
				) {
					return true;
				}
				const subs = lowerSubtypesOf(tLine);
				if (subs) return subs.has(subType.toLowerCase());
				return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
			}
		};

		byInstance.set(work.inst, { breakdown, lost, evaluated });
	}

	return byInstance;
}

function getBoardLayerCache(state: GameState): { snap: BoardSnapshot; cache: BoardLayerCache } {
	// Inside `withStableLayerInputs`, reuse what the first query in the scope validated (Phase 6c).
	const trust = scopeTrust(state);
	const trusted = trust?.layer as { snap: BoardSnapshot; cache: BoardLayerCache } | undefined;
	if (trusted) {
		if (layerCacheCheckEnabled()) {
			verifyScopeTrust(
				'getBoardLayerCache',
				boardSnapshotMatches(state, trusted.snap) &&
					dynamicFingerprintMatches(state, trusted.snap, trusted.cache.dynamicFingerprint)
			);
		}
		return trusted;
	}
	const result = getBoardLayerCacheUntrusted(state);
	if (trust) trust.layer = result;
	return result;
}

function getBoardLayerCacheUntrusted(state: GameState): {
	snap: BoardSnapshot;
	cache: BoardLayerCache;
} {
	const snap = getBoardSnapshot(state);
	const existing = snap.memo.get(BOARD_CACHE_KEY) as BoardLayerCache | undefined;
	if (existing) {
		if (dynamicFingerprintMatches(state, snap, existing.dynamicFingerprint)) {
			return { snap, cache: existing };
		}
	}
	const cache = computeBoardLayerCache(state, snap);
	snap.memo.set(BOARD_CACHE_KEY, cache);
	return { snap, cache };
}

function cloneBreakdown(b: CardContinuousBreakdown): CardContinuousBreakdown {
	return {
		baseTypeLine: b.baseTypeLine,
		effectiveTypeLine: b.effectiveTypeLine,
		typeModified: b.typeModified,
		typeModifiedBy: [...b.typeModifiedBy],
		basePower: b.basePower,
		baseToughness: b.baseToughness,
		effectivePower: b.effectivePower,
		effectiveToughness: b.effectiveToughness,
		ptModifiedBy: [...b.ptModifiedBy],
		items: b.items.map((it) => ({
			...it,
			// --- Track P14 ---
			...(it.protectionExemption ? { protectionExemption: { ...it.protectionExemption } } : {}),
			// --- End Track P14 ---
			sources: [...it.sources],
			removedBy: [...it.removedBy]
		}))
	};
}

function buildOffBattlefieldBreakdown(
	card: ScryfallCard,
	inst: CardInstance | null,
	state?: GameState
): CardContinuousBreakdown {
	const faceOpts = inst ? instanceFaceOptions(inst) : undefined;
	const view = resolveObjectFaces(card, faceOpts);
	const isFaceDown = view.isFaceDown;
	const baseTypeLine = view.typeLine;
	const basePower = view.power ?? null;
	const baseToughness = view.toughness ?? null;
	let effectivePower = basePower;
	let effectiveToughness = baseToughness;
	const ptModifiedBy: string[] = [];
	// CR 604.3, 208.2a: Layer 7a characteristic-defining abilities function in all zones.
	if (!isFaceDown && view.types.includes('Creature')) {
		if (effectivePower === null && view.ptDefinedByAbility) effectivePower = 0;
		if (effectiveToughness === null && view.ptDefinedByAbility) effectiveToughness = 0;
		// --- Track P8: CR 707.9d copy P/T exception & setBasePower / setBaseToughness ---
		const exceptPower = inst?.copiableState?.except?.power;
		const exceptToughness = inst?.copiableState?.except?.toughness;
		for (const ab of activeAbilityDefs(card, faceOpts)) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'continuous' &&
				ab.static.layer === '7a' &&
				ab.static.affected === 'self' &&
				(ab.static.mod.k === 'setBasePT' ||
					ab.static.mod.k === 'setBasePower' ||
					ab.static.mod.k === 'setBaseToughness')
			) {
				if (state) {
					const controllerId =
						inst?.ownerId ||
						inst?.controllerId ||
						state.players.find(
							(pl) =>
								(inst &&
									(pl.command.includes(inst) ||
										pl.hand.includes(inst) ||
										pl.graveyard.includes(inst) ||
										pl.exile.includes(inst) ||
										pl.library.includes(inst))) ||
								false
						)?.playerId ||
						state.players[0]?.playerId ||
						'';
					if (ab.static.mod.k === 'setBasePT') {
						if (exceptPower !== undefined && exceptToughness !== undefined) continue;
						const p = evaluateAmount(ab.static.mod.power, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						const t = evaluateAmount(ab.static.mod.toughness, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						if (exceptPower === undefined) effectivePower = p;
						if (exceptToughness === undefined) effectiveToughness = Math.max(0, t);
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness})`);
					} else if (ab.static.mod.k === 'setBasePower') {
						if (exceptPower !== undefined) continue;
						const p = evaluateAmount(ab.static.mod.power, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						effectivePower = p;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness ?? 0})`);
					} else if (ab.static.mod.k === 'setBaseToughness') {
						if (exceptToughness !== undefined) continue;
						const t = evaluateAmount(ab.static.mod.toughness, {
							state,
							controllerId,
							source: inst ?? undefined
						});
						effectiveToughness = Math.max(0, t);
						ptModifiedBy.push(`${view.name} CDA (${effectivePower ?? 0}/${effectiveToughness})`);
					}
				} else {
					if (ab.static.mod.k === 'setBasePT') {
						if (exceptPower !== undefined && exceptToughness !== undefined) continue;
						if (exceptPower === undefined) effectivePower = 0;
						if (exceptToughness === undefined) effectiveToughness = 0;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower}/${effectiveToughness})`);
					} else if (ab.static.mod.k === 'setBasePower') {
						if (exceptPower !== undefined) continue;
						effectivePower = 0;
						ptModifiedBy.push(`${view.name} CDA (0/${effectiveToughness ?? 0})`);
					} else if (ab.static.mod.k === 'setBaseToughness') {
						if (exceptToughness !== undefined) continue;
						effectiveToughness = 0;
						ptModifiedBy.push(`${view.name} CDA (${effectivePower ?? 0}/0)`);
					}
				}
			}
		}
	}
	const innateList = innateKeywordsAndAbilitiesOf(card, faceOpts);
	const items: AttributedKeywordOrEffect[] = innateList.map((entry, idx) => ({
		id: `innate_${idx}_${entry.canonicalKey}`,
		canonicalKey: entry.canonicalKey,
		name: entry.name,
		kind: entry.kind,
		isInnate: true,
		sources: ['innate'],
		removed: false,
		removedBy: []
	}));
	return {
		baseTypeLine,
		effectiveTypeLine: baseTypeLine,
		typeModified: false,
		typeModifiedBy: [],
		basePower,
		baseToughness,
		effectivePower,
		effectiveToughness,
		ptModifiedBy,
		items
	};
}

// ---- Public Entry Points --------------------------------------------------------------------

/**
 * A battlefield permanent whose abilities function: not phased out, on a player who hasn't lost,
 * and not affected by a "loses all abilities" effect (CR 613.1f, 702.26b).
 */
export interface AbilityActivePermanent {
	perm: CardInstance;
	/** Copiable values (`copiableCard ?? card`). */
	card: ScryfallCard;
	/** The player whose battlefield holds the permanent. */
	controllerId: string;
	player: PlayerGameState;
	/** `compileCard(card)`. */
	compiled: CardDefinition;
}

function projectAbilityActive(list: readonly AbilityActivePermanent[]): unknown[] {
	return list.map((a) => [a.perm.instanceId, a.controllerId, a.player.playerId, a.card.id, a.card.name]);
}

/**
 * Every permanent whose abilities function, in board order (players in seat order, then
 * battlefield order). Equivalent to filtering each battlefield with
 * `!perm.phasedOut && !permanentHasLostAllAbilities(perm, state).lost`, but validates the layer
 * cache once instead of once per permanent (Phase 6c). The returned array is shared: don't mutate it.
 */
export function abilityActivePermanents(state: GameState): readonly AbilityActivePermanent[] {
	const { snap, cache } = getBoardLayerCache(state);
	let list = cache.abilityActive;
	if (!list) {
		const built: AbilityActivePermanent[] = [];
		for (const entry of snap.active) {
			if (cache.byInstance.get(entry.perm)?.lost.lost) continue;
			built.push({
				perm: entry.perm,
				card: entry.card,
				controllerId: entry.playerId,
				player: entry.player,
				compiled: compileCard(entry.card)
			});
		}
		list = built;
		cache.abilityActive = list;
	}
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult('abilityActivePermanents', projectAbilityActive(list), () => {
			// Independent of the cached snapshot: the original per-player scan over one fresh board
			// evaluation.
			const fresh = computeBoardLayerCache(state, buildBoardSnapshot(state));
			const out: AbilityActivePermanent[] = [];
			for (const player of state.players) {
				if (player.lost) continue;
				for (const perm of player.battlefield) {
					if (perm.phasedOut) continue;
					if (fresh.byInstance.get(perm)?.lost.lost) continue;
					// --- Track P7 ---
					const card = activeTimedLayer1aForPermanent(state, perm)?.card ?? effectiveCardForObject(perm);
					// --- End Track P7 ---
					out.push({
						perm,
						card,
						controllerId: player.playerId,
						player,
						compiled: compileCard(card)
					});
				}
			}
			return projectAbilityActive(out);
		});
	}
	return list;
}

export function permanentHasLostAllAbilities(
	perm: CardInstance,
	state: GameState
): { lost: boolean; sources: string[] } {
	const { cache } = getBoardLayerCache(state);
	const entry = cache.byInstance.get(perm);
	const out = entry
		? { lost: entry.lost.lost, sources: [...entry.lost.sources] }
		: { lost: false, sources: [] };
	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'permanentHasLostAllAbilities',
			out,
			() => permanentHasLostAllAbilities(perm, state),
			(ref) => ref.permanentHasLostAllAbilities(perm, state)
		);
	}
	return out;
}

export function hasAllOffBattlefieldAndSpellsColorless(state: GameState): boolean {
	for (const { perm, card } of abilityActivePermanents(state)) {
		for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
			if (
				ab.kind === 'static' &&
				ab.static.k === 'ruleModifier' &&
				ab.static.rule === 'allOffBattlefieldAndSpellsColorless'
			) {
				return true;
			}
		}
	}
	return false;
}

export function inspectCardContinuousBreakdown(
	cardOrInst: CardInstance | ScryfallCard,
	state?: GameState
): CardContinuousBreakdown {
	let inst: CardInstance | null = null;
	let card: ScryfallCard;

	if ('instanceId' in cardOrInst) {
		inst = cardOrInst;
		card = effectiveCardForObject(cardOrInst);
	} else {
		card = cardOrInst;
		if (state) {
			for (const p of state.players) {
				const foundBf = p.battlefield.find(
					(c) => c.card.id === card.id || c.card.name === card.name
				);
				if (foundBf) {
					inst = foundBf;
					card = effectiveCardForObject(foundBf);
					break;
				}
			}
			if (!inst) {
				for (const p of state.players) {
					const foundOther =
						p.command.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.hand.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.graveyard.find((c) => c.card.id === card.id || c.card.name === card.name) ||
						p.exile.find((c) => c.card.id === card.id || c.card.name === card.name);
					if (foundOther) {
						inst = foundOther;
						break;
					}
				}
			}
		}
	}

	let out: CardContinuousBreakdown;
	if (inst && state) {
		const { cache } = getBoardLayerCache(state);
		const hit = cache.byInstance.get(inst);
		out = hit ? cloneBreakdown(hit.breakdown) : buildOffBattlefieldBreakdown(card, inst, state);
	} else {
		out = buildOffBattlefieldBreakdown(card, inst, state);
	}

	if (state && layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'inspectCardContinuousBreakdown',
			out,
			() => inspectCardContinuousBreakdown(cardOrInst, state),
			(ref) => ref.inspectCardContinuousBreakdown(cardOrInst, state)
		);
	}
	return out;
}

export function evaluatePermanent(state: GameState, inst: CardInstance): EvaluatedPermanent {
	const { cache } = getBoardLayerCache(state);
	const hit = cache.byInstance.get(inst);
	let result: EvaluatedPermanent;
	if (hit) {
		result = hit.evaluated;
	} else {
		const baseCard = effectiveCardForObject(inst);
		const breakdown = buildOffBattlefieldBreakdown(baseCard, inst, state);
		const tLine = breakdown.effectiveTypeLine;
		// --- Track P14 ---
		const activeKeywords: string[] = [];
		let seenProtLabels: Set<string> | undefined;
		for (let ki = 0; ki < breakdown.items.length; ki++) {
			const it = breakdown.items[ki];
			if (it.kind !== 'keyword' || it.removed) continue;
			if (it.canonicalKey === 'protection') {
				const pLow = it.name.toLowerCase();
				if (seenProtLabels?.has(pLow)) continue;
				(seenProtLabels ??= new Set()).add(pLow);
			}
			activeKeywords.push(it.name);
		}
		// --- End Track P14 ---
		const hasAllCreatureTypes =
			tLine.includes('All-Types') ||
			breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);
		const faceView = resolveObjectFaces(baseCard, instanceFaceOptions(inst));
		result = {
			instanceId: inst.instanceId,
			controllerId: inst.controllerId,
			effectiveName: inst.isFaceDown
				? (inst.faceDownLabel ?? 'Face-Down Creature')
				: faceView.name,
			effectiveTypeLine: tLine,
			typeLine: tLine,
			isCreature: tLine.includes('Creature'),
			isArtifact: tLine.includes('Artifact'),
			isEnchantment: tLine.includes('Enchantment'),
			isLand: tLine.includes('Land'),
			isPlaneswalker: tLine.includes('Planeswalker'),
			isLegendary: tLine.includes('Legendary'),
			hasAllCreatureTypes,
			losesAllAbilities: false,
			hasLostAllAbilities: false,
			lostAllAbilitiesBy: [],
			power: breakdown.effectivePower ?? 0,
			toughness: breakdown.effectiveToughness ?? 0,
			unclampedToughness: breakdown.effectiveToughness,
			colors: state && hasAllOffBattlefieldAndSpellsColorless(state) ? [] : [...faceView.colors],
			activeKeywords,
			keywords: activeKeywords,
			breakdown,
			hasSubType: (subType: string) => {
				if (
					(tLine.includes('Creature') || tLine.includes('Kindred') || tLine.includes('Tribal')) &&
					hasAllCreatureTypes &&
					!NON_CREATURE_SUBTYPES.has(subType)
				) {
					return true;
				}
				const subs = lowerSubtypesOf(tLine);
				if (subs) return subs.has(subType.toLowerCase());
				return new RegExp(`\\b${subType}\\b`, 'i').test(tLine);
			}
		};
	}

	if (layerCacheCheckEnabled()) {
		crossCheckLayerResult(
			'evaluatePermanent',
			result,
			() => evaluatePermanent(state, inst),
			(ref) => ref.evaluatePermanent(state, inst)
		);
	}
	return result;
}
