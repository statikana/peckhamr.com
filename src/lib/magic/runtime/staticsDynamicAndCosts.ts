/**
 * Track P11 Runtime Module:
 * - Slice P11.1: Layer 6 quoted triggered & static ability grants (CR 613.1f, 613.7e, 107.3j)
 * - Slice P11.2: Dynamic scaling Layer 7a/7b/7c P/T (Party CR 700.8, Domain CR 305.6, attachmentsOn, mul)
 *   and static alternative cast permissions (CR 118.9)
 * - Slice P11.3: Keyword & named counters (CR 122.1b,d), external ETB tapped/counters (CR 614.12),
 *   static damage/life replacements (CR 614.7a, 119.7), chosen card name restrictions (CR 201.2a),
 *   optional untap (CR 502.3), toughness combat damage (CR 510.1a), max hand size & skip draw step
 * - Slice P11.4: Snow mana {S} pool tracking (CR 107.4h) & Phyrexian life-cost legality (CR 119.4, 119.8)
 *
 * Upholds ENGINE_INVARIANTS.md: zero rules-text reads, zero card-name comparisons, zero direct
 * zone mutations, zero IR stored in GameState, and bounded loops everywhere.
 */
import { compileCard } from '../compiler/index.ts';
import type { RuntimeTrigger } from '../compiler/triggers.ts';
import { getKeywordSpec } from '../keywords.ts';
import type {
	AbilityDef,
	Amount,
	CardDefinition,
	Condition,
	// --- Track P17b ---
	CostDef,
	// --- End Track P17b ---
	EventKind,
	ObjectFilter,
	PlayerFilter,
	ReplacementDef,
	StaticDef,
	TriggerDef
} from '../ir.ts';
import { resolveFlexibleManaRequirement, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastOption,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard
} from '../types.ts';
export { createEmptyCounterMap };
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { activeTimedLayer1aForPermanent } from './layerCache.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from './layers.ts';
import {
	evaluateAmount,
	evaluateCondition,
	matchesObjectFilter,
	// --- Track P17b ---
	objectManaValue,
	// --- End Track P17b ---
	type FilterContext
} from './objectFilter.ts';

// ---- 1. Counter Constants & Helpers (CR 122.1b, CR 122.1d) ----------------------------------

export const KEYWORD_COUNTER_TYPES = [
	'flying',
	'first strike',
	'double strike',
	'deathtouch',
	'haste',
	'hexproof',
	'indestructible',
	'lifelink',
	'menace',
	'reach',
	'trample',
	'vigilance'
] as const satisfies readonly CounterType[];

export const KEYWORD_COUNTER_SET: ReadonlySet<string> = new Set<string>(KEYWORD_COUNTER_TYPES);

export const ALL_COUNTER_TYPES: readonly CounterType[] = [
	'+1/+1',
	'-1/-1',
	'loyalty',
	'charge',
	'shield',
	'stun',
	'lore',
	'time',
	'age',
	'level',
	'fade',
	'flying',
	'first strike',
	'double strike',
	'deathtouch',
	'haste',
	'hexproof',
	'indestructible',
	'lifelink',
	'menace',
	'reach',
	'trample',
	'vigilance',
	'finality',
	'oil',
	'ki',
	'quest',
	'storage',
	'verse',
	'spore',
	'divinity',
	'feather',
	'gold',
	'plague',
	'blight',
	'stash',
	'vitality'
];

export const NEGATIVE_COUNTER_TYPES: ReadonlySet<CounterType> = new Set<CounterType>([
	'-1/-1',
	'stun',
	'finality',
	'plague',
	'blight'
]);

export function computeKeywordCounterMask(counters: Record<CounterType, number>): number {
	return (
		(counters.flying > 0 ? 1 << 0 : 0) |
		(counters['first strike'] > 0 ? 1 << 1 : 0) |
		(counters['double strike'] > 0 ? 1 << 2 : 0) |
		(counters.deathtouch > 0 ? 1 << 3 : 0) |
		(counters.haste > 0 ? 1 << 4 : 0) |
		(counters.hexproof > 0 ? 1 << 5 : 0) |
		(counters.indestructible > 0 ? 1 << 6 : 0) |
		(counters.lifelink > 0 ? 1 << 7 : 0) |
		(counters.menace > 0 ? 1 << 8 : 0) |
		(counters.reach > 0 ? 1 << 9 : 0) |
		(counters.trample > 0 ? 1 << 10 : 0) |
		(counters.vigilance > 0 ? 1 << 11 : 0)
	);
}

// ---- 2. Party (CR 700.8), Domain (CR 305.6), & Attachment Count -----------------------------

export const PARTY_ROLE_SUBTYPES = ['Cleric', 'Rogue', 'Warrior', 'Wizard'] as const;
const DOMAIN_BASIC_SUBTYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const;

function popcount4(n: number): number {
	let c = 0;
	for (let b = 0; b < 4; b++) {
		if (n & (1 << b)) c++;
	}
	return c;
}

/**
 * CR 700.8a–b: Exact maximum bipartite matching (`0..4`) across creatures' 4-bit party role masks
 * (`bit 0 = Cleric`, `bit 1 = Rogue`, `bit 2 = Warrior`, `bit 3 = Wizard`). Each creature can fill
 * at most one party role even if it has multiple party subtypes or Changeling (`0b1111`).
 */
export function computePartyCountFromRoleMasks(roleMasks: readonly number[]): number {
	let reachable = 1; // bitmask over 2^4 = 16 subsets of matched roles; bit 0 = empty set
	for (let i = 0; i < roleMasks.length; i++) {
		const m = roleMasks[i] & 0x0f;
		if (m === 0) continue;
		let next = reachable;
		for (let s = 0; s < 16; s++) {
			if (!(reachable & (1 << s))) continue;
			for (let r = 0; r < 4; r++) {
				if ((m & (1 << r)) && !(s & (1 << r))) {
					next |= 1 << (s | (1 << r));
				}
			}
		}
		reachable = next;
		if (reachable & (1 << 15)) return 4;
	}
	let best = 0;
	for (let s = 1; s < 16; s++) {
		if (reachable & (1 << s)) {
			const pc = popcount4(s);
			if (pc > best) best = pc;
		}
	}
	return best;
}

export function computePartyCount(state: GameState, playerId: string): number {
	const masks: number[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.controllerId !== playerId || !ev.isCreature) continue;
			let mask = 0;
			for (let r = 0; r < PARTY_ROLE_SUBTYPES.length; r++) {
				if (ev.hasSubType(PARTY_ROLE_SUBTYPES[r])) {
					mask |= 1 << r;
				}
			}
			if (mask !== 0) masks.push(mask);
		}
	}
	return computePartyCountFromRoleMasks(masks);
}

/**
 * CR 305.6 Domain: Number of distinct basic land types (`0..5`) among lands `playerId` controls.
 */
export function computeDomainCount(state: GameState, playerId: string): number {
	let mask = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.controllerId !== playerId || !ev.isLand) continue;
			for (let i = 0; i < DOMAIN_BASIC_SUBTYPES.length; i++) {
				if (ev.hasSubType(DOMAIN_BASIC_SUBTYPES[i])) {
					mask |= 1 << i;
				}
			}
			if (mask === 0x1f) return 5;
		}
	}
	let count = 0;
	for (let i = 0; i < 5; i++) {
		if (mask & (1 << i)) count++;
	}
	return count;
}

export function computeAttachmentsOnCount(
	state: GameState,
	hostId: string | null | undefined,
	filter: ObjectFilter | undefined,
	sourceControllerId: string,
	sourcePerm: CardInstance | undefined
): number {
	if (!hostId) return 0;
	let count = 0;
	const ctx: FilterContext = {
		state,
		controllerId: sourceControllerId,
		source: sourcePerm
	};
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.attachedToId !== hostId) continue;
			if (filter && !matchesObjectFilter(perm, filter, ctx)) continue;
			count++;
		}
	}
	return count;
}

// ---- 3. Layer 6 Granted Triggered, Static, & Replacement Abilities --------------------------

export function resolveGrantedAbilityFromCard(
	grantSourceCard: ScryfallCard,
	grantFaceIndex = 0,
	grantAbilityIndex = 0
): AbilityDef | undefined {
	const def = compileCard(grantSourceCard);
	const face = def.faces[grantFaceIndex] ?? def.faces[0];
	if (!face) return undefined;
	const ab = face.abilities[grantAbilityIndex];
	if (
		ab &&
		ab.kind === 'static' &&
		ab.static.k === 'continuous' &&
		ab.static.mod.k === 'grantAbility'
	) {
		return ab.static.mod.ability;
	}
	// Fallback scan if grantAbilityIndex was omitted
	for (const cand of face.abilities) {
		if (
			cand.kind === 'static' &&
			cand.static.k === 'continuous' &&
			cand.static.mod.k === 'grantAbility'
		) {
			return cand.static.mod.ability;
		}
	}
	return undefined;
}

export function resolveGrantedRuntimeTrigger(
	grantSourceCard: ScryfallCard,
	grantFaceIndex = 0,
	grantAbilityIndex = 0
): RuntimeTrigger | undefined {
	const granted = resolveGrantedAbilityFromCard(
		grantSourceCard,
		grantFaceIndex,
		grantAbilityIndex
	);
	if (!granted || granted.kind !== 'triggered') return undefined;
	return {
		abilityIndex: grantAbilityIndex,
		trigger: granted.trigger,
		condition: granted.condition,
		...(granted.grantCondition ? { grantCondition: granted.grantCondition } : {}),
		effectSupported: true,
		text: granted.text ?? '',
		effect: {
			steps: granted.effect,
			targets: granted.targets,
			...(granted.modal ? { modal: granted.modal } : {}),
			unparsed: []
		}
	};
}

export interface GrantedTriggeredAbilityInstance {
	runtimeTrigger: RuntimeTrigger;
	grantSourceCard: ScryfallCard;
	grantSourceId?: string;
	grantFaceIndex: number;
	grantAbilityIndex: number;
	grantCount: number;
}

interface CardP11Index {
	hasAnyStatic: boolean;
	hasCostModifier: boolean;
	hasLayer2Control: boolean;
	staticKinds: Set<StaticDef['k']>;
	ruleModifiers: Set<string>;
	replacementEvents: Set<ReplacementDef['replaces']['event']>;
	grantsTriggeredEvents: Set<EventKind>;
	grantsStaticKinds: Set<StaticDef['k']>;
	grantsRuleModifiers: Set<string>;
	grantsReplacementEvents: Set<ReplacementDef['replaces']['event']>;
}

const CARD_P11_INDEX_CACHE = new WeakMap<CardDefinition, CardP11Index>();

function collectTriggerDefEvents(td: TriggerDef, out: Set<EventKind>, depth = 0): void {
	if (depth > 8) return;
	out.add(td.event);
	if (td.or) {
		for (const alt of td.or) {
			collectTriggerDefEvents(alt, out, depth + 1);
		}
	}
}

function getCardP11Index(card: ScryfallCard): CardP11Index {
	const def = compileCard(card);
	const cached = CARD_P11_INDEX_CACHE.get(def);
	if (cached) return cached;

	const idx: CardP11Index = {
		hasAnyStatic: false,
		hasCostModifier: false,
		hasLayer2Control: false,
		staticKinds: new Set(),
		ruleModifiers: new Set(),
		replacementEvents: new Set(),
		grantsTriggeredEvents: new Set(),
		grantsStaticKinds: new Set(),
		grantsRuleModifiers: new Set(),
		grantsReplacementEvents: new Set()
	};

	for (const face of def.faces) {
		for (const ab of face.abilities) {
			if (ab.kind === 'static') {
				idx.hasAnyStatic = true;
				idx.staticKinds.add(ab.static.k);
				if (ab.static.k === 'costModifier') {
					idx.hasCostModifier = true;
				}
				if (
					ab.static.k === 'continuous' &&
					ab.static.layer === '2' &&
					ab.static.mod.k === 'setController'
				) {
					idx.hasLayer2Control = true;
				}
				if (ab.static.k === 'ruleModifier') {
					idx.ruleModifiers.add(ab.static.rule);
				}
				if (ab.static.k === 'continuous' && ab.static.mod.k === 'grantAbility') {
					const inner = ab.static.mod.ability;
					if (inner.kind === 'triggered') {
						collectTriggerDefEvents(inner.trigger, idx.grantsTriggeredEvents);
					} else if (inner.kind === 'static') {
						idx.grantsStaticKinds.add(inner.static.k);
						if (
							inner.static.k === 'continuous' &&
							inner.static.layer === '2' &&
							inner.static.mod.k === 'setController'
						) {
							idx.hasLayer2Control = true;
						}
						if (inner.static.k === 'ruleModifier') {
							idx.grantsRuleModifiers.add(inner.static.rule);
						}
					} else if (inner.kind === 'replacement') {
						idx.grantsReplacementEvents.add(inner.replacement.replaces.event);
					}
				}
			} else if (ab.kind === 'keyword') {
				const spec = getKeywordSpec(ab.keyword.name);
				if (spec?.status === 'implemented' && spec.implementation?.kind === 'static') {
					for (const st of spec.implementation.buildStatics(ab.keyword)) {
						if (st.k === 'costModifier') {
							idx.hasCostModifier = true;
						}
						if (st.k === 'continuous' && st.layer === '2' && st.mod.k === 'setController') {
							idx.hasLayer2Control = true;
						}
					}
				}
			} else if (ab.kind === 'replacement') {
				idx.replacementEvents.add(ab.replacement.replaces.event);
			}
		}
	}

	CARD_P11_INDEX_CACHE.set(def, idx);
	return idx;
}

export function cardMayHaveCostModifier(card: ScryfallCard): boolean {
	return getCardP11Index(card).hasCostModifier;
}

export function boardMayNeedControllerSync(state: GameState): boolean {
	if (state.timedContinuousEffects?.some((e) => Boolean(e.layer2))) return true;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			if (
				perm.controllerId !== p.playerId ||
				(perm.defaultControllerId ?? perm.controllerId) !== p.playerId
			) {
				return true;
			}
			const card = layer1CardForPermanent(state, perm);
			if (card && getCardP11Index(card).hasLayer2Control) return true;
		}
	}
	return false;
}

function layer1CardForPermanent(state: GameState, perm: CardInstance): ScryfallCard | null {
	if (perm.phasedOut || perm.isFaceDown) return null;
	return activeTimedLayer1aForPermanent(state, perm)?.card ?? perm.copiableCard ?? perm.card;
}

export function boardMayGrantTriggeredAbility(state: GameState, kind?: EventKind): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			const card = layer1CardForPermanent(state, perm);
			if (!card) continue;
			const idx = getCardP11Index(card);
			if (idx.grantsTriggeredEvents.size === 0) continue;
			if (!kind || idx.grantsTriggeredEvents.has(kind)) return true;
		}
	}
	return false;
}

export function boardMayGrantStaticAbility(
	state: GameState,
	filterKind?: StaticDef['k'],
	filterRules?: readonly string[]
): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			const card = layer1CardForPermanent(state, perm);
			if (!card) continue;
			const idx = getCardP11Index(card);
			if (idx.grantsStaticKinds.size === 0) continue;
			if (filterKind && !idx.grantsStaticKinds.has(filterKind)) continue;
			if (filterRules && !filterRules.some((r) => idx.grantsRuleModifiers.has(r))) continue;
			return true;
		}
	}
	return false;
}

export function boardMayGrantReplacementAbility(
	state: GameState,
	filterEvent?: ReplacementDef['replaces']['event']
): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			const card = layer1CardForPermanent(state, perm);
			if (!card) continue;
			const idx = getCardP11Index(card);
			if (idx.grantsReplacementEvents.size === 0) continue;
			if (!filterEvent || idx.grantsReplacementEvents.has(filterEvent)) return true;
		}
	}
	return false;
}

const EMPTY_GRANTED_TRIGGERS: GrantedTriggeredAbilityInstance[] = [];
const EMPTY_GRANTED_STATICS: StaticDef[] = [];
const EMPTY_GRANTED_REPLACEMENTS: ReplacementDef[] = [];

export function collectActiveGrantedTriggeredAbilities(
	state: GameState,
	perm: CardInstance,
	filterKind?: EventKind
): GrantedTriggeredAbilityInstance[] {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return EMPTY_GRANTED_TRIGGERS;
	if (!boardMayGrantTriggeredAbility(state, filterKind)) return EMPTY_GRANTED_TRIGGERS;
	const ev = evaluatePermanent(state, perm);
	const out: GrantedTriggeredAbilityInstance[] = [];
	for (const item of ev.breakdown.items) {
		if (item.removed || !item.grantedTriggeredAbility || !item.grantSourceCard) continue;
		const gt = item.grantedTriggeredAbility;
		const faceIdx = item.grantFaceIndex ?? 0;
		const abIdx = item.grantAbilityIndex ?? 0;
		out.push({
			runtimeTrigger: {
				abilityIndex: abIdx,
				trigger: gt.trigger,
				condition: gt.condition,
				...(gt.grantCondition ? { grantCondition: gt.grantCondition } : {}),
				effectSupported: true,
				text: gt.text ?? '',
				effect: {
					steps: gt.effect,
					targets: gt.targets,
					...(gt.modal ? { modal: gt.modal } : {}),
					unparsed: []
				}
			},
			grantSourceCard: item.grantSourceCard,
			...(item.grantSourceId ? { grantSourceId: item.grantSourceId } : {}),
			grantFaceIndex: faceIdx,
			grantAbilityIndex: abIdx,
			grantCount: Math.max(1, item.grantCount ?? 1)
		});
	}
	return out;
}

export function collectActiveGrantedStaticDefs(
	state: GameState,
	perm: CardInstance
): StaticDef[] {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return EMPTY_GRANTED_STATICS;
	if (!boardMayGrantStaticAbility(state)) return EMPTY_GRANTED_STATICS;
	const ev = evaluatePermanent(state, perm);
	const out: StaticDef[] = [];
	for (const item of ev.breakdown.items) {
		if (item.removed || !item.grantedStaticAbility) continue;
		out.push(item.grantedStaticAbility);
	}
	return out;
}

export function collectActiveGrantedReplacementDefs(
	state: GameState,
	perm: CardInstance
): ReplacementDef[] {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return EMPTY_GRANTED_REPLACEMENTS;
	if (!boardMayGrantReplacementAbility(state)) return EMPTY_GRANTED_REPLACEMENTS;
	const ev = evaluatePermanent(state, perm);
	const out: ReplacementDef[] = [];
	for (const item of ev.breakdown.items) {
		if (item.removed || !item.grantedReplacementAbility) continue;
		out.push(item.grantedReplacementAbility);
	}
	return out;
}

const PRE_LEAVE_GRANTED_REPLACEMENTS = new WeakMap<CardInstance, ReplacementDef[]>();

export function stashPreLeaveGrantedReplacements(state: GameState, perm: CardInstance): void {
	if (perm.zone !== 'battlefield' || perm.phasedOut || !boardMayGrantReplacementAbility(state)) {
		PRE_LEAVE_GRANTED_REPLACEMENTS.delete(perm);
		return;
	}
	const granted = collectActiveGrantedReplacementDefs(state, perm);
	if (granted.length > 0) {
		PRE_LEAVE_GRANTED_REPLACEMENTS.set(perm, granted);
	} else {
		PRE_LEAVE_GRANTED_REPLACEMENTS.delete(perm);
	}
}

export function peekPreLeaveGrantedReplacements(perm: CardInstance): ReplacementDef[] {
	return PRE_LEAVE_GRANTED_REPLACEMENTS.get(perm) ?? EMPTY_GRANTED_REPLACEMENTS;
}

/**
 * Iterates every active battlefield permanent together with both its own active StaticDefs (when it
 * hasn't lost all abilities) AND any active Layer 6 granted StaticDefs on it (which survive even if
 * an earlier timestamp stripped innate abilities, per CR 613.7e).
 *
 * Pre-filters by compiled `CardP11Index` before calling `evaluatePermanent`, so hot paths skip layer
 * evaluation completely when no permanent on the battlefield carries a matching static!
 */
export function forEachActiveStaticOnBattlefield(
	state: GameState,
	visit: (perm: CardInstance, controllerId: string, sourceName: string, def: StaticDef) => void,
	filterKind?: StaticDef['k'],
	filterRules?: readonly string[]
): void {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			const card = layer1CardForPermanent(state, perm);
			if (!card) continue;
			const idx = getCardP11Index(card);
			if (!idx.hasAnyStatic) continue;
			if (filterKind && !idx.staticKinds.has(filterKind)) continue;
			if (filterRules && !filterRules.some((r) => idx.ruleModifiers.has(r))) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const ev = evaluatePermanent(state, perm);
			const abilities = activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'));
			for (const ab of abilities) {
				if (ab.kind !== 'static') continue;
				if (filterKind && ab.static.k !== filterKind) continue;
				if (
					filterRules &&
					ab.static.k === 'ruleModifier' &&
					!filterRules.includes(ab.static.rule)
				) {
					continue;
				}
				visit(perm, ev.controllerId, ev.effectiveName, ab.static);
			}
		}
	}
	if (!boardMayGrantStaticAbility(state, filterKind, filterRules)) return;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const granted = collectActiveGrantedStaticDefs(state, perm);
			if (granted.length === 0) continue;
			const ev = evaluatePermanent(state, perm);
			for (const st of granted) {
				if (filterKind && st.k !== filterKind) continue;
				visit(perm, ev.controllerId, ev.effectiveName, st);
			}
		}
	}
}

function forEachActiveReplacementOnBattlefield(
	state: GameState,
	filterEvent: ReplacementDef['replaces']['event'],
	visit: (perm: CardInstance, controllerId: string, def: ReplacementDef) => void,
	excludeInstanceId?: string
): void {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (excludeInstanceId && perm.instanceId === excludeInstanceId) continue;
			const card = layer1CardForPermanent(state, perm);
			if (!card) continue;
			const idx = getCardP11Index(card);
			if (!idx.replacementEvents.has(filterEvent)) continue;
			if (permanentHasLostAllAbilities(perm, state).lost) continue;
			const ev = evaluatePermanent(state, perm);
			for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
				if (ab.kind === 'replacement' && ab.replacement.replaces.event === filterEvent) {
					visit(perm, ev.controllerId, ab.replacement);
				}
			}
		}
	}
	if (!boardMayGrantReplacementAbility(state, filterEvent)) return;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || (excludeInstanceId && perm.instanceId === excludeInstanceId)) continue;
			const granted = collectActiveGrantedReplacementDefs(state, perm);
			if (granted.length === 0) continue;
			const ev = evaluatePermanent(state, perm);
			for (const rep of granted) {
				if (rep.replaces.event === filterEvent) {
					visit(perm, ev.controllerId, rep);
				}
			}
		}
	}
}

// ---- 4. Static Alternative Cast Permissions (CR 118.9) --------------------------------------

export function collectStaticAltCastOptions(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	fromZone: CastOption['fromZone'],
	faceIndex: number | undefined,
	requiresTarget: boolean,
	// --- Track P14 ---
	hasZonePermission = true
	// --- End Track P14 ---
): CastOption[] {
	const out: CastOption[] = [];
	const card = effectiveCardForObject(inst);
	const stackFaceOpts = {
		zone: 'stack' as const,
		faceIndex
	};
	const view = resolveObjectFaces(card, stackFaceOpts);
	if (view.types.some((t) => t.toLowerCase() === 'land') && view.types.length === 1) return out;

	const stackProxy: CardInstance & { castSourceZone?: CastOption['fromZone'] } = {
		...inst,
		controllerId: actor.playerId,
		zone: 'stack',
		activeFaceIndex: faceIndex,
		// --- Track P14 ---
		castSourceZone: fromZone
		// --- End Track P14 ---
	};
	const choosesX = /\{X\}/i.test(view.manaCost || '');

	// 1. Self alternative cast permission (e.g., Bringer cycle: "You may pay {W}{U}{B}{R}{G} rather than pay ~'s mana cost.")
	const selfCtx: FilterContext = {
		state,
		controllerId: actor.playerId,
		source: stackProxy
	};
	const selfAbilities = activeAbilityDefs(card, stackFaceOpts);
	for (let i = 0; i < selfAbilities.length; i++) {
		const ab = selfAbilities[i];
		if (ab.kind !== 'static' || ab.static.k !== 'altCastPermission') continue;
		if (ab.static.affects !== 'self') continue;
		// --- Track P14 ---
		if (ab.static.allowedZones) {
			if (!ab.static.allowedZones.includes(fromZone)) continue;
			// --- Track P17b ---
			if (ab.static.requireZonePermission && !hasZonePermission) continue;
			// --- End Track P17b ---
		} else if (!hasZonePermission) {
			continue;
		}
		// --- End Track P14 ---
		// --- Track P17b ---
		if (
			ab.static.duringYourTurnOnly &&
			state.players[state.activePlayerIndex]?.playerId !== actor.playerId
		) {
			continue;
		}
		const selfSlotKey = ab.static.onceEachTurn
			? `p17b_alt_self:${inst.instanceId}:${inst.objectVersion ?? 1}:${i}`
			: undefined;
		if (selfSlotKey && actor.usedStaticPlaySlotsThisTurn?.includes(selfSlotKey)) continue;
		// --- End Track P17b ---
		if (ab.static.condition && !evaluateCondition(ab.static.condition, selfCtx)) continue;
		const altMana = ab.static.manaCost;
		// --- Track P17b: additional-only self permissions (flash + {N}, graveyard + discard/life/per-metric) ---
		if (ab.static.additionalOnly) {
			if (!view.manaCost && !view.types.includes('Land')) continue;
			let extraMana = altMana && altMana !== '{0}' ? altMana : '';
			if (ab.static.additionalPerMetric && extraMana) {
				const mult = Math.max(0, evaluateAmount(ab.static.additionalPerMetric, selfCtx));
				extraMana = mult > 0 ? extraMana.repeat(mult) : '';
			}
			const existingMandatory =
				activeAbilityDefs(card, stackFaceOpts)
					.filter(
						(a): a is Extract<AbilityDef, { kind: 'static' }> =>
							a.kind === 'static' && a.static.k === 'additionalCastCost'
					)
					.flatMap((a) => (a.static.k === 'additionalCastCost' ? a.static.costs : [])) ?? [];
			const spellAb = activeAbilityDefs(card, stackFaceOpts).find(
				(a): a is Extract<AbilityDef, { kind: 'spell' }> => a.kind === 'spell'
			);
			const allMandatory: CostDef[] = [
				...(spellAb?.additionalCosts ?? []),
				...existingMandatory,
				...(ab.static.costDefs ?? [])
			];
			const dispCost = `${view.manaCost || '{0}'}${extraMana}`;
			out.push({
				id: `static_alt_self_${faceIndex ?? 0}_${i}`,
				label: `Cast ${view.name} (${dispCost})`,
				costDisplay: dispCost,
				fromZone,
				permission: 'static_alt',
				...(faceIndex !== undefined ? { faceIndex } : {}),
				...(selfSlotKey ? { staticPlaySlotKey: selfSlotKey } : {}),
				baseCost: { kind: 'printed' },
				...(allMandatory.length > 0 ? { mandatoryAdditionalCosts: allMandatory } : {}),
				timing: ab.static.grantFlash ? 'instant_only' : 'default',
				spellMods: {
					...(ab.static.enterCounters ? { altCastEnterCounters: ab.static.enterCounters } : {}),
					...(extraMana ? { additionalManaCost: extraMana } : {})
				},
				choosesX:
					choosesX ||
					Boolean(allMandatory.length > 0 && JSON.stringify(allMandatory).includes('"k":"x"')),
				requiresTarget
			});
			continue;
		}
		// --- End Track P17b ---
		// --- Track P14: CR 107.3b — alternative cost chooses X only if the alternative cost itself mentions X ---
		const altChoosesX =
			/\{X\}/i.test(altMana) ||
			Boolean(ab.static.costDefs && JSON.stringify(ab.static.costDefs).includes('"k":"x"'));
		// --- End Track P14 ---
		out.push({
			id: `static_alt_self_${faceIndex ?? 0}_${i}`,
			label: `Alternative cost ${altMana || '{0}'} (${view.name})`,
			costDisplay: altMana || '{0}',
			fromZone,
			permission: 'static_alt',
			...(faceIndex !== undefined ? { faceIndex } : {}),
			// --- Track P17b ---
			...(selfSlotKey ? { staticPlaySlotKey: selfSlotKey } : {}),
			// --- End Track P17b ---
			baseCost: {
				kind: 'alternative',
				manaCost: altMana,
				...(ab.static.costDefs?.length ? { costDefs: ab.static.costDefs } : {})
			},
			// --- Track P17b ---
			timing: ab.static.grantFlash ? 'instant_only' : 'default',
			spellMods: ab.static.enterCounters
				? { altCastEnterCounters: ab.static.enterCounters }
				: {},
			// --- End Track P17b ---
			choosesX: altChoosesX,
			requiresTarget
		});
	}

	// 2. External battlefield static alternative cast permissions (e.g., Fist of Suns, Rooftop Storm)
	let extIdx = 0;
	forEachActiveStaticOnBattlefield(
		state,
		(sourcePerm, controllerId, sourceName, st) => {
			if (st.k !== 'altCastPermission' || st.affects === 'self') return;
			// --- Track P17b ---
			if (!st.anyPlayer && controllerId !== actor.playerId) return;
			if (
				st.duringYourTurnOnly &&
				state.players[state.activePlayerIndex]?.playerId !== actor.playerId
			) {
				return;
			}
			const thisExtIdx = extIdx++;
			const slotKey = st.onceEachTurn
				? `p17b_alt:${sourcePerm.instanceId}:${sourcePerm.objectVersion ?? 1}:${thisExtIdx}`
				: undefined;
			if (slotKey && actor.usedStaticPlaySlotsThisTurn?.includes(slotKey)) return;
			// --- End Track P17b ---
			// --- Track P14 ---
			if (st.allowedZones) {
				if (!st.allowedZones.includes(fromZone)) return;
				// --- Track P17b ---
				if (st.requireZonePermission && !hasZonePermission) return;
				// --- End Track P17b ---
			} else if (!hasZonePermission) {
				return;
			}
			// --- End Track P14 ---
			const ctx: FilterContext = {
				state,
				controllerId: st.anyPlayer ? actor.playerId : controllerId,
				source: sourcePerm,
				zone: 'stack'
			};
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			if (!matchesObjectFilter(stackProxy, st.affects.filter, ctx)) return;
			// --- Track P17b ---
			if (st.maxManaValueBySelfCounters) {
				const maxMv = sourcePerm.counters[st.maxManaValueBySelfCounters] || 0;
				if (objectManaValue(state, stackProxy) > maxMv) return;
			}
			if (st.maxManaValueByControlledCount) {
				const maxMv = actor.battlefield.filter(
					(perm) =>
						!perm.phasedOut &&
						matchesObjectFilter(
							perm,
							{ ...st.maxManaValueByControlledCount!, controller: 'you' },
							ctx
						)
				).length;
				if (objectManaValue(state, stackProxy) > maxMv) return;
			}
			const altMana = st.dynamicManaCostFromMV
				? `{${Math.max(0, objectManaValue(state, stackProxy))}}`
				: st.manaCost;
			const extraCostDefs: CostDef[] = [
				...(st.payLifeEqualToSpellMV
					? [
							{
								k: 'payLife' as const,
								amount: { k: 'const' as const, n: Math.max(0, objectManaValue(state, stackProxy)) }
							}
						]
					: []),
				...(st.costDefs ?? [])
			];
			if (st.additionalOnly) {
				if (!view.manaCost && !view.types.includes('Land')) return;
				const extraMana = altMana && altMana !== '{0}' ? altMana : '';
				const cardMandatory =
					activeAbilityDefs(card, stackFaceOpts)
						.filter(
							(a): a is Extract<AbilityDef, { kind: 'static' }> =>
								a.kind === 'static' && a.static.k === 'additionalCastCost'
						)
						.flatMap((a) => (a.static.k === 'additionalCastCost' ? a.static.costs : [])) ?? [];
				const spellAb = activeAbilityDefs(card, stackFaceOpts).find(
					(a): a is Extract<AbilityDef, { kind: 'spell' }> => a.kind === 'spell'
				);
				const allMandatory: CostDef[] = [
					...(spellAb?.additionalCosts ?? []),
					...cardMandatory,
					...extraCostDefs
				];
				const dispCost = `${view.manaCost || '{0}'}${extraMana}`;
				out.push({
					id: `static_alt_ext_${sourcePerm.instanceId}_${thisExtIdx}`,
					label: `Cast via ${sourceName} (${dispCost})`,
					costDisplay: dispCost,
					fromZone,
					permission: 'static_alt',
					...(faceIndex !== undefined ? { faceIndex } : {}),
					...(slotKey ? { staticPlaySlotKey: slotKey } : {}),
					baseCost: { kind: 'printed' },
					...(allMandatory.length > 0 ? { mandatoryAdditionalCosts: allMandatory } : {}),
					timing: st.grantFlash ? 'instant_only' : 'default',
					spellMods: {
						...(st.enterCounters ? { altCastEnterCounters: st.enterCounters } : {}),
						...(extraMana ? { additionalManaCost: extraMana } : {})
					},
					choosesX:
						choosesX ||
						Boolean(allMandatory.length > 0 && JSON.stringify(allMandatory).includes('"k":"x"')),
					requiresTarget
				});
				return;
			}
			const altChoosesX =
				/\{X\}/i.test(altMana) ||
				Boolean(extraCostDefs.length > 0 && JSON.stringify(extraCostDefs).includes('"k":"x"'));
			// --- End Track P17b ---
			out.push({
				id: `static_alt_ext_${sourcePerm.instanceId}_${thisExtIdx}`,
				label: `Pay ${altMana || '{0}'} (${sourceName})`,
				costDisplay: altMana || '{0}',
				fromZone,
				permission: 'static_alt',
				...(faceIndex !== undefined ? { faceIndex } : {}),
				// --- Track P17b ---
				...(slotKey ? { staticPlaySlotKey: slotKey } : {}),
				// --- End Track P17b ---
				baseCost: {
					kind: 'alternative',
					manaCost: altMana,
					...(extraCostDefs.length > 0 ? { costDefs: extraCostDefs } : {})
				},
				// --- Track P17b ---
				timing: st.grantFlash ? 'instant_only' : 'default',
				spellMods: st.enterCounters ? { altCastEnterCounters: st.enterCounters } : {},
				// --- End Track P17b ---
				choosesX: altChoosesX,
				requiresTarget
			});
		},
		'altCastPermission'
	);

	return out;
}

// ---- 5. External ETB Tapped & Counters (CR 614.12) ------------------------------------------

function matchesReplacementPlayer(
	filter: PlayerFilter | undefined,
	sourceControllerId: string,
	targetPlayerId: string
): boolean {
	if (!filter) return true;
	if (filter.relation === 'you') return sourceControllerId === targetPlayerId;
	if (filter.relation === 'opponent' || filter.relation === 'each_opponent') {
		return sourceControllerId !== targetPlayerId;
	}
	return true;
}

/**
 * CR 614.12: Checks whether any already-on-battlefield external replacement effect causes
 * `enteringObj` (already placed hypothetically on battlefield for Layer 4/5 evaluation) to enter
 * the battlefield tapped (e.g., Authority of the Consuls, Blind Obedience, Root Maze, Archelos).
 */
export function externalPermanentEntersTapped(
	state: GameState,
	enteringObj: CardInstance,
	enteringControllerId: string
): boolean {
	let entersTapped = false;
	forEachActiveReplacementOnBattlefield(
		state,
		'zoneChange',
		(perm, controllerId, def) => {
			if (entersTapped) return;
			const f = def.replaces.filter;
			if (f?.to !== 'battlefield') return;
			if (f.object === 'self' || f.object === undefined) return;
			if (Array.isArray(def.with) || def.with.k !== 'modify' || !def.with.tapped) return;
			if (!matchesReplacementPlayer(f.player, controllerId, enteringControllerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (def.condition && !evaluateCondition(def.condition, ctx)) return;
			if (f.object === 'attachedTo') {
				if (perm.attachedToId !== enteringObj.instanceId) return;
			} else if (!matchesObjectFilter(enteringObj, f.object, ctx)) {
				return;
			}
			entersTapped = true;
		},
		enteringObj.instanceId
	);
	return entersTapped;
}

/**
 * CR 614.12: Collects additional counters granted to `enteringObj` as it enters the battlefield
 * from external replacement effects on other battlefield permanents (e.g., Grumgully, Renata,
 * Metallic Mimic, Good-Fortune Unicorn-style replacements).
 */
export function collectExternalEtbCounters(
	state: GameState,
	enteringObj: CardInstance,
	enteringControllerId: string
): Array<{ counter: CounterType; amount: number }> {
	const out: Array<{ counter: CounterType; amount: number }> = [];
	forEachActiveReplacementOnBattlefield(
		state,
		'zoneChange',
		(perm, controllerId, def) => {
			const f = def.replaces.filter;
			if (f?.to !== 'battlefield') return;
			if (f.object === 'self' || f.object === undefined) return;
			if (Array.isArray(def.with) || def.with.k !== 'modify') return;
			const cSpec = def.with.additionalCounters ?? def.with.counters;
			if (!cSpec) return;
			if (!matchesReplacementPlayer(f.player, controllerId, enteringControllerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (def.condition && !evaluateCondition(def.condition, ctx)) return;
			if (f.object === 'attachedTo') {
				if (perm.attachedToId !== enteringObj.instanceId) return;
			} else if (!matchesObjectFilter(enteringObj, f.object, ctx)) {
				return;
			}
			const n = Math.max(0, evaluateAmount(cSpec.amount, ctx));
			if (n > 0) {
				out.push({ counter: cSpec.counter, amount: n });
			}
		},
		enteringObj.instanceId
	);
	return out;
}

// ---- 6. Chosen Card Name ETB & Cast/Activation Restrictions (CR 201.2a, 614.12) -------------

function isLandOnlyCard(card: ScryfallCard): boolean {
	const view = resolveObjectFaces(card, { zone: 'hand' });
	return view.types.includes('Land') && view.types.length === 1;
}

/**
 * Builds deterministic candidate card names for `"As ~ enters, choose a [nonland] card name"` from
 * all cards present across the game's zones and stack (prioritizing opponent commanders, opponent
 * permanents, stack spells, graveyards, and known cards).
 */
export function buildCardNameChoiceOptions(
	state: GameState,
	chooser: PlayerGameState,
	sourceObj: CardInstance,
	nonlandOnly: boolean
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	const tryAdd = (card: ScryfallCard | undefined) => {
		if (!card) return;
		if (nonlandOnly && isLandOnlyCard(card)) return;
		const name = resolveObjectFaces(card, { zone: 'hand' }).name.trim();
		if (!name) return;
		const low = name.toLowerCase();
		if (seen.has(low)) return;
		seen.add(low);
		result.push(name);
	};

	// 1. Opponent battlefield, command zone, stack, graveyard, exile
	for (const p of state.players) {
		if (p.lost || p.playerId === chooser.playerId) continue;
		for (const c of p.command) tryAdd(effectiveCardForObject(c));
		for (const c of p.battlefield) {
			if (!c.isFaceDown) tryAdd(effectiveCardForObject(c));
		}
		for (const c of p.graveyard) tryAdd(effectiveCardForObject(c));
		for (const c of p.exile) {
			if (!c.isFaceDown) tryAdd(effectiveCardForObject(c));
		}
		for (const c of p.hand) tryAdd(effectiveCardForObject(c));
		for (const c of p.library) tryAdd(effectiveCardForObject(c));
	}
	for (const s of state.stack) {
		if (!s.isFaceDown) tryAdd(s.card);
	}
	// 2. Chooser's own zones
	for (const c of chooser.command) tryAdd(effectiveCardForObject(c));
	for (const c of chooser.battlefield) {
		if (!c.isFaceDown) tryAdd(effectiveCardForObject(c));
	}
	for (const c of chooser.hand) tryAdd(effectiveCardForObject(c));
	for (const c of chooser.graveyard) tryAdd(effectiveCardForObject(c));
	for (const c of chooser.exile) {
		if (!c.isFaceDown) tryAdd(effectiveCardForObject(c));
	}
	for (const c of chooser.library) tryAdd(effectiveCardForObject(c));
	tryAdd(effectiveCardForObject(sourceObj));

	if (result.length === 0) {
		result.push('Construct');
	}
	return result.slice(0, 60);
}

export function chooseBotBestCardName(
	state: GameState,
	chooser: PlayerGameState,
	sourceObj: CardInstance,
	nonlandOnly: boolean
): string {
	// Prefer an opponent permanent with non-mana activated abilities or an opponent commander
	for (const p of state.players) {
		if (p.lost || p.playerId === chooser.playerId) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.isFaceDown) continue;
			const card = effectiveCardForObject(perm);
			if (nonlandOnly && isLandOnlyCard(card)) continue;
			const hasNonManaAct = activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield')).some(
				(ab) => (ab.kind === 'activated' && !ab.isMana) || (ab.kind === 'keyword' && Boolean(ab.keyword.cost))
			);
			if (hasNonManaAct) {
				return resolveObjectFaces(card, instanceFaceOptions(perm, 'battlefield')).name;
			}
		}
		for (const cmd of p.command) {
			const card = effectiveCardForObject(cmd);
			if (nonlandOnly && isLandOnlyCard(card)) continue;
			return resolveObjectFaces(card, { zone: 'command' }).name;
		}
	}
	const opts = buildCardNameChoiceOptions(state, chooser, sourceObj, nonlandOnly);
	const selfName = resolveObjectFaces(effectiveCardForObject(sourceObj), { zone: 'hand' }).name;
	return opts.find((n) => n.toLowerCase() !== selfName.toLowerCase()) ?? opts[0] ?? 'Construct';
}

export function boardHasAnyChosenCardName(state: GameState): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (!perm.phasedOut && perm.chosenCardName) return true;
		}
	}
	return false;
}

const RULE_CANT_CAST_CHOSEN = ['cantCastChosenName'] as const;
const RULE_CANT_GAIN_LIFE = ['cantGainLife', 'lifeTotalCantChange'] as const;
const RULE_SKIP_DRAW = ['skipDrawStep'] as const;
const RULE_MAX_HAND_SIZE = ['noMaxHandSize', 'setMaxHandSize', 'maxHandSizeDelta'] as const;
const RULE_LIFE_CANT_CHANGE = ['lifeTotalCantChange'] as const;

export function isSpellBannedByChosenName(
	state: GameState,
	casterId: string,
	spellNames: readonly string[]
): { banned: boolean; sourceName?: string } {
	if (spellNames.length === 0 || !boardHasAnyChosenCardName(state)) return { banned: false };
	const lowerNames = spellNames.map((n) => n.toLowerCase());
	let result: { banned: boolean; sourceName?: string } = { banned: false };
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, sourceName, st) => {
			if (result.banned) return;
			if (st.k !== 'ruleModifier' || st.rule !== 'cantCastChosenName') return;
			const chosen = perm.chosenCardName?.trim().toLowerCase();
			if (!chosen || !lowerNames.includes(chosen)) return;
			if (!matchesReplacementPlayer(st.who, controllerId, casterId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			result = { banned: true, sourceName };
		},
		'ruleModifier',
		RULE_CANT_CAST_CHOSEN
	);
	return result;
}

export function isActivationBannedByChosenName(
	state: GameState,
	sourceObj: CardInstance,
	isManaAbility: boolean
): { banned: boolean; sourceName?: string } {
	if (!boardHasAnyChosenCardName(state)) return { banned: false };
	const card = effectiveCardForObject(sourceObj);
	const view =
		sourceObj.zone === 'battlefield'
			? { names: [evaluatePermanent(state, sourceObj).effectiveName] }
			: resolveObjectFaces(card, instanceFaceOptions(sourceObj, sourceObj.zone));
	const lowerNames = view.names.map((n) => n.toLowerCase());
	let result: { banned: boolean; sourceName?: string } = { banned: false };
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, sourceName, st) => {
			if (result.banned) return;
			if (st.k !== 'cantActivateAbilities') return;
			if (typeof st.affected !== 'object' || !st.affected.ofChosenName) return;
			if (isManaAbility && st.allowManaAbilities) return;
			const chosen = perm.chosenCardName?.trim().toLowerCase();
			if (!chosen || !lowerNames.includes(chosen)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			if (
				st.affected.controller === 'opponent' &&
				(sourceObj.controllerId || sourceObj.ownerId) === controllerId
			) {
				return;
			}
			if (
				st.affected.controller === 'you' &&
				(sourceObj.controllerId || sourceObj.ownerId) !== controllerId
			) {
				return;
			}
			result = { banned: true, sourceName };
		},
		'cantActivateAbilities'
	);
	return result;
}

// ---- 7. Static Damage & Life Gain Replacements (CR 614.7a, CR 119.7, CR 119.10) -------------

export interface DamageModificationContext {
	source?: CardInstance;
	sourceCard?: ScryfallCard;
	sourceControllerId?: string;
	isCombat: boolean;
	targetKind: 'player' | 'permanent';
	targetPlayerId?: string;
	targetPermanent?: CardInstance;
}

/**
 * CR 614.7a: Applies static damage addition and multiplication replacement effects (e.g. Torbran,
 * Fiery Emancipation, City on Fire, Mechanized Warfare, Solphim, Furnace of Rath, Dictate of the
 * Twin Gods). If `baseDamage <= 0`, returns `0` immediately (`CR 614.7a`: 0 damage is not damage
 * being dealt and is never increased to +N!).
 */
export function applyStaticDamageModifiers(
	state: GameState,
	baseDamage: number,
	dctx: DamageModificationContext
): number {
	if (baseDamage <= 0) return 0;

	let syntheticSourceComputed = false;
	let syntheticSource: CardInstance | undefined;
	const getSyntheticSource = (): CardInstance | undefined => {
		if (!syntheticSourceComputed) {
			syntheticSourceComputed = true;
			syntheticSource =
				dctx.source ??
				(dctx.sourceCard
					? {
							instanceId: '__dmg_src__',
							card: dctx.sourceCard,
							ownerId: dctx.sourceControllerId ?? '',
							controllerId: dctx.sourceControllerId ?? '',
							zone: 'stack',
							tapped: false,
							summoningSick: false,
							damageMarked: 0,
							deathtouchDamageMarked: false,
							counters: createEmptyCounterMap(),
							tempPowerMod: 0,
							tempToughnessMod: 0,
							grantedKeywords: [],
							attachedToId: null,
							isToken: false,
							isCommander: false,
							commanderCastCount: 0,
							usedLoyaltyThisTurn: false,
							transformed: false
						}
					: undefined);
		}
		return syntheticSource;
	};

	let targetControllerComputed = false;
	let targetOwnerOrControllerId: string | undefined;
	const getTargetControllerId = (): string | undefined => {
		if (!targetControllerComputed) {
			targetControllerComputed = true;
			targetOwnerOrControllerId =
				dctx.targetKind === 'player'
					? dctx.targetPlayerId
					: dctx.targetPermanent
						? evaluatePermanent(state, dctx.targetPermanent).controllerId
						: undefined;
		}
		return targetOwnerOrControllerId;
	};

	const ops: Array<{ kind: 'add'; delta: number } | { kind: 'mul'; factor: number }> = [];

	forEachActiveReplacementOnBattlefield(state, 'damage', (repSource, repControllerId, rep) => {
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.damageMod) return;
		const dm = rep.with.damageMod;
		if (dm.combatOnly && !dctx.isCombat) return;
		if (dm.noncombatOnly && dctx.isCombat) return;

		const ctx: FilterContext = { state, controllerId: repControllerId, source: repSource };
		if (rep.condition && !evaluateCondition(rep.condition, ctx)) return;

		if (dm.sourceFilter) {
			const src = getSyntheticSource();
			if (!src) return;
			if (dm.sourceFilter === 'self') {
				if (src.instanceId !== repSource.instanceId) return;
			} else if (dm.sourceFilter === 'attachedTo') {
				if (repSource.attachedToId !== src.instanceId) return;
			} else {
				const srcZone = src.zone === 'battlefield' ? 'battlefield' : 'stack';
				if (!matchesObjectFilter(src, dm.sourceFilter, { ...ctx, zone: srcZone })) {
					return;
				}
			}
		}

		if (dm.targetFilter === 'opponent') {
			if (dctx.targetKind !== 'player' || !dctx.targetPlayerId) return;
			if (dctx.targetPlayerId === repControllerId) return;
		} else if (dm.targetFilter === 'opponentOrOpponentPerm') {
			const tgtCtrl = getTargetControllerId();
			if (!tgtCtrl || tgtCtrl === repControllerId) return;
		}

		if (dm.mode === 'add' && dm.add) {
			const n = Math.max(0, evaluateAmount(dm.add, ctx));
			if (n > 0) ops.push({ kind: 'add', delta: n });
		} else if (dm.mode === 'double') {
			ops.push({ kind: 'mul', factor: 2 });
		} else if (dm.mode === 'triple') {
			ops.push({ kind: 'mul', factor: 3 });
		}
	});

	if (ops.length === 0) return baseDamage;

	// Apply additive (+N) replacements before multiplicative (×2 / ×3) replacements
	let amount = baseDamage;
	for (const op of ops) {
		if (op.kind === 'add') amount += op.delta;
	}
	for (const op of ops) {
		if (op.kind === 'mul') amount *= op.factor;
	}
	return amount;
}

/**
 * CR 119.7: True when an active rule modifier (`cantGainLife` or `lifeTotalCantChange`) prevents
 * `playerId` from gaining life.
 */
export function playerCantGainLife(state: GameState, playerId: string): boolean {
	let blocked = false;
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, _name, st) => {
			if (blocked) return;
			if (st.k !== 'ruleModifier') return;
			if (st.rule !== 'cantGainLife' && st.rule !== 'lifeTotalCantChange') return;
			if (!matchesReplacementPlayer(st.who, controllerId, playerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			blocked = true;
		},
		'ruleModifier',
		RULE_CANT_GAIN_LIFE
	);
	return blocked;
}

/**
 * CR 119.6 / CR 119.10: Applies static life-gain replacement effects (`+N` and `×2`, e.g. Angel of
 * Vitality, Cleric Class, Rhox Faithmender, Alhammarret's Archive, Boon Reflection). `0` life stays `0`.
 */
export function applyStaticLifeGainModifiers(
	state: GameState,
	playerId: string,
	baseAmount: number
): number {
	if (baseAmount <= 0) return 0;
	const ops: Array<{ kind: 'add'; delta: number } | { kind: 'mul'; factor: number }> = [];

	forEachActiveReplacementOnBattlefield(state, 'lifeGain', (perm, controllerId, rep) => {
		if (Array.isArray(rep.with) || rep.with.k !== 'modify' || !rep.with.lifeGainMod) return;
		if (!matchesReplacementPlayer(rep.replaces.filter?.player ?? rep.who, controllerId, playerId)) {
			return;
		}
		const ctx: FilterContext = { state, controllerId, source: perm };
		if (rep.condition && !evaluateCondition(rep.condition, ctx)) return;
		const lm = rep.with.lifeGainMod;
		if (lm.mode === 'add' && lm.add) {
			const n = Math.max(0, evaluateAmount(lm.add, ctx));
			if (n > 0) ops.push({ kind: 'add', delta: n });
		} else if (lm.mode === 'double') {
			ops.push({ kind: 'mul', factor: 2 });
		}
	});

	if (ops.length === 0) return baseAmount;

	let amount = baseAmount;
	for (const op of ops) {
		if (op.kind === 'add') amount += op.delta;
	}
	for (const op of ops) {
		if (op.kind === 'mul') amount *= op.factor;
	}
	return amount;
}

// ---- 8. Untap Choice (CR 502.3), Skip Draw (CR 504.1), Hand Size, & Toughness Damage --------

function staticAffectedMatchesPermanent(
	affected: 'self' | 'attachedTo' | ObjectFilter,
	target: CardInstance,
	source: CardInstance,
	controllerId: string,
	state: GameState
): boolean {
	if (affected === 'self') return target.instanceId === source.instanceId;
	if (affected === 'attachedTo') return source.attachedToId === target.instanceId;
	return matchesObjectFilter(target, affected, { state, controllerId, source });
}

export function permanentMayChooseNotToUntap(state: GameState, perm: CardInstance): boolean {
	let mayChoose = false;
	forEachActiveStaticOnBattlefield(
		state,
		(sourcePerm, controllerId, _name, st) => {
			if (mayChoose) return;
			if (st.k !== 'mayChooseNotToUntap') return;
			const ctx: FilterContext = { state, controllerId, source: sourcePerm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			if (staticAffectedMatchesPermanent(st.affected, perm, sourcePerm, controllerId, state)) {
				mayChoose = true;
			}
		},
		'mayChooseNotToUntap'
	);
	return mayChoose;
}

export function playerSkipsDrawStep(state: GameState, playerId: string): boolean {
	let skips = false;
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, _name, st) => {
			if (skips) return;
			if (st.k !== 'ruleModifier' || st.rule !== 'skipDrawStep') return;
			if (!matchesReplacementPlayer(st.who, controllerId, playerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			skips = true;
		},
		'ruleModifier',
		RULE_SKIP_DRAW
	);
	return skips;
}

/**
 * CR 402.2 / CR 613.11: Computes effective maximum hand size for `player`, or `null` when the
 * player has no maximum hand size.
 */
export function computeEffectiveMaxHandSize(
	state: GameState,
	playerOrId: PlayerGameState | string
): number | null {
	const targetPlayerId = typeof playerOrId === 'string' ? playerOrId : playerOrId.playerId;
	const ruleDefault = state.rules.maxHandSize ?? 7;
	if (ruleDefault >= 99) return null;

	type HandOp =
		| { timestamp: number; kind: 'noMax' }
		| { timestamp: number; kind: 'set'; size: number }
		| { timestamp: number; kind: 'delta'; delta: number };
	const ops: HandOp[] = [];
	let order = 0;

	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, _name, st) => {
			if (st.k !== 'ruleModifier') return;
			if (
				st.rule !== 'noMaxHandSize' &&
				st.rule !== 'setMaxHandSize' &&
				st.rule !== 'maxHandSizeDelta'
			) {
				return;
			}
			if (!matchesReplacementPlayer(st.who, controllerId, targetPlayerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			const ts = (perm.enteredTimestamp ?? 0) * 1000 + order++;
			if (st.rule === 'noMaxHandSize') {
				ops.push({ timestamp: ts, kind: 'noMax' });
			} else if (st.rule === 'setMaxHandSize') {
				const raw = st.params?.size;
				const size =
					typeof raw === 'number'
						? raw
						: raw && typeof raw === 'object' && 'k' in (raw as Amount)
							? evaluateAmount(raw as Amount, ctx)
							: 7;
				ops.push({ timestamp: ts, kind: 'set', size });
			} else if (st.rule === 'maxHandSizeDelta') {
				const raw = st.params?.delta;
				const delta =
					typeof raw === 'number'
						? raw
						: raw && typeof raw === 'object' && 'k' in (raw as Amount)
							? evaluateAmount(raw as Amount, ctx)
							: 0;
				ops.push({ timestamp: ts, kind: 'delta', delta });
			}
		},
		'ruleModifier',
		RULE_MAX_HAND_SIZE
	);

	ops.sort((a, b) => a.timestamp - b.timestamp);
	let current: number | null = ruleDefault;
	for (const op of ops) {
		if (op.kind === 'noMax') {
			current = null;
		} else if (op.kind === 'set') {
			current = op.size;
		} else if (op.kind === 'delta' && current !== null) {
			current += op.delta;
		}
	}
	return current === null ? null : Math.max(0, current);
}

/**
 * CR 510.1a: True when `perm` assigns combat damage equal to its toughness rather than its power
 * (e.g. Doran, the Siege Tower; Assault Formation; High Alert; Arcades, the Strategist).
 */
export function creatureAssignsCombatDamageByToughness(
	state: GameState,
	perm: CardInstance
): boolean {
	let byToughness = false;
	forEachActiveStaticOnBattlefield(
		state,
		(sourcePerm, controllerId, _name, st) => {
			if (byToughness) return;
			if (st.k !== 'assignCombatDamageByToughness') return;
			const ctx: FilterContext = { state, controllerId, source: sourcePerm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			if (staticAffectedMatchesPermanent(st.affected, perm, sourcePerm, controllerId, state)) {
				byToughness = true;
			}
		},
		'assignCombatDamageByToughness'
	);
	return byToughness;
}

// ---- 9. Snow Mana {S} (CR 107.4h) & Phyrexian Life Legality (CR 119.4, 119.8) ---------------

export function isSnowPermanent(state: GameState, perm: CardInstance): boolean {
	if (perm.zone === 'battlefield') {
		const ev = evaluatePermanent(state, perm);
		const left = ev.effectiveTypeLine.split(/\s+—\s+/)[0] ?? '';
		return left.split(/\s+/).includes('Snow');
	}
	const view = resolveObjectFaces(
		effectiveCardForObject(perm),
		instanceFaceOptions(perm, perm.zone)
	);
	return view.supertypes.includes('Snow');
}

export function totalSnowManaInPool(player: PlayerGameState): number {
	const map = player.snowManaByColor;
	if (!map) return 0;
	let total = 0;
	const cols: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	for (const c of cols) {
		const inPool = player.manaPool[c] || 0;
		const snow = Math.max(0, Math.min(inPool, map[c] || 0));
		total += snow;
	}
	return total;
}

export function recordSnowManaAdded(
	player: PlayerGameState,
	color: ManaColor,
	amount: number
): void {
	if (amount <= 0) return;
	const map = (player.snowManaByColor ??= {});
	map[color] = Math.min(player.manaPool[color] || 0, (map[color] || 0) + amount);
}

export function clearSnowManaPool(player: PlayerGameState): void {
	if (player.snowManaByColor) {
		delete player.snowManaByColor;
	}
}

export function clampSnowManaToPool(player: PlayerGameState): void {
	const map = player.snowManaByColor;
	if (!map) return;
	let anyLeft = false;
	const cols: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
	for (const c of cols) {
		const clamped = Math.max(0, Math.min(player.manaPool[c] || 0, map[c] || 0));
		if (clamped > 0) {
			map[c] = clamped;
			anyLeft = true;
		} else {
			delete map[c];
		}
	}
	if (!anyLeft) {
		delete player.snowManaByColor;
	}
}

/**
 * Deducts `req` from `player.manaPool` while:
 * 1. Spending non-snow mana before snow mana on colored and generic pips so snow mana is conserved;
 * 2. Spending snow mana (`player.snowManaByColor`) specifically for `req.snow` (`{S}`).
 */
export function deductManaConservingSnow(
	player: PlayerGameState,
	req: ManaCostRequirement,
	onPayLife?: (life: number) => void
): void {
	const resolved = resolveFlexibleManaRequirement(player.manaPool, req);
	if (resolved.lifePaid > 0 && onPayLife) {
		onPayLife(resolved.lifePaid);
	}
	const pool = player.manaPool;
	const snowMap = player.snowManaByColor ?? {};
	const colors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

	// 1. Spend colored pips, using non-snow mana of color `c` before snow mana of color `c`
	for (const c of colors) {
		const need = resolved.colored[c] || 0;
		if (need <= 0) continue;
		const totalC = pool[c] || 0;
		const snowC = Math.min(totalC, snowMap[c] || 0);
		const nonSnowC = Math.max(0, totalC - snowC);
		const fromNonSnow = Math.min(need, nonSnowC);
		const fromSnow = Math.max(0, need - fromNonSnow);
		pool[c] = Math.max(0, totalC - need);
		if (fromSnow > 0 && snowMap[c]) {
			snowMap[c] = Math.max(0, snowC - fromSnow);
		}
	}

	// 2. Spend {S} snow pips strictly from remaining snow mana (colorless C first, then largest surplus)
	let remSnow = req.snow ?? 0;
	if (remSnow > 0) {
		const snowC = Math.min(pool.C || 0, snowMap.C || 0);
		if (snowC > 0) {
			const take = Math.min(remSnow, snowC);
			pool.C -= take;
			snowMap.C = Math.max(0, snowC - take);
			remSnow -= take;
		}
		const colorOrder: ManaColor[] = ['G', 'R', 'B', 'U', 'W'];
		for (let guard = 0; guard < 128 && remSnow > 0; guard++) {
			let bestCol: ManaColor | null = null;
			let bestSnow = 0;
			for (const c of colorOrder) {
				const sc = Math.min(pool[c] || 0, snowMap[c] || 0);
				if (sc > bestSnow) {
					bestSnow = sc;
					bestCol = c;
				}
			}
			if (!bestCol || bestSnow <= 0) break;
			pool[bestCol] -= 1;
			snowMap[bestCol] = Math.max(0, bestSnow - 1);
			remSnow -= 1;
		}
		// Fallback if any snow pip wasn't tracked (e.g. test injected pool directly)
		if (remSnow > 0) {
			for (const c of ['C', 'G', 'R', 'B', 'U', 'W'] as const) {
				if (remSnow <= 0) break;
				const take = Math.min(remSnow, pool[c] || 0);
				pool[c] -= take;
				remSnow -= take;
			}
		}
	}

	// 3. Spend generic mana: non-snow C first, then non-snow colored, then snow C, then snow colored
	let remGeneric = resolved.generic;
	if (remGeneric > 0) {
		const nonSnowC = Math.max(0, (pool.C || 0) - Math.min(pool.C || 0, snowMap.C || 0));
		if (nonSnowC > 0) {
			const take = Math.min(remGeneric, nonSnowC);
			pool.C -= take;
			remGeneric -= take;
		}
	}
	const colorOrder: ManaColor[] = ['G', 'R', 'B', 'U', 'W'];
	for (let guard = 0; guard < 256 && remGeneric > 0; guard++) {
		let bestCol: ManaColor | null = null;
		let bestNonSnow = 0;
		for (const c of colorOrder) {
			const nonSnow = Math.max(0, (pool[c] || 0) - Math.min(pool[c] || 0, snowMap[c] || 0));
			if (nonSnow > bestNonSnow) {
				bestNonSnow = nonSnow;
				bestCol = c;
			}
		}
		if (!bestCol || bestNonSnow <= 0) break;
		pool[bestCol] -= 1;
		remGeneric -= 1;
	}
	if (remGeneric > 0 && pool.C > 0) {
		const take = Math.min(remGeneric, pool.C);
		pool.C -= take;
		if (snowMap.C) snowMap.C = Math.max(0, Math.min(pool.C, snowMap.C));
		remGeneric -= take;
	}
	for (let guard = 0; guard < 256 && remGeneric > 0; guard++) {
		let bestCol: ManaColor | null = null;
		let bestAmt = 0;
		for (const c of colorOrder) {
			if ((pool[c] || 0) > bestAmt) {
				bestAmt = pool[c] || 0;
				bestCol = c;
			}
		}
		if (!bestCol || bestAmt <= 0) break;
		pool[bestCol] -= 1;
		if (snowMap[bestCol]) snowMap[bestCol] = Math.min(pool[bestCol], snowMap[bestCol]!);
		remGeneric -= 1;
	}

	clampSnowManaToPool(player);
}

/**
 * CR 119.4, CR 119.8: True when `player` cannot pay `lifeAmount` life as a cost (insufficient life
 * total or `lifeTotalCantChange` effect).
 */
export function playerCantPayLifeForCost(
	state: GameState,
	player: PlayerGameState,
	lifeAmount: number
): boolean {
	if (lifeAmount <= 0) return false;
	if (player.life < lifeAmount) return true;
	if (player.lifeTotalCannotChangeThisTurn) return true;
	let locked = false;
	forEachActiveStaticOnBattlefield(
		state,
		(perm, controllerId, _name, st) => {
			if (locked) return;
			if (st.k !== 'ruleModifier' || st.rule !== 'lifeTotalCantChange') return;
			if (!matchesReplacementPlayer(st.who, controllerId, player.playerId)) return;
			const ctx: FilterContext = { state, controllerId, source: perm };
			if (st.condition && !evaluateCondition(st.condition, ctx)) return;
			locked = true;
		},
		'ruleModifier',
		RULE_LIFE_CANT_CHANGE
	);
	return locked;
}
