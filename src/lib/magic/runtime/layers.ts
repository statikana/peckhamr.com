/**
 * Phase 6: Continuous-effect layer engine (CR 613) evaluated from compiled IR, with caching.
 *
 * Reads only the compiled `CardDefinition` (`compileCard`) and `CardInstance` state on the board —
 * never raw rules text or card names. Results for all active battlefield permanents are computed in
 * layer order (1, 4, 5, 6, 7a, 7b, 7c, 7d) and memoised on the `BoardSnapshot` from `layerCache.ts`.
 */
import { compileCard } from '../compiler/index.ts';
import type {
	ActivatedAbility,
	Amount,
	CardDefinition,
	Condition,
	ObjectFilter,
	Span,
	StaticDef
} from '../ir.ts';
import type { CardInstance, GameState, ManaColor, PlayerGameState, ScryfallCard } from '../types.ts';
import {
	boardSnapshotMatches,
	buildBoardSnapshot,
	crossCheckLayerResult,
	getBoardSnapshot,
	layerCacheCheckEnabled,
	scopeTrust,
	verifyScopeTrust,
	type BoardSnapshot
} from './layerCache.ts';
import { playerCommanderCastCount } from './objectFilter.ts';

export interface AttributedKeywordOrEffect {
	id: string;
	canonicalKey: string;
	name: string;
	kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod';
	isInnate: boolean;
	sources: string[];
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
	'Chorus'
]);

const KEYWORD_LABELS: Record<string, string> = {
	flying: 'Flying',
	'first strike': 'First strike',
	'double strike': 'Double strike',
	deathtouch: 'Deathtouch',
	defender: 'Defender',
	flash: 'Flash',
	haste: 'Haste',
	hexproof: 'Hexproof',
	indestructible: 'Indestructible',
	infect: 'Infect',
	lifelink: 'Lifelink',
	menace: 'Menace',
	reach: 'Reach',
	shroud: 'Shroud',
	trample: 'Trample',
	vigilance: 'Vigilance',
	changeling: 'Changeling',
	evolve: 'Evolve',
	cascade: 'Cascade',
	fear: 'Fear',
	intimidate: 'Intimidate',
	wither: 'Wither',
	horsemanship: 'Horsemanship',
	shadow: 'Shadow',
	prowess: 'Prowess'
};

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

function extractInnateFromIR(card: ScryfallCard): InnateEntry[] {
	const results: InnateEntry[] = [];
	const seenKeys = new Set<string>();
	const addResult = (canonicalKey: string, name: string, kind: 'keyword' | 'ability') => {
		const k = canonicalKey.toLowerCase();
		if (seenKeys.has(k)) return;
		seenKeys.add(k);
		results.push({ canonicalKey: k, name, kind });
	};

	const def = compileCard(card);
	const face = def.faces[0];
	const chars = face.characteristics;
	const isEquipment = chars.subtypes.includes('Equipment');
	const isAura = chars.subtypes.includes('Aura');

	const grantedToOthersKeywords = new Set<string>();
	const selfGrantedKeywords = new Set<string>();

	for (const ab of face.abilities) {
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
					: ab.keyword.n !== undefined
						? ` ${ab.keyword.n}`
						: '';
				addResult('ward', `Ward${costStr}`, 'keyword');
			} else if (kwName === 'protection') {
				addResult('protection', `Protection from ${ab.keyword.param ?? ''}`.trim(), 'keyword');
			} else if (kwName === 'hexproof' && ab.keyword.param) {
				const full = `hexproof from ${ab.keyword.param}`.toLowerCase();
				addResult(full, formatKeywordLabel(full), 'keyword');
			} else {
				addResult(kwName, formatKeywordLabel(kwName), 'keyword');
				selfGrantedKeywords.add(kwName);
			}
		} else if (ab.kind === 'unsupported' && ab.reason === 'keyword_not_implemented') {
			const low = ab.text.trim().toLowerCase();
			if (low.startsWith('ward')) {
				const rest = ab.text.trim().slice(4).trim();
				addResult('ward', rest ? `Ward ${rest}` : 'Ward', 'keyword');
			} else if (low.startsWith('protection from ')) {
				addResult('protection', formatKeywordLabel(low), 'keyword');
			} else if (low.startsWith('hexproof from ')) {
				addResult(low, formatKeywordLabel(low), 'keyword');
			} else if (KEYWORD_LABELS[low]) {
				addResult(low, KEYWORD_LABELS[low], 'keyword');
				selfGrantedKeywords.add(low);
			}
		} else if (ab.kind === 'static') {
			const st = ab.static;
			if (st.k === 'restriction' && st.affected === 'self') {
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
							} else {
								addResult(kwLow, formatKeywordLabel(kwLow), 'keyword');
							}
						} else {
							grantedToOthersKeywords.add(kwLow);
							if (kwLow.startsWith('protection from ')) {
								grantedToOthersKeywords.add('protection');
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
				if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
					for (const kw of step.params.keywords as string[]) {
						grantedToOthersKeywords.add(kw.toLowerCase());
					}
				}
			}
		}
	}

	// Check card.keywords for innate keywords not exclusively granted to others
	for (const rawKw of card.keywords || []) {
		const kwLow = rawKw.toLowerCase();
		if (seenKeys.has(kwLow) || kwLow === 'equip' || kwLow === 'enchant') continue;
		if (
			(isEquipment || isAura) &&
			!chars.types.includes('Creature') &&
			kwLow !== 'flash' &&
			kwLow !== 'indestructible'
		) {
			continue;
		}
		if (grantedToOthersKeywords.has(kwLow) && !selfGrantedKeywords.has(kwLow)) {
			continue;
		}
		addResult(kwLow, formatKeywordLabel(kwLow), 'keyword');
	}

	// 2. Summarize innate abilities from compiled abilities in order
	for (const ab of face.abilities) {
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
			if (ab.text.toLowerCase().includes('opponents control lose')) {
				addResult('ability_strip_kw', 'Removes Opponent Keywords', 'ability');
			} else {
				addResult('ability_activated', 'Activated Ability', 'ability');
			}
		}
	}

	return results;
}

function innateKeywordsAndAbilitiesOf(card: ScryfallCard): ReadonlyArray<InnateEntry> {
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
	const result = extractInnateFromIR(card);
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
	baseCard: ScryfallCard;
	timestamp: number;
	name: string;
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
		power: number | null;
		toughness: number | null;
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

function grantItem(
	work: PermWorkState,
	canonicalKey: string,
	name: string,
	kind: 'keyword' | 'ability' | 'stat_mod' | 'type_mod',
	sourceName: string,
	grantTimestamp = 0
): void {
	const keyLow = canonicalKey.toLowerCase();
	const existingActive = work.items.find(
		(it) => it.canonicalKey === keyLow && !it.removed && it.kind === kind
	);
	if (existingActive) {
		if (!existingActive.sources.includes(sourceName)) {
			existingActive.sources.push(sourceName);
		}
		const prevTs = work.itemTimestamps.get(existingActive.id) ?? -Infinity;
		if (grantTimestamp > prevTs) {
			work.itemTimestamps.set(existingActive.id, grantTimestamp);
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
		removed: false,
		removedBy: []
	});
}

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

function hasSubtypeInWork(work: PermWorkState, sub: string): boolean {
	const low = sub.toLowerCase();
	if (work.subtypes.some((s) => s.toLowerCase() === low)) return true;
	if (
		work.types.includes('Creature') &&
		work.hasAllCreatureTypes &&
		!NON_CREATURE_SUBTYPES.has(sub)
	) {
		return true;
	}
	return false;
}

function matchesLayerFilter(
	filter: ObjectFilter,
	target: PermWorkState,
	source: PermWorkState
): boolean {
	if (filter.other && target.inst.instanceId === source.inst.instanceId) return false;
	if (filter.controller === 'you' && target.inst.controllerId !== source.inst.controllerId) {
		return false;
	}
	if (filter.controller === 'opponent' && target.inst.controllerId === source.inst.controllerId) {
		return false;
	}
	if (filter.owner === 'you' && target.inst.ownerId !== source.inst.controllerId) {
		return false;
	}
	if (filter.owner === 'opponent' && target.inst.ownerId === source.inst.controllerId) {
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
			!filter.types.some((t) => target.types.some((tt) => tt.toLowerCase() === t.toLowerCase()))
		) {
			return false;
		}
	}
	if (filter.notTypes?.length) {
		if (
			filter.notTypes.some((t) => target.types.some((tt) => tt.toLowerCase() === t.toLowerCase()))
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
	if (filter.colors?.length) {
		if (!filter.colors.some((c) => target.colors.includes(c))) return false;
	}
	if (filter.tapped !== undefined) {
		layerReads |= READ_TAPPED;
		if (Boolean(target.inst.tapped) !== filter.tapped) return false;
	}
	if (filter.token !== undefined && Boolean(target.inst.isToken) !== filter.token) return false;
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
			if (amount.stat === 'manaValue') return refPerm.isFaceDown ? 0 : (refPerm.baseCard.cmc ?? 0);
			if (amount.stat === 'power') return refPerm.workingPower ?? 0;
			if (amount.stat === 'toughness') return refPerm.workingToughness ?? 0;
			return 0;
		}
		case 'life': {
			layerReads |= READ_LIFE;
			const p = state.players.find((pl) => pl.playerId === source.inst.controllerId);
			return p?.life ?? 0;
		}
		case 'cardsIn': {
			layerReads |= READ_ZONE_SIZES;
			const p = state.players.find((pl) => pl.playerId === source.inst.controllerId);
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
			return playerCommanderCastCount(state, source.inst.controllerId);
		}
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
		case 'count': {
			const f = amount.of;
			const zone = f.zone ?? 'battlefield';
			if (zone === 'battlefield') {
				let total = 0;
				for (const w of workList) {
					if (matchesLayerFilter(f, w, source)) total += 1;
				}
				return total;
			}
			if (zone === 'graveyard') {
				layerReads |= READ_GRAVEYARDS;
				let total = 0;
				for (const pl of state.players) {
					if (f.controller === 'you' && pl.playerId !== source.inst.controllerId) continue;
					if (f.controller === 'opponent' && pl.playerId === source.inst.controllerId) continue;
					for (const g of pl.graveyard) {
						const gChars = compileCard(g.copiableCard ?? g.card).faces[0].characteristics;
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
						total += 1;
					}
				}
				return total;
			}
			return 0;
		}
		default:
			return 0;
	}
}

function evaluateLayerCondition(
	cond: Condition,
	state: GameState,
	workList: PermWorkState[],
	source: PermWorkState,
	affected: PermWorkState
): boolean {
	switch (cond.k) {
		case 'and':
			return cond.of.every((c) => evaluateLayerCondition(c, state, workList, source, affected));
		case 'or':
			return cond.of.some((c) => evaluateLayerCondition(c, state, workList, source, affected));
		case 'not':
			return !evaluateLayerCondition(cond.of, state, workList, source, affected);
		case 'isTurnOf': {
			layerReads |= READ_ACTIVE_PLAYER;
			const activePlayer = state.players[state.activePlayerIndex];
			return activePlayer?.playerId === source.inst.controllerId;
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
				(w) => w.inst.controllerId === source.inst.controllerId && Boolean(w.inst.isCommander)
			);
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
		const def = compileCard(entry.card).faces[0];
		const statics = def.abilities
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

/** Inputs read by the evaluation in progress (bits above). */
let layerReads = 0;

function buildDynamicFingerprint(state: GameState, snap: BoardSnapshot, reads: number): unknown[] {
	const fp: unknown[] = [(state as { version?: number }).version, reads];
	if (reads & READ_ACTIVE_PLAYER) fp.push(state.activePlayerIndex);
	for (const p of state.players) {
		if (reads & READ_LIFE) fp.push(p.life);
		if (reads & READ_COMMANDER_CAST_COUNT) fp.push(playerCommanderCastCount(state, p.playerId));
		if (reads & READ_ZONE_SIZES) {
			fp.push(p.hand.length, p.graveyard.length, p.library.length, p.exile.length, p.command.length);
		}
		if (reads & READ_GRAVEYARDS) {
			fp.push(p.graveyard.length);
			for (const g of p.graveyard) {
				fp.push(g.card, g.copiableCard);
			}
		}
	}
	for (const entry of snap.active) {
		const perm = entry.perm;
		if (reads & READ_TAPPED) fp.push(perm.tapped);
		fp.push(
			perm.counters['+1/+1'] || 0,
			perm.counters['-1/-1'] || 0,
			perm.tempPowerMod || 0,
			perm.tempToughnessMod || 0,
			perm.switchedPTCount || 0,
			Boolean(perm.castViaSuspend),
			perm.grantedKeywords?.length || 0
		);
		if (perm.grantedKeywords?.length) {
			for (const kw of perm.grantedKeywords) fp.push(kw);
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
	for (const p of state.players) {
		if (reads & READ_LIFE && fp[i++] !== p.life) return false;
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
				if (fp[i++] !== g.card || fp[i++] !== g.copiableCard) return false;
			}
		}
	}
	const readsTapped = (reads & READ_TAPPED) !== 0;
	for (const entry of snap.active) {
		const perm = entry.perm;
		const granted = perm.grantedKeywords;
		const grantedLen = granted?.length || 0;
		if (readsTapped && fp[i++] !== perm.tapped) return false;
		if (
			fp[i++] !== (perm.counters['+1/+1'] || 0) ||
			fp[i++] !== (perm.counters['-1/-1'] || 0) ||
			fp[i++] !== (perm.tempPowerMod || 0) ||
			fp[i++] !== (perm.tempToughnessMod || 0) ||
			fp[i++] !== (perm.switchedPTCount || 0) ||
			fp[i++] !== Boolean(perm.castViaSuspend) ||
			fp[i++] !== grantedLen
		) {
			return false;
		}
		if (grantedLen) {
			for (const kw of granted) if (fp[i++] !== kw) return false;
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
	evaluateLayer1(state, snap, workList, workMap);
	evaluateAttachedTypes(state, snap, workList, workMap);
	evaluateTypeOverwrites(state, snap, workList, workMap);
	evaluateAdditiveTypesAndColors(state, snap, workList, workMap);
	evaluateGlobalAbilityLoss(state, snap, workList, workMap);
	evaluatePerPermanent(state, snap, workList, workMap);
	return buildBoardResults(workList);
}

function evaluateLayer1(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// 1. Layer 1 (Copy effects & face-down characteristics) + Innate items
	for (const entry of snap.sorted) {
		const inst = entry.perm;
		const baseCard = entry.card;
		const isFaceDown = Boolean(inst.isFaceDown);
		const face = compileCard(baseCard).faces[0];
		const chars = face.characteristics;
		const baseTypeLine = isFaceDown ? 'Creature' : baseCard.typeLine;
		const supertypes = isFaceDown ? [] : [...chars.supertypes];
		const types = isFaceDown ? ['Creature'] : [...chars.types];
		const subtypes = isFaceDown ? [] : normalizeSubtypes(chars.subtypes);
		const colors = isFaceDown ? [] : [...chars.colors];
		const isLegendary = baseTypeLine.includes('Legendary');
		const prefixLegendary = isLegendary ? 'Legendary ' : '';

		const basePower = isFaceDown ? 2 : (chars.power ?? null);
		const baseToughness = isFaceDown ? 2 : (chars.toughness ?? null);

		const innateList = isFaceDown ? [] : innateKeywordsAndAbilitiesOf(baseCard);
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
			for (const ab of face.abilities) {
				if (ab.kind === 'static') {
					statics.push(ab.static);
				} else if (ab.kind === 'activated' || ab.kind === 'triggered') {
					for (const step of ab.effect) {
						if (step.verb === 'grant' && Array.isArray(step.params?.keywords)) {
							for (const kw of step.params.keywords as string[]) {
								grantsKeywordViaAbility.add(kw.toLowerCase());
							}
						}
					}
				} else if (ab.kind === 'unsupported' && ab.id?.startsWith('act_')) {
					for (const kw of Object.keys(KEYWORD_LABELS)) {
						if (new RegExp(`\\bgains?\\b[^.\\n]*\\b${kw}\\b`, 'i').test(ab.text)) {
							grantsKeywordViaAbility.add(kw);
						}
					}
					const loseMatch = ab.text.match(
						/(creatures|permanents) your opponents control lose ([^.\n]+)/i
					);
					if (loseMatch) {
						const scope = loseMatch[1].toLowerCase();
						const loseClause = loseMatch[2];
						const removedKws: string[] = [];
						for (const kw of Object.keys(KEYWORD_LABELS)) {
							if (new RegExp(`\\b${kw}\\b`, 'i').test(loseClause)) {
								removedKws.push(kw);
							}
						}
						if (removedKws.length > 0) {
							statics.push({
								k: 'continuous',
								layer: '6',
								affected:
									scope === 'creatures'
										? { types: ['Creature'], controller: 'opponent' }
										: { controller: 'opponent' },
								mod: { k: 'removeKeywords', keywords: removedKws }
							});
						}
					}
				}
			}
			const layerOrder = (st: StaticDef): number => {
				if (st.k !== 'continuous') return 99;
				switch (st.layer) {
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
			baseCard,
			timestamp: entry.timestamp,
			name: isFaceDown ? 'Face-Down Creature' : baseCard.name,
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

function evaluateAttachedTypes(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
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
				} else if (st.layer === '5' && st.mod.k === 'setColors') {
					target.colors = [...st.mod.colors];
				} else if (st.layer === '5' && st.mod.k === 'addColors') {
					for (const c of st.mod.colors) {
						if (!target.colors.includes(c)) target.colors.push(c);
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
	workMap: Map<string, PermWorkState>
): void {
	// 3. Layer 4 Pass B: Global type-overwriting effects ("Nonbasic lands are Mountains." — CR 613.8 before additive land types)
	for (const source of workList) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (
				st.k !== 'continuous' ||
				st.layer !== '4' ||
				st.mod.k !== 'setSubtypes' ||
				typeof st.affected !== 'object'
			) {
				continue;
			}
			for (const target of workList) {
				if (!matchesLayerFilter(st.affected, target, source)) continue;
				if (st.condition && !evaluateLayerCondition(st.condition, state, workList, source, target)) {
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
}

function evaluateAdditiveTypesAndColors(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// 4. Layer 4 Pass C: Global additive type effects (Opalescence, Urborg, Yavimaya, Mycosynth Lattice, Maskwood Nexus)
	for (const source of workList) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '4' || typeof st.affected !== 'object') continue;
			if (st.mod.k === 'addTypes') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
					) {
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
			} else if (st.mod.k === 'allCreatureTypes') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
					) {
						continue;
					}
					target.hasAllCreatureTypes = true;
					target.effectiveTypeLine = addSubtypeToTypeLine(target.effectiveTypeLine, 'All-Types');
					if (!target.typeModifiedBy.includes(source.name)) {
						target.typeModifiedBy.push(source.name);
					}
				}
			}
		}
	}

	// 4b. Layer 5: Color-changing effects (CR 613.1e — setColors / addColors on self or filter)
	for (const source of workList) {
		if (source.strippedByAttachment || source.abilityRemovalEvents.length > 0) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || st.layer !== '5') continue;
			if (st.affected === 'attachedTo') continue;
			const targets =
				st.affected === 'self'
					? [source]
					: typeof st.affected === 'object'
						? workList.filter((t) => matchesLayerFilter(st.affected as ObjectFilter, t, source))
						: [];
			for (const target of targets) {
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, target)
				) {
					continue;
				}
				if (st.mod.k === 'setColors') {
					target.colors = [...st.mod.colors];
				} else if (st.mod.k === 'addColors') {
					for (const c of st.mod.colors) {
						if (!target.colors.includes(c)) target.colors.push(c);
					}
				}
			}
		}
	}
}

function evaluateGlobalAbilityLoss(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// 5. Layer 6 Global "lose all abilities" (Humility, Dress Down) & Global Layer 7b setters (Humility, Opalescence)
	for (const source of workList) {
		if (source.strippedByAttachment) continue;
		for (const st of source.statics) {
			if (st.k !== 'continuous' || typeof st.affected !== 'object') continue;
			if (st.layer === '6' && st.mod.k === 'removeAllAbilities') {
				for (const target of workList) {
					if (!matchesLayerFilter(st.affected, target, source)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
					) {
						continue;
					}
					recordAbilityRemoval(target, source.name, source.timestamp);
				}
			} else if (st.layer === '7b' && st.mod.k === 'setBasePT') {
				for (const target of workList) {
					if (!target.types.includes('Creature')) continue;
					if (!matchesLayerFilter(st.affected, target, source)) continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
					) {
						continue;
					}
					const p = evaluateLayerAmount(st.mod.power, state, workList, source, target);
					const t = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
					target.layer7bSetters.push({
						sourceName: source.name,
						power: p,
						toughness: t,
						timestamp: source.timestamp
					});
				}
			}
		}
	}
}

function evaluatePerPermanent(
	state: GameState,
	snap: BoardSnapshot,
	workList: PermWorkState[],
	workMap: Map<string, PermWorkState>
): void {
	// 6. Per-permanent Layer 7a, 7b, innate removal, Layer 6/7c grants, counters, temp mods, Layer 7d, and keyword removal
	for (const target of workList) {
		const isCreature = target.types.includes('Creature');
		if (!isCreature) {
			target.workingPower = null;
			target.workingToughness = null;
		} else {
			if (target.workingPower === null) target.workingPower = 0;
			if (target.workingToughness === null) target.workingToughness = 0;

			// Layer 7a: Characteristic-Defining Abilities (CR 604.3 / 613.4a)
			if (target.allAbilityRemovalSources.length === 0) {
				for (const st of target.statics) {
					if (
						st.k === 'continuous' &&
						st.layer === '7a' &&
						st.affected === 'self' &&
						st.mod.k === 'setBasePT'
					) {
						const p = evaluateLayerAmount(st.mod.power, state, workList, target, target);
						const t = evaluateLayerAmount(st.mod.toughness, state, workList, target, target);
						target.workingPower = p;
						target.workingToughness = t;
						target.ptModifiedBy.push(`${target.baseCard.name} CDA (${p}/${t})`);
					}
				}
			}
		}

		// Layer 7b: Set Base P/T in timestamp order (CR 613.4b & 613.7)
		target.layer7bSetters.sort((a, b) => a.timestamp - b.timestamp);
		for (const setter of target.layer7bSetters) {
			target.workingPower = setter.power;
			target.workingToughness = setter.toughness;
			if (setter.power !== null && setter.toughness !== null) {
				const label = `${setter.sourceName} (base ${setter.power}/${setter.toughness})`;
				if (!target.ptModifiedBy.includes(label)) {
					target.ptModifiedBy.push(label);
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

		// Grant items and apply Layer 7c continuous P/T modifications in timestamp order
		for (const source of workList) {
			if (target.abilityRemovalEvents.length > 0) {
				applyRemovalsUpTo(target, source.timestamp);
			}
			if (source.strippedByAttachment) continue;

			const sourceLostAbilities = source.allAbilityRemovalSources.length > 0;

			// A. Attached effects on `target`
			if (source.inst.attachedToId === target.inst.instanceId) {
				// Find if source also sets 7b base P/T so type_mod item includes `(p/t)`
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
					if (st.k !== 'continuous' || st.affected !== 'attachedTo') continue;
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
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
									source.timestamp
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
								// Check if source also grants a mana ability (e.g. Imprisoned in the Moon)
								for (const st2 of source.statics) {
									if (
										st2.k === 'continuous' &&
										st2.affected === 'attachedTo' &&
										st2.mod.k === 'grantAbility' &&
										st2.mod.ability.kind === 'activated' &&
										st2.mod.ability.isMana
									) {
										const step = st2.mod.ability.effect.find((e) => e.verb === 'addMana');
										const sym = Array.isArray(step?.params?.mana)
											? (step.params.mana[0] as string)
											: 'C';
										grantItem(
											target,
											`mana_${sym.toLowerCase()}`,
											`Mana Ability: Add {${sym}}`,
											'ability',
											source.name,
											source.timestamp
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
					} else if (st.mod.k === 'addKeywords') {
						for (const kw of sortGrantedKeywords(st.mod.keywords)) {
							const kwLow = kw.toLowerCase();
							const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
							grantItem(
								target,
								key,
								formatKeywordLabel(kwLow),
								'keyword',
								source.name,
								source.timestamp
							);
						}
					} else if (
						st.mod.k === 'pt' &&
						target.workingPower !== null &&
						target.workingToughness !== null
					) {
						const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
						const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
						target.workingPower += dp;
						target.workingToughness += dt;
						const deltaStr = formatSignedDelta(dp, dt);
						grantItem(
							target,
							`pt_${source.name}`,
							deltaStr,
							'stat_mod',
							source.name,
							source.timestamp
						);
						target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
					}
				}
			}

			// B. Self & Global effects from `source` (only if `source` has not lost all abilities)
			if (!sourceLostAbilities) {
				for (const st of source.statics) {
					if (st.k !== 'continuous' || st.affected === 'attachedTo') continue;
					if (st.affected === 'self') {
						if (source.inst.instanceId !== target.inst.instanceId) continue;
					} else {
						if (!matchesLayerFilter(st.affected, target, source)) continue;
					}
					if (
						st.condition &&
						!evaluateLayerCondition(st.condition, state, workList, source, target)
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
								source.timestamp
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
									source.timestamp
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
						st.mod.ability.kind === 'activated' &&
						st.mod.ability.isMana
					) {
						const step = st.mod.ability.effect.find((e) => e.verb === 'addMana');
						if (step?.params?.manaChoice === 'any') {
							grantItem(
								target,
								'mana_any',
								'Mana Ability: Add Any Color',
								'ability',
								source.name,
								source.timestamp
							);
						}
					} else if (st.layer === '6' && st.mod.k === 'addKeywords') {
						if (st.affected === 'self' && !st.condition) continue; // already in innate items
						for (const kw of sortGrantedKeywords(st.mod.keywords)) {
							const kwLow = kw.toLowerCase();
							const key = kwLow.startsWith('protection from ') ? 'protection' : kwLow;
							grantItem(
								target,
								key,
								formatKeywordLabel(kwLow),
								'keyword',
								source.name,
								source.timestamp
							);
						}
					} else if (
						st.layer === '7c' &&
						st.mod.k === 'pt' &&
						target.workingPower !== null &&
						target.workingToughness !== null
					) {
						const dp = evaluateLayerAmount(st.mod.power, state, workList, source, target);
						const dt = evaluateLayerAmount(st.mod.toughness, state, workList, source, target);
						target.workingPower += dp;
						target.workingToughness += dt;
						const deltaStr = formatSignedDelta(dp, dt);
						grantItem(
							target,
							`pt_${source.inst.instanceId}`,
							deltaStr,
							'stat_mod',
							source.name,
							source.timestamp
						);
						target.ptModifiedBy.push(`${deltaStr} (${source.name})`);
					}
				}
			}
		}

		applyRemovalsUpTo(target, Infinity);

		// Instance-level modifiers: Suspend haste, +1/+1 and -1/-1 counters, temp P/T, Layer 7d switch, temporary grantedKeywords
		if (target.inst.castViaSuspend && target.types.includes('Creature')) {
			grantItem(target, 'haste', 'Haste', 'keyword', 'Suspend');
		}
		const plusOnes = target.inst.counters['+1/+1'] || 0;
		const minusOnes = target.inst.counters['-1/-1'] || 0;
		if (plusOnes > 0 && target.workingPower !== null && target.workingToughness !== null) {
			target.workingPower += plusOnes;
			target.workingToughness += plusOnes;
			grantItem(target, 'counters_plus', `+${plusOnes}/+${plusOnes}`, 'stat_mod', '+1/+1 Counters');
			target.ptModifiedBy.push(`+${plusOnes}/+${plusOnes} (+1/+1 Counters)`);
		}
		if (minusOnes > 0 && target.workingPower !== null && target.workingToughness !== null) {
			target.workingPower -= minusOnes;
			target.workingToughness -= minusOnes;
			grantItem(
				target,
				'counters_minus',
				`-${minusOnes}/-${minusOnes}`,
				'stat_mod',
				'-1/-1 Counters'
			);
			target.ptModifiedBy.push(`-${minusOnes}/-${minusOnes} (-1/-1 Counters)`);
		}
		if (
			(target.inst.tempPowerMod !== 0 || target.inst.tempToughnessMod !== 0) &&
			target.workingPower !== null &&
			target.workingToughness !== null
		) {
			target.workingPower += target.inst.tempPowerMod;
			target.workingToughness += target.inst.tempToughnessMod;
			const deltaStr = formatSignedDelta(target.inst.tempPowerMod, target.inst.tempToughnessMod);
			grantItem(target, 'temp_pt', deltaStr, 'stat_mod', 'Temporary Effect');
			target.ptModifiedBy.push(`${deltaStr} (Temporary Effect)`);
		}

		// Layer 7d: Effects that switch a creature's power and toughness (CR 613.4d)
		if (
			target.workingPower !== null &&
			target.workingToughness !== null &&
			(target.inst.switchedPTCount || 0) % 2 === 1
		) {
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

		for (const gKw of target.inst.grantedKeywords || []) {
			const gLow = gKw.toLowerCase();
			const alreadyActive = target.items.some((it) => it.canonicalKey === gLow && !it.removed);
			if (!alreadyActive) {
				let sourceLabel = 'Temporary Effect';
				for (const w of workList) {
					if (
						w.inst.controllerId === target.inst.controllerId &&
						w.grantsKeywordViaAbility.has(gLow)
					) {
						sourceLabel = w.baseCard.name;
						break;
					}
				}
				grantItem(target, gLow, formatKeywordLabel(gLow), 'keyword', sourceLabel);
			}
		}

		// Layer 6 Keyword-Removal Effects (e.g., Archetype of Imagination, Grounding Sigil)
		for (const source of workList) {
			if (source.strippedByAttachment || source.allAbilityRemovalSources.length > 0) continue;
			for (const st of source.statics) {
				if (st.k !== 'continuous' || st.layer !== '6' || st.mod.k !== 'removeKeywords') continue;
				const matches =
					st.affected === 'attachedTo'
						? source.inst.attachedToId === target.inst.instanceId
						: st.affected === 'self'
							? source.inst.instanceId === target.inst.instanceId
							: matchesLayerFilter(st.affected, target, source);
				if (!matches) continue;
				if (
					st.condition &&
					!evaluateLayerCondition(st.condition, state, workList, source, target)
				) {
					continue;
				}
				for (const kw of st.mod.keywords) {
					const kwLow = kw.toLowerCase();
					for (const item of target.items) {
						if (
							item.canonicalKey === kwLow ||
							(kwLow === 'hexproof' && item.canonicalKey.startsWith('hexproof from '))
						) {
							item.removed = true;
							if (!item.removedBy.includes(source.name)) {
								item.removedBy.push(source.name);
							}
						}
					}
				}
			}
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
		const activeKeywords = breakdown.items
			.filter((it) => it.kind === 'keyword' && !it.removed)
			.map((it) => it.name);
		const hasAllCreatureTypes =
			tLine.includes('All-Types') ||
			breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);

		const evaluated: EvaluatedPermanent = {
			instanceId: work.inst.instanceId,
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
				if (tLine.includes('Creature') && hasAllCreatureTypes && !NON_CREATURE_SUBTYPES.has(subType)) {
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
			sources: [...it.sources],
			removedBy: [...it.removedBy]
		}))
	};
}

function buildOffBattlefieldBreakdown(
	card: ScryfallCard,
	inst: CardInstance | null
): CardContinuousBreakdown {
	const isFaceDown = Boolean(inst?.isFaceDown);
	const baseTypeLine = isFaceDown ? 'Creature' : card.typeLine;
	const rawP = isFaceDown ? 2 : card.power !== undefined ? parseInt(card.power, 10) : null;
	const rawT = isFaceDown ? 2 : card.toughness !== undefined ? parseInt(card.toughness, 10) : null;
	const basePower = rawP !== null && !isNaN(rawP) ? rawP : null;
	const baseToughness = rawT !== null && !isNaN(rawT) ? rawT : null;
	const innateList = isFaceDown ? [] : innateKeywordsAndAbilitiesOf(card);
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
		effectivePower: basePower,
		effectiveToughness: baseToughness,
		ptModifiedBy: [],
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
					const card = perm.copiableCard ?? perm.card;
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

export function inspectCardContinuousBreakdown(
	cardOrInst: CardInstance | ScryfallCard,
	state?: GameState
): CardContinuousBreakdown {
	let inst: CardInstance | null = null;
	let card: ScryfallCard;

	if ('instanceId' in cardOrInst) {
		inst = cardOrInst;
		card = cardOrInst.copiableCard ?? cardOrInst.card;
	} else {
		card = cardOrInst;
		if (state) {
			for (const p of state.players) {
				const foundBf = p.battlefield.find(
					(c) => c.card.id === card.id || c.card.name === card.name
				);
				if (foundBf) {
					inst = foundBf;
					card = foundBf.copiableCard ?? foundBf.card;
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
		out = hit ? cloneBreakdown(hit.breakdown) : buildOffBattlefieldBreakdown(card, inst);
	} else {
		out = buildOffBattlefieldBreakdown(card, inst);
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
		const baseCard = inst.copiableCard ?? inst.card;
		const breakdown = buildOffBattlefieldBreakdown(baseCard, inst);
		const tLine = breakdown.effectiveTypeLine;
		const activeKeywords = breakdown.items
			.filter((it) => it.kind === 'keyword' && !it.removed)
			.map((it) => it.name);
		const hasAllCreatureTypes =
			tLine.includes('All-Types') ||
			breakdown.items.some((it) => it.canonicalKey === 'changeling' && !it.removed);
		result = {
			instanceId: inst.instanceId,
			effectiveName: inst.isFaceDown ? 'Face-Down Creature' : baseCard.name,
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
			colors: inst.isFaceDown ? [] : [...(baseCard.colors ?? [])],
			activeKeywords,
			keywords: activeKeywords,
			breakdown,
			hasSubType: (subType: string) => {
				if (tLine.includes('Creature') && hasAllCreatureTypes && !NON_CREATURE_SUBTYPES.has(subType)) {
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
