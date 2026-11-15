/**
 * Wave 8 Track P22a — Remaining `CR 614.12` ETB Choices (`CardType`, `Number`, `TwoColors`,
 * `TwoPlayers`, `AnotherCreature`, Disjunctive Subtypes, Commander Pre-Game Color), Damage
 * Redirection & Unpreventable Shields (`CR 614.9`, `CR 615.12`), Counter Locks & Zone-Persistent
 * Counters (`CR 122.6`, `CR 122.2`), Player-Counter / Starting-Life-Delta / Distinct-Name Scaling,
 * Symmetrical Land Drops & Stax Locks, & Graveyard/Hand Alt-Ability Grants.
 *
 * Upholds ENGINE_INVARIANTS.md:
 * - Zero rules-text reads
 * - Zero card-name comparisons or precon card names in code
 * - Zero direct zone mutations
 * - Zero IR in `GameState`
 * - Bounded loops only
 */
import type {
	ActivatedAbility,
	Condition,
	CostDef,
	EffectStep,
	KeywordDef,
	ModalDef,
	ObjectFilter,
	Span,
	TargetSpec
} from '../ir.ts';
import { buildScavengeAbility, buildUnearthAbility } from '../keywords.ts';
import { parseManaCost } from '../oracle.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	CastOption,
	CounterType,
	GamePhase,
	GameState,
	HandSpecialActionOption,
	ManaColor,
	PendingPrompt,
	PlayerGameState,
	ScryfallCard
} from '../types.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { evaluatePermanent, permanentHasLostAllAbilities } from './layers.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter } from './objectFilter.ts';
import { activeRuleModifiers } from './replace.ts';
import {
	boardMayGrantReplacementAbility,
	collectActiveGrantedReplacementDefs,
	forEachActiveStaticOnBattlefield
} from './staticsDynamicAndCosts.ts';

// ---- Constants ------------------------------------------------------------------------------

/** CR 300.1: The nine standard Magic card types in canonical Title Case. */
export const ALL_MTG_CARD_TYPES: readonly string[] = [
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Land',
	'Planeswalker',
	'Sorcery'
];

const FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
const COLOR_DISPLAY_NAMES: Record<ManaColor, string> = {
	W: 'White',
	U: 'Blue',
	B: 'Black',
	R: 'Red',
	G: 'Green',
	C: 'Colorless'
};

/** All 10 unordered two-color pairs for single-prompt `chooseTwoColors` ETB choices. */
export const TWO_COLOR_PAIRS: ReadonlyArray<readonly [ManaColor, ManaColor]> = [
	['W', 'U'],
	['W', 'B'],
	['U', 'B'],
	['U', 'R'],
	['B', 'R'],
	['B', 'G'],
	['R', 'G'],
	['R', 'W'],
	['G', 'W'],
	['G', 'U']
];

export const TWO_COLOR_PAIR_LABELS: readonly string[] = TWO_COLOR_PAIRS.map(
	([a, b]) => `${COLOR_DISPLAY_NAMES[a]} and ${COLOR_DISPLAY_NAMES[b]}`
);

const COMBAT_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>([
	'begin_combat',
	'declare_attackers',
	'declare_blockers',
	'first_strike_damage',
	'combat_damage',
	'end_combat'
]);

const DUMMY_SPAN: Span = { start: 0, end: 0 };

function extractTypesFromTypeLine(typeLine: string): string[] {
	const [left = ''] = typeLine.split(/\s+—\s+/);
	return left.trim().split(/\s+/).filter(Boolean);
}

// ---- 1. Cluster 1: CR 614.12 ETB Choices & Commander Pre-Game Color -------------------------

export function normalizeCardTypeChoice(raw: string): string | null {
	const t = raw.trim().toLowerCase();
	if (t === 'tribal' || t === 'kindred') return 'Kindred';
	const found = ALL_MTG_CARD_TYPES.find((ct) => ct.toLowerCase() === t);
	return found ?? null;
}

/**
 * Formats a chosen Title-Case card type into the canonical plural protection keyword string
 * recognized by `permanentProtectedFromSource` / `hasProtectionFrom` (e.g. `'Protection from creatures'`).
 */
export function pluralizeCardTypeForProtection(cardType: string): string {
	const norm = normalizeCardTypeChoice(cardType) ?? cardType.trim();
	const lower = norm.toLowerCase();
	if (lower === 'sorcery') return 'sorceries';
	if (lower === 'kindred') return 'kindred';
	return `${lower}s`;
}

export function buildCardTypeChoiceOptions(spec: {
	exclude?: string[];
	options?: string[];
}): string[] {
	const base =
		spec.options && spec.options.length > 0
			? spec.options
					.map((o) => normalizeCardTypeChoice(o))
					.filter((x): x is string => x !== null)
			: [...ALL_MTG_CARD_TYPES];
	const excluded = new Set(
		(spec.exclude ?? [])
			.map((e) => normalizeCardTypeChoice(e))
			.filter((x): x is string => x !== null)
	);
	const filtered = base.filter((ct) => !excluded.has(ct));
	return filtered.length > 0 ? filtered : ['Creature'];
}

export function chooseBotBestCardType(
	state: GameState,
	controllerId: string,
	options: string[]
): string {
	if (options.length === 0) return 'Creature';
	const counts = new Map<string, number>();
	for (const opt of options) counts.set(opt, 0);
	for (const p of state.players) {
		if (p.lost) continue;
		const weight = p.playerId === controllerId ? 1 : 2;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			for (const t of extractTypesFromTypeLine(ev.typeLine)) {
				const norm = normalizeCardTypeChoice(t);
				if (norm && counts.has(norm)) counts.set(norm, (counts.get(norm) ?? 0) + weight);
			}
		}
		for (const hc of p.hand) {
			const isKnown =
				p.playerId === controllerId || Boolean(hc.knownToPlayerIds?.includes(controllerId));
			if (!isKnown) continue;
			const view = resolveObjectFaces(hc.card, instanceFaceOptions(hc, 'hand'));
			for (const t of view.types) {
				const norm = normalizeCardTypeChoice(t);
				if (norm && counts.has(norm)) counts.set(norm, (counts.get(norm) ?? 0) + weight);
			}
		}
	}
	let best = options[0];
	let bestScore = -1;
	for (const opt of options) {
		const score = counts.get(opt) ?? 0;
		if (score > bestScore) {
			bestScore = score;
			best = opt;
		}
	}
	return bestScore > 0 ? best : options.includes('Creature') ? 'Creature' : options[0];
}

export function buildNumberChoiceBounds(spec: { min?: number; max?: number }): {
	min: number;
	max: number;
} {
	const min = Math.max(0, spec.min ?? 0);
	const max = Math.max(min, spec.max ?? 12);
	return { min, max };
}

export function chooseBotBestNumber(
	state: GameState,
	controllerId: string,
	spec: { min?: number; max?: number }
): number {
	const { min, max } = buildNumberChoiceBounds(spec);
	const mvCounts = new Map<number, number>();
	for (const p of state.players) {
		if (p.lost || p.playerId === controllerId) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const mv = Math.round(perm.card.cmc ?? 0);
			if (mv >= min && mv <= max) mvCounts.set(mv, (mvCounts.get(mv) ?? 0) + 1);
		}
		for (const gy of p.graveyard) {
			const mv = Math.round(gy.card.cmc ?? 0);
			if (mv >= min && mv <= max) mvCounts.set(mv, (mvCounts.get(mv) ?? 0) + 1);
		}
	}
	let best = Math.min(max, Math.max(min, 2));
	let bestScore = 0;
	for (const [mv, cnt] of mvCounts) {
		if (cnt > bestScore) {
			bestScore = cnt;
			best = mv;
		}
	}
	return best;
}

export function parseTwoColorPairIndex(index: number): [ManaColor, ManaColor] {
	const pair = TWO_COLOR_PAIRS[index] ?? TWO_COLOR_PAIRS[0];
	return [pair[0], pair[1]];
}

export function chooseBotTwoColors(
	state: GameState,
	controllerId: string
): [ManaColor, ManaColor] {
	const p = state.players.find((pl) => pl.playerId === controllerId);
	const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	if (p) {
		for (const cardInst of [...p.hand, ...p.battlefield]) {
			for (const c of cardInst.card.colors ?? []) {
				if (c in counts) counts[c as ManaColor]++;
			}
		}
	}
	const sorted = [...FIVE_COLORS].sort((a, b) => counts[b] - counts[a]);
	return [sorted[0], sorted[1]];
}

export function buildTwoPlayersCandidates(state: GameState): string[] {
	return state.players.filter((p) => !p.lost).map((p) => p.playerId);
}

export function chooseBotTwoPlayers(state: GameState, controllerId: string): string[] {
	const opps = state.players
		.filter((p) => !p.lost && p.playerId !== controllerId)
		.sort((a, b) => b.life - a.life);
	if (opps.length >= 2) return [opps[0].playerId, opps[1].playerId];
	if (opps.length === 1) return [opps[0].playerId, controllerId];
	return [controllerId];
}

export function findEtbObjectChoiceCandidates(
	state: GameState,
	controllerId: string,
	enteringPerm: CardInstance,
	filter: ObjectFilter
): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			if (filter.other && perm.instanceId === enteringPerm.instanceId) continue;
			if (
				matchesObjectFilter(
					perm,
					{ ...filter, zone: 'battlefield' },
					{ state, controllerId, source: enteringPerm }
				)
			) {
				out.push(perm);
			}
		}
	}
	return out;
}

export function chooseBotBestEtbObject(
	state: GameState,
	controllerId: string,
	enteringPerm: CardInstance,
	filter: ObjectFilter
): string | undefined {
	const candidates = findEtbObjectChoiceCandidates(state, controllerId, enteringPerm, filter);
	if (candidates.length === 0) return undefined;
	let best = candidates[0];
	let bestScore = -Infinity;
	for (const cand of candidates) {
		const ev = evaluatePermanent(state, cand);
		const score = (ev.power ?? 0) + (ev.toughness ?? 0) + (cand.card.cmc ?? 0);
		if (score > bestScore) {
			bestScore = score;
			best = cand;
		}
	}
	return best.instanceId;
}

/**
 * Reveals an opponent's hand to `controllerId` for ETB look-then-choose effects
 * ("As ~ enters, look at an opponent's hand, then choose ...").
 */
export function revealOpponentHandForEtbLook(
	state: GameState,
	controllerId: string
): PlayerGameState | undefined {
	const opp =
		state.players.find((p) => !p.lost && p.playerId !== controllerId && p.hand.length > 0) ??
		state.players.find((p) => !p.lost && p.playerId !== controllerId);
	if (!opp) return undefined;
	for (const hc of opp.hand) {
		if (!hc.knownToPlayerIds) hc.knownToPlayerIds = [];
		if (!hc.knownToPlayerIds.includes(controllerId)) {
			hc.knownToPlayerIds.push(controllerId);
		}
	}
	return opp;
}

export function hasCommanderPreGameColorStatic(card: ScryfallCard): boolean {
	for (const ab of activeAbilityDefs(card, { zone: 'command', faceIndex: 0 })) {
		if (ab.kind === 'static' && ab.static.k === 'commanderPreGameColorChoice') {
			return true;
		}
	}
	return false;
}

function chooseBestDeckColorForCommander(player: PlayerGameState): ManaColor {
	const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
	for (const c of player.commanderColorIdentity ?? []) {
		if (c in counts) counts[c] += 5;
	}
	for (const inst of [...player.command, ...player.hand, ...player.library]) {
		for (const c of inst.card.colorIdentity ?? inst.card.colors ?? []) {
			if (c in counts) counts[c as ManaColor]++;
		}
	}
	let best: ManaColor = 'W';
	let bestScore = -1;
	for (const col of FIVE_COLORS) {
		if (counts[col] > bestScore) {
			bestScore = counts[col];
			best = col;
		}
	}
	return best;
}

export function finalizeCommanderPreGameColorChoice(
	player: PlayerGameState,
	cmd: CardInstance,
	color: ManaColor
): void {
	cmd.chosenColor = color;
	cmd.preGameChosenColor = color;
	cmd.commanderPreGameColorDone = true;
	if (!player.commanderColorIdentity) player.commanderColorIdentity = [];
	if (!player.commanderColorIdentity.includes(color)) {
		player.commanderColorIdentity.push(color);
	}
}

/**
 * CR 903.4 / 103: Resolves pre-game color choices for commanders with `commanderPreGameColorChoice`.
 * Auto-resolves immediately for bot seats (or when `enqueuePromptFn` is omitted), and enqueues a
 * pre-game `chooseMode` prompt for human seats before Turn 1 begins. Returns `true` iff a human
 * prompt was enqueued and Turn 1 start should wait for its answer.
 */
export function applyCommanderPreGameColorChoices(
	state: GameState,
	enqueuePromptFn?: (state: GameState, prompt: PendingPrompt) => void,
	uidFn?: (prefix: string, state: GameState) => string
): boolean {
	for (const p of state.players) {
		if (p.lost) continue;
		for (const cmd of p.command) {
			if (cmd.commanderPreGameColorDone) continue;
			if (!hasCommanderPreGameColorStatic(cmd.card)) continue;
			if (p.isBot || !enqueuePromptFn || !uidFn) {
				const chosen = chooseBestDeckColorForCommander(p);
				finalizeCommanderPreGameColorChoice(p, cmd, chosen);
				continue;
			}
			enqueuePromptFn(state, {
				id: uidFn('prm', state),
				playerId: p.playerId,
				kind: 'chooseMode',
				purpose: 'etb_choice',
				title: `Choose a Color (${cmd.card.name})`,
				description: `Before the game begins, choose a color for ${cmd.card.name}.`,
				choice: {
					kind: 'chooseMode',
					modes: FIVE_COLORS.map((c) => COLOR_DISPLAY_NAMES[c]),
					min: 1,
					max: 1,
					defaultIndices: [FIVE_COLORS.indexOf(chooseBestDeckColorForCommander(p))]
				},
				cancellable: false,
				continuation: {
					kind: 'handler',
					name: 'commander_pregame_color',
					data: { playerId: p.playerId, commanderInstanceId: cmd.instanceId }
				}
			});
			return true;
		}
	}
	return false;
}

export function matchesChosenCardType(
	types: readonly string[],
	chosenCardType: string | undefined
): boolean {
	if (!chosenCardType) return false;
	const target = chosenCardType.toLowerCase();
	if (target === 'kindred' || target === 'tribal') {
		return types.some((t) => {
			const tl = t.toLowerCase();
			return tl === 'kindred' || tl === 'tribal';
		});
	}
	return types.some((t) => t.toLowerCase() === target);
}

/**
 * CR 702.16j: Returns `true` iff `playerId` currently has protection from a chosen card type
 * (`playerProtectionFromChosenCardType`) that matches `sourcePerm` or `sourceCard`.
 */
export function playerProtectedFromSourceWave8(
	state: GameState,
	playerId: string,
	sourceCard?: ScryfallCard | null,
	sourcePerm?: CardInstance | null
): boolean {
	const mods = activeRuleModifiers(state, 'playerProtectionFromChosenCardType', playerId);
	if (mods.length === 0) return false;
	let srcTypes: string[] | null = null;
	const getSourceTypes = (): string[] => {
		if (srcTypes !== null) return srcTypes;
		if (sourcePerm && sourcePerm.zone === 'battlefield' && !sourcePerm.phasedOut) {
			srcTypes = extractTypesFromTypeLine(evaluatePermanent(state, sourcePerm).typeLine);
			return srcTypes;
		}
		const card = sourceCard ?? (sourcePerm ? effectiveCardForObject(sourcePerm) : null);
		if (!card) {
			srcTypes = [];
			return srcTypes;
		}
		const view = resolveObjectFaces(
			card,
			sourcePerm ? instanceFaceOptions(sourcePerm, sourcePerm.zone) : { zone: 'stack', faceIndex: 0 }
		);
		srcTypes = view.types;
		return srcTypes;
	};

	for (const m of mods) {
		const chosen = m.source.chosenCardType;
		if (!chosen) continue;
		if (matchesChosenCardType(getSourceTypes(), chosen)) return true;
	}
	return false;
}

// ---- 2. Cluster 2: Damage Redirection (CR 614.9), Unpreventable Shields, Cleanup Damage -----

/**
 * CR 614.9 / CR 614.5: Resolves active static damage redirection effects (`staticDamageRedirection`)
 * for damage that would be dealt to `targetPlayerId` or `targetPerm`. Each redirection source can
 * apply at most once to a given damage event (`redirectedByIds`), preventing infinite loops when
 * multiple redirectors are on the battlefield.
 */
export function resolveStaticDamageRedirection(
	state: GameState,
	targetKind: 'player' | 'permanent',
	targetPlayerId: string | undefined,
	targetPerm: CardInstance | undefined,
	redirectedByIds: Set<string>
): CardInstance | null {
	let curKind = targetKind;
	let curPlayerId = targetPlayerId;
	let curPerm = targetPerm;
	let redirected: CardInstance | null = null;

	for (let hop = 0; hop < 16; hop++) {
		let nextRedirect: { destPerm: CardInstance; sourceId: string } | null = null;
		const curPermControllerId =
			curKind === 'permanent' && curPerm ? evaluatePermanent(state, curPerm).controllerId : undefined;

		forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
			if (nextRedirect) return;
			if (st.k !== 'staticDamageRedirection') return;
			if (redirectedByIds.has(srcPerm.instanceId)) return;
			if (
				st.condition &&
				!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
			) {
				return;
			}

			let matchesTarget = false;
			if (curKind === 'player' && curPlayerId === srcControllerId) {
				matchesTarget = true;
			} else if (
				curKind === 'permanent' &&
				curPerm &&
				st.from === 'youAndOtherControlled' &&
				curPermControllerId === srcControllerId
			) {
				matchesTarget = true;
			}
			if (!matchesTarget) return;

			let destPerm: CardInstance | undefined;
			if (st.to === 'self') {
				destPerm = srcPerm;
			} else if (st.to === 'attachedTo' && srcPerm.attachedToId) {
				for (const pl of state.players) {
					if (pl.lost) continue;
					const found = pl.battlefield.find(
						(b) => !b.phasedOut && b.instanceId === srcPerm.attachedToId
					);
					if (found) {
						destPerm = found;
						break;
					}
				}
			}
			if (!destPerm || destPerm.phasedOut) return;
			if (curKind === 'permanent' && curPerm && destPerm.instanceId === curPerm.instanceId) {
				return;
			}
			// CR 614.9 / 120.1a: Damage can only be redirected to a creature, planeswalker, or battle.
			const destEv = evaluatePermanent(state, destPerm);
			const destTypes = extractTypesFromTypeLine(destEv.typeLine);
			if (
				!destEv.isCreature &&
				!destEv.isPlaneswalker &&
				!destTypes.includes('Battle')
			) {
				return;
			}
			nextRedirect = { destPerm, sourceId: srcPerm.instanceId };
		});

		if (!nextRedirect) break;
		const applied: { destPerm: CardInstance; sourceId: string } = nextRedirect;
		redirectedByIds.add(applied.sourceId);
		curKind = 'permanent';
		curPlayerId = undefined;
		curPerm = applied.destPerm;
		redirected = applied.destPerm;
	}

	return redirected;
}

/**
 * CR 614.1a: Checks if damage dealt to `perm` is replaced with putting counters on `perm` instead
 * ("If damage would be dealt to ~, put that many +1/+1 counters on it instead").
 */
export function shouldReplaceDamageWithCountersWave8(
	state: GameState,
	perm: CardInstance
): CounterType | null {
	if (perm.phasedOut || perm.zone !== 'battlefield') return null;
	if (permanentHasLostAllAbilities(perm, state).lost) return null;
	const card = effectiveCardForObject(perm);
	if (!card) return null;
	const ev = evaluatePermanent(state, perm);
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'))) {
		if (ab.kind !== 'replacement' || ab.replacement.replaces.event !== 'damage') continue;
		const w = ab.replacement.with;
		if (Array.isArray(w) || w.k !== 'modify' || !w.damageToSelfAsPlusCounters) continue;
		if (
			ab.replacement.condition &&
			!evaluateCondition(ab.replacement.condition, {
				state,
				controllerId: ev.controllerId,
				source: perm
			})
		) {
			continue;
		}
		return w.damageToSelfAsPlusCounters;
	}
	if (boardMayGrantReplacementAbility(state, 'damage')) {
		for (const rep of collectActiveGrantedReplacementDefs(state, perm)) {
			if (rep.replaces.event !== 'damage') continue;
			const w = rep.with;
			if (Array.isArray(w) || w.k !== 'modify' || !w.damageToSelfAsPlusCounters) continue;
			if (
				rep.condition &&
				!evaluateCondition(rep.condition, {
					state,
					controllerId: ev.controllerId,
					source: perm
				})
			) {
				continue;
			}
			return w.damageToSelfAsPlusCounters;
		}
	}
	return null;
}

export interface UnpreventableDamageSourceContext {
	sourceCard?: ScryfallCard | null;
	sourcePerm?: CardInstance | null;
	sourceControllerId?: string;
}

/**
 * CR 615.12: Evaluates active `unpreventableDamage` statics on the battlefield, supporting
 * combat-only scopes ("Combat damage can't be prevented") and source filters ("Damage that would
 * be dealt by ~ / creatures you control can't be prevented").
 */
export function isDamageUnpreventableWave8(
	state: GameState,
	isCombat: boolean,
	sourceCtx?: UnpreventableDamageSourceContext
): boolean {
	let matched = false;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (matched) return;
		if (st.k !== 'unpreventableDamage') return;
		if (st.combatOnly && !isCombat) return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (!st.sourceFilter) {
			matched = true;
			return;
		}
		if (st.sourceFilter === 'self') {
			if (sourceCtx?.sourcePerm?.instanceId === srcPerm.instanceId) matched = true;
			return;
		}
		if (st.sourceFilter === 'attachedTo') {
			if (srcPerm.attachedToId && sourceCtx?.sourcePerm?.instanceId === srcPerm.attachedToId) {
				matched = true;
			}
			return;
		}
		if (sourceCtx?.sourcePerm && sourceCtx.sourcePerm.zone === 'battlefield') {
			if (
				matchesObjectFilter(sourceCtx.sourcePerm, st.sourceFilter, {
					state,
					controllerId: srcControllerId,
					source: srcPerm
				})
			) {
				matched = true;
			}
			return;
		}
		if (sourceCtx?.sourceCard) {
			const effectiveCtrl = sourceCtx.sourceControllerId ?? '';
			if (st.sourceFilter.controller === 'you' && effectiveCtrl !== srcControllerId) return;
			if (st.sourceFilter.controller === 'opponent' && effectiveCtrl === srcControllerId) return;
			const view = resolveObjectFaces(sourceCtx.sourceCard, { zone: 'stack', faceIndex: 0 });
			if (st.sourceFilter.types && !st.sourceFilter.types.some((t) => view.types.includes(t))) {
				return;
			}
			if (st.sourceFilter.notTypes && st.sourceFilter.notTypes.some((t) => view.types.includes(t))) {
				return;
			}
			matched = true;
		}
	});
	return matched;
}

/**
 * CR 514.2: Returns `true` iff marked damage on `perm` is preserved across cleanup steps.
 */
export function permanentKeepsDamageInCleanupWave8(state: GameState, perm: CardInstance): boolean {
	let keeps = false;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (keeps) return;
		if (st.k !== 'damageNotRemovedInCleanup') return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (st.affected === 'self') {
			if (perm.instanceId === srcPerm.instanceId) keeps = true;
		} else if (st.affected === 'attachedTo') {
			if (srcPerm.attachedToId === perm.instanceId) keeps = true;
		} else if (
			matchesObjectFilter(perm, st.affected, {
				state,
				controllerId: srcControllerId,
				source: srcPerm
			})
		) {
			keeps = true;
		}
	});
	return keeps;
}

// ---- 3. Cluster 3: Counter Locks (CR 122.6) & Zone-Persistent Counters (CR 122.2) -----------

/**
 * CR 122.6: Returns `false` iff an active `cantHaveCounterType` static forbids putting `counterType`
 * counters on `perm`.
 */
export function canPutCounterOnPermanentWave8(
	state: GameState,
	perm: CardInstance,
	counterType: CounterType
): boolean {
	let blocked = false;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (blocked) return;
		if (st.k !== 'cantHaveCounterType') return;
		if (st.counter && st.counter !== counterType) return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (st.affected === 'self') {
			if (perm.instanceId === srcPerm.instanceId) blocked = true;
		} else if (st.affected === 'attachedTo') {
			if (srcPerm.attachedToId === perm.instanceId) blocked = true;
		} else if (
			matchesObjectFilter(perm, st.affected, {
				state,
				controllerId: srcControllerId,
				source: srcPerm
			})
		) {
			blocked = true;
		}
	});
	return !blocked;
}

/**
 * CR 122.6: Filters player counters (`poison`, `experience`, `energy`, `rad`, `ticket`) against
 * active `playerCantGetCounters` rule modifiers.
 */
export function filterPlayerCountersGrantedWave8(
	state: GameState,
	playerId: string,
	counterKind: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket',
	amount: number
): number {
	if (amount <= 0) return 0;
	for (const m of activeRuleModifiers(state, 'playerCantGetCounters', playerId)) {
		const lockedCounter = m.def.params?.counter;
		if (!lockedCounter || lockedCounter === counterKind) return 0;
	}
	return amount;
}

/**
 * CR 122.2: Returns `true` iff `obj` has `countersRemainInNonHiddenZones` ("Counters remain on ~ as
 * it moves to any zone other than a player's hand or library") and did not lose all abilities on the
 * battlefield immediately prior to moving.
 */
export function cardKeepsCountersAcrossZonesWave8(obj: CardInstance, state?: GameState): boolean {
	if (obj.zone === 'battlefield' && state && permanentHasLostAllAbilities(obj, state).lost) {
		return false;
	}
	const card = effectiveCardForObject(obj);
	if (!card) return false;
	for (const ab of activeAbilityDefs(card, instanceFaceOptions(obj, obj.zone))) {
		if (ab.kind === 'static' && ab.static.k === 'countersRemainInNonHiddenZones') {
			return true;
		}
	}
	return false;
}

export function recordCreatureDiedWave8(state: GameState, deadControllerId: string): void {
	for (const p of state.players) {
		p.creaturesDiedCountThisTurn = (p.creaturesDiedCountThisTurn ?? 0) + 1;
		if (p.playerId === deadControllerId) {
			p.controlledCreaturesDiedCountThisTurn = (p.controlledCreaturesDiedCountThisTurn ?? 0) + 1;
		} else {
			p.opponentCreaturesDiedCountThisTurn = (p.opponentCreaturesDiedCountThisTurn ?? 0) + 1;
		}
	}
}

export function recordEnteredBattlefieldWave8(
	state: GameState,
	controllerId: string,
	enteredPerm: CardInstance
): void {
	const p = state.players.find((pl) => pl.playerId === controllerId);
	if (!p) return;
	const snap = effectiveCardForObject(enteredPerm) ?? enteredPerm.card;
	if (!p.enteredBattlefieldCardsThisTurn) p.enteredBattlefieldCardsThisTurn = [];
	p.enteredBattlefieldCardsThisTurn.push(snap);
}

export function resetWave8TurnStateAtTurnStart(
	state: GameState,
	activePlayer: PlayerGameState
): void {
	activePlayer.turnsTakenCount = (activePlayer.turnsTakenCount ?? 0) + 1;
	for (const p of state.players) {
		p.enteredBattlefieldCardsThisTurn = [];
		p.creaturesDiedCountThisTurn = 0;
		p.controlledCreaturesDiedCountThisTurn = 0;
		p.opponentCreaturesDiedCountThisTurn = 0;
		for (const perm of p.battlefield) {
			if (perm.attackedPlayerIdsThisTurn) perm.attackedPlayerIdsThisTurn = undefined;
		}
	}
}

// ---- 4. Cluster 4: Player-Counter Sums, Distinct Names, & Wave 8 Conditions -----------------

export function getPlayerCounterValueWave8(
	p: PlayerGameState,
	counter: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket'
): number {
	if (counter === 'poison') return p.poison ?? 0;
	if (counter === 'experience') return p.experienceCounters ?? 0;
	if (counter === 'energy') return p.energyCounters ?? 0;
	if (counter === 'rad') return p.radCounters ?? 0;
	if (counter === 'ticket') return p.ticketCounters ?? 0;
	return 0;
}

export function evaluatePlayerCountersAmountWave8(
	state: GameState,
	controllerId: string,
	counter: 'poison' | 'experience' | 'energy' | 'rad' | 'ticket',
	playerRefKind: string,
	playersScope?: 'you' | 'opponents' | 'all' | 'defendingPlayer',
	source?: CardInstance,
	defendingPlayerId?: string
): number {
	if (playersScope === 'opponents') {
		let sum = 0;
		for (const p of state.players) {
			if (p.lost || p.playerId === controllerId) continue;
			sum += getPlayerCounterValueWave8(p, counter);
		}
		return sum;
	}
	if (playersScope === 'all') {
		let sum = 0;
		for (const p of state.players) {
			if (p.lost) continue;
			sum += getPlayerCounterValueWave8(p, counter);
		}
		return sum;
	}
	if (playersScope === 'defendingPlayer') {
		let defPid = defendingPlayerId;
		if (!defPid && source && state.combat.active) {
			const atk = state.combat.attackers.find((a) => a.attackerInstanceId === source.instanceId);
			defPid = atk?.defenderPlayerId;
		}
		if (!defPid && state.combat.active && state.combat.attackers.length > 0) {
			defPid = state.combat.attackers[0].defenderPlayerId;
		}
		if (!defPid) return 0;
		const dp = state.players.find((pl) => pl.playerId === defPid);
		return dp ? getPlayerCounterValueWave8(dp, counter) : 0;
	}
	const pid =
		playerRefKind === 'activePlayer'
			? (state.players[state.activePlayerIndex]?.playerId ?? controllerId)
			: controllerId;
	const p = state.players.find((pl) => pl.playerId === pid);
	return p ? getPlayerCounterValueWave8(p, counter) : 0;
}

export function evaluateCreaturesDiedThisTurnWave8(
	state: GameState,
	controllerId: string,
	controllerScope?: 'you' | 'opponent' | 'any'
): number {
	const p = state.players.find((pl) => pl.playerId === controllerId);
	if (!p) return 0;
	if (controllerScope === 'you') return p.controlledCreaturesDiedCountThisTurn ?? 0;
	if (controllerScope === 'opponent') return p.opponentCreaturesDiedCountThisTurn ?? 0;
	return p.creaturesDiedCountThisTurn ?? 0;
}

export function evaluateSpellsCastThisTurnWave8(
	state: GameState,
	controllerId: string,
	filter?: ObjectFilter,
	who?: 'you' | 'activePlayer'
): number {
	const pid =
		who === 'activePlayer'
			? (state.players[state.activePlayerIndex]?.playerId ?? controllerId)
			: controllerId;
	const p = state.players.find((pl) => pl.playerId === pid);
	if (!p) return 0;
	if (!filter) return p.spellsCastThisTurn ?? 0;
	const cards = p.spellsCastThisTurnCards ?? [];
	let count = 0;
	for (const sc of cards) {
		if (matchesCardSnapshotFilterWave8(sc, filter)) count++;
	}
	return count;
}

function matchesCardSnapshotFilterWave8(card: ScryfallCard, filter: ObjectFilter): boolean {
	const view = resolveObjectFaces(card, { zone: 'stack', faceIndex: 0 });
	if (filter.types && filter.types.length > 0) {
		if (!filter.types.some((t) => view.types.includes(t))) return false;
	}
	if (filter.notTypes && filter.notTypes.length > 0) {
		if (filter.notTypes.some((t) => view.types.includes(t))) return false;
	}
	if (filter.supertypes && filter.supertypes.length > 0) {
		if (!filter.supertypes.every((st) => view.supertypes.includes(st))) return false;
	}
	if (filter.subtypes && filter.subtypes.length > 0) {
		if (!filter.subtypes.some((sub) => view.subtypes.includes(sub))) return false;
	}
	if (filter.colors !== undefined) {
		if (filter.colors.length === 0) {
			if (view.colors.length > 0) return false;
		} else if (!filter.colors.some((c) => view.colors.includes(c))) {
			return false;
		}
	}
	if (filter.multicolored && view.colors.length < 2) return false;
	return true;
}

/**
 * CR 201.2: Counts distinct non-empty card names among objects matching `filter`. Face-down
 * objects without a name have no name and are ignored.
 */
export function evaluateDistinctNamesFilterCountWave8(
	state: GameState,
	controllerId: string,
	filter: ObjectFilter,
	source?: CardInstance
): number {
	const zone = filter.zone ?? 'battlefield';
	const names = new Set<string>();
	for (const p of state.players) {
		if (p.lost && zone === 'battlefield') continue;
		const list =
			zone === 'battlefield'
				? p.battlefield
				: zone === 'graveyard'
					? p.graveyard
					: zone === 'exile'
						? p.exile
						: zone === 'hand'
							? p.hand
							: zone === 'command'
								? p.command
								: p.library;
		for (const obj of list) {
			if (zone === 'battlefield' && obj.phasedOut) continue;
			if (obj.isFaceDown) continue;
			if (
				!matchesObjectFilter(
					obj,
					{ ...filter, zone },
					{ state, controllerId, source, zone: zone as CardInstance['zone'] }
				)
			) {
				continue;
			}
			const effCard = effectiveCardForObject(obj);
			const nm = effCard?.name?.trim();
			if (nm) names.add(nm);
		}
	}
	return names.size;
}

export function evaluateWave8Condition(
	cond: Condition,
	state: GameState,
	controllerId: string,
	source?: CardInstance
): boolean | null {
	switch (cond.k) {
		case 'lifeAtLeastAboveStarting': {
			const you = state.players.find((pl) => pl.playerId === controllerId);
			if (!you) return false;
			const starting = state.rules?.startingLife ?? 20;
			return you.life >= starting + cond.delta;
		}
		case 'isAttackingAlone': {
			if (!state.combat.active || state.combat.attackers.length !== 1) return false;
			const targetId =
				cond.of === 'attachedTo' ? source?.attachedToId : source?.instanceId;
			if (!targetId) return false;
			return state.combat.attackers[0].attackerInstanceId === targetId;
		}
		case 'hasntDealtDamageYet': {
			const targetId =
				cond.of === 'attachedTo' ? source?.attachedToId : source?.instanceId;
			if (!targetId) return false;
			if (!cond.of || cond.of === 'self') {
				return !source?.dealtDamageEver;
			}
			for (const p of state.players) {
				if (p.lost) continue;
				const perm = p.battlefield.find((b) => !b.phasedOut && b.instanceId === targetId);
				if (perm) return !perm.dealtDamageEver;
			}
			return false;
		}
		case 'yourTurnsTakenAtLeast': {
			const activePid = state.players[state.activePlayerIndex]?.playerId;
			if (cond.onlyDuringYourTurn && activePid !== controllerId) return true;
			const you = state.players.find((pl) => pl.playerId === controllerId);
			const turns = you?.turnsTakenCount ?? 0;
			return turns >= cond.min;
		}
		case 'enteredBattlefieldUnderYourControlThisTurn': {
			const you = state.players.find((pl) => pl.playerId === controllerId);
			if (!you) return false;
			const entered = you.enteredBattlefieldCardsThisTurn ?? [];
			return entered.some((sc) => matchesCardSnapshotFilterWave8(sc, cond.filter));
		}
		default:
			return null;
	}
}

// ---- 5. Cluster 5: Symmetrical Land Drops, Stax Locks, Combat Rules & Graveyard/Hand Grants -

/**
 * CR 305.2a: Computes total additional land plays available to `actorId` across ALL active
 * `extraLandPlays` rule modifiers on the battlefield (including symmetrical effects controlled by
 * opponents) plus one-shot `extraLandPlaysThisTurn` grants.
 */
export function computeExtraLandPlaysWave8(state: GameState, actorId: string): number {
	const actor = state.players.find((p) => p.playerId === actorId);
	let extra = actor?.extraLandPlaysThisTurn ?? 0;
	for (const m of activeRuleModifiers(state, 'extraLandPlays', actorId)) {
		extra += Number(m.def.params?.count ?? 1);
	}
	return extra;
}

export function checkLandsCantEnterWave8(state: GameState): boolean {
	let locked = false;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (locked) return;
		if (st.k !== 'landsCantEnterBattlefield') return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		locked = true;
	});
	return locked;
}

export function checkLandPlayLocksWave8(state: GameState, actorId: string): string | null {
	const cantPlay = activeRuleModifiers(state, 'cantPlayLands', actorId);
	if (cantPlay.length > 0) {
		return `${cantPlay[0].sourceName} prevents you from playing lands.`;
	}
	if (checkLandsCantEnterWave8(state)) {
		return 'Lands cannot enter the battlefield.';
	}
	return null;
}

export function linkedExileNamesForSourceWave8(state: GameState, source: CardInstance): Set<string> {
	const names = new Set<string>();
	const srcVer = source.objectVersion ?? 1;
	for (const p of state.players) {
		for (const ex of p.exile) {
			if (ex.isFaceDown) continue;
			if (
				ex.exiledBy?.sourceInstanceId === source.instanceId &&
				(ex.exiledBy.sourceObjectVersion ?? 1) === srcVer
			) {
				const nm = (effectiveCardForObject(ex) ?? ex.card)?.name?.trim().toLowerCase();
				if (nm) names.add(nm);
			}
		}
	}
	return names;
}

export function matchesSameNameAsNontokenPermanentWave8(
	state: GameState,
	cardName: string
): boolean {
	const target = cardName.trim().toLowerCase();
	if (!target) return false;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || perm.isToken || perm.isFaceDown) continue;
			const ev = evaluatePermanent(state, perm);
			const nm = ev.effectiveName.trim().toLowerCase();
			if (nm === target) return true;
		}
	}
	return false;
}

export function checkWave8SpellCastLocks(
	state: GameState,
	actorId: string,
	spellCard?: ScryfallCard,
	faceIndex?: number
): string | null {
	if (COMBAT_PHASES.has(state.phase)) {
		const mods = activeRuleModifiers(state, 'cantCastDuringCombat', actorId);
		if (mods.length > 0) {
			return `Illegal Cast: ${mods[0].sourceName} prevents casting spells during combat.`;
		}
	}
	const activePid = state.players[state.activePlayerIndex]?.playerId;
	if (activePid !== actorId) {
		const mods = activeRuleModifiers(state, 'castOnlyDuringOwnTurn', actorId);
		if (mods.length > 0) {
			return `Illegal Cast: ${mods[0].sourceName} allows casting spells only during your own turn.`;
		}
	}
	if (spellCard) {
		const view = resolveObjectFaces(spellCard, { zone: 'stack', faceIndex: faceIndex ?? 0 });
		const spellName = (view.name || spellCard.name || '').trim().toLowerCase();
		if (spellName) {
			for (const m of activeRuleModifiers(state, 'cantCastSameNameAsLinkedExile', actorId)) {
				const exiledNames = linkedExileNamesForSourceWave8(state, m.source);
				if (exiledNames.has(spellName)) {
					return `Illegal Cast: ${m.sourceName} prevents casting spells with the same name as the exiled card.`;
				}
			}
		}
	}
	return null;
}

export function checkWave8AbilityActivationLocks(
	state: GameState,
	actorId: string,
	isManaAbility: boolean
): string | null {
	const activePid = state.players[state.activePlayerIndex]?.playerId;
	if (activePid !== actorId) {
		for (const m of activeRuleModifiers(state, 'activateOnlyDuringOwnTurn', actorId)) {
			if (isManaAbility && m.def.params?.nonManaOnly) continue;
			return `Illegal Activation: ${m.sourceName} allows activating abilities only during your own turn.`;
		}
	}
	return null;
}

export function playerImmuneToOpponentForcedSacrificeWave8(
	state: GameState,
	playerId: string,
	effectControllerId: string | undefined
): boolean {
	if (!effectControllerId || effectControllerId === playerId) return false;
	return activeRuleModifiers(state, 'immuneToOpponentForcedSacrifice', playerId).length > 0;
}

export function playerImmuneToOpponentForcedDiscardWave8(
	state: GameState,
	playerId: string,
	effectControllerId: string | undefined
): boolean {
	if (!effectControllerId || effectControllerId === playerId) return false;
	return activeRuleModifiers(state, 'immuneToOpponentForcedDiscard', playerId).length > 0;
}

function countControlledCreaturesOnBoard(state: GameState, controllerId: string): number {
	let n = 0;
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut) continue;
			const ev = evaluatePermanent(state, perm);
			if (ev.controllerId === controllerId && ev.isCreature) n++;
		}
	}
	return n;
}

export function getWave8AttackRestrictionReason(
	state: GameState,
	attacker: CardInstance,
	attackerControllerId: string,
	defenderPlayerId: string
): string | null {
	let reason: string | null = null;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (reason) return;
		if (st.k !== 'combatRule') return;
		const spec = st.rule;
		if (
			spec.kind !== 'cantAttackAlreadyAttackedPlayerThisTurn' &&
			spec.kind !== 'cantAttackIfDefenderControls' &&
			spec.kind !== 'cantAttackUnlessMoreCreaturesThanDefender'
		) {
			return;
		}
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		const affectsAttacker =
			st.affected === 'self'
				? attacker.instanceId === srcPerm.instanceId
				: st.affected === 'attachedTo'
					? srcPerm.attachedToId === attacker.instanceId
					: matchesObjectFilter(attacker, st.affected, {
							state,
							controllerId: srcControllerId,
							source: srcPerm
						});
		if (!affectsAttacker) return;

		if (spec.kind === 'cantAttackAlreadyAttackedPlayerThisTurn') {
			if (attacker.attackedPlayerIdsThisTurn?.includes(defenderPlayerId)) {
				reason = `${attacker.card.name} cannot attack a player it has already attacked this turn.`;
			}
		} else if (spec.kind === 'cantAttackIfDefenderControls') {
			const hasMatching = state.players.some(
				(pl) =>
					!pl.lost &&
					pl.battlefield.some(
						(perm) =>
							!perm.phasedOut &&
							evaluatePermanent(state, perm).controllerId === defenderPlayerId &&
							matchesObjectFilter(perm, spec.filter, {
								state,
								controllerId: defenderPlayerId,
								source: srcPerm
							})
					)
			);
			if (hasMatching) {
				reason = `${attacker.card.name} cannot attack while defending player controls a matching permanent.`;
			}
		} else if (spec.kind === 'cantAttackUnlessMoreCreaturesThanDefender') {
			const myCreatures = countControlledCreaturesOnBoard(state, attackerControllerId);
			const defCreatures = countControlledCreaturesOnBoard(state, defenderPlayerId);
			if (myCreatures <= defCreatures) {
				reason = `${attacker.card.name} cannot attack unless you control more creatures than defending player.`;
			}
		}
	});
	return reason;
}

export function getWave8BlockerRestrictionReason(
	state: GameState,
	blocker: CardInstance,
	blockerControllerId: string,
	attacker: CardInstance,
	attackerControllerId: string
): string | null {
	let reason: string | null = null;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (reason) return;
		if (st.k !== 'combatRule') return;
		const spec = st.rule;
		if (
			spec.kind !== 'cantBlockIfYouControl' &&
			spec.kind !== 'cantBlockUnlessMoreCreaturesThanAttacker'
		) {
			return;
		}
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		const affectsBlocker =
			st.affected === 'self'
				? blocker.instanceId === srcPerm.instanceId
				: st.affected === 'attachedTo'
					? srcPerm.attachedToId === blocker.instanceId
					: matchesObjectFilter(blocker, st.affected, {
							state,
							controllerId: srcControllerId,
							source: srcPerm
						});
		if (!affectsBlocker) return;

		if (spec.kind === 'cantBlockIfYouControl') {
			const hasMatching = state.players.some(
				(pl) =>
					!pl.lost &&
					pl.battlefield.some(
						(perm) =>
							!perm.phasedOut &&
							evaluatePermanent(state, perm).controllerId === blockerControllerId &&
							matchesObjectFilter(perm, spec.filter, {
								state,
								controllerId: blockerControllerId,
								source: srcPerm
							})
					)
			);
			if (hasMatching) {
				reason = `${blocker.card.name} cannot block while you control a matching permanent.`;
			}
		} else if (spec.kind === 'cantBlockUnlessMoreCreaturesThanAttacker') {
			const myCreatures = countControlledCreaturesOnBoard(state, blockerControllerId);
			const atkCreatures = countControlledCreaturesOnBoard(state, attackerControllerId);
			if (myCreatures <= atkCreatures) {
				reason = `${blocker.card.name} cannot block unless you control more creatures than attacking player.`;
			}
		}
	});
	return reason;
}

/**
 * CR 406.3: Grants peek permission (`knownToPlayerIds`) on face-down cards exiled with permanents
 * having an active `mayLookAtExiledWithSelf` static ability.
 */
export function syncMayLookAtExiledWithSelfPermissionsWave8(state: GameState): void {
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (st.k !== 'mayLookAtExiledWithSelf') return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		const permVer = srcPerm.objectVersion ?? 1;
		for (const ep of state.players) {
			for (const ex of ep.exile) {
				if (
					ex.exiledBy?.sourceInstanceId === srcPerm.instanceId &&
					(ex.exiledBy.sourceObjectVersion ?? 1) === permVer
				) {
					if (!ex.knownToPlayerIds) ex.knownToPlayerIds = [];
					if (!ex.knownToPlayerIds.includes(srcControllerId)) {
						ex.knownToPlayerIds.push(srcControllerId);
					}
				}
			}
		}
	});
}

/**
 * Checks if `card` (at `faceIndex`) has a `selfGraveyardKeywordCast` static permitting it to be
 * cast from its owner's graveyard using its innate `kwName` (`blitz` / `dash` / `bestow` / `mutate` / `warp`).
 */
export function hasSelfGraveyardKeywordCastWave8(
	card: ScryfallCard,
	faceIndex: number,
	kwName: string,
	state?: GameState,
	controllerId?: string,
	inst?: CardInstance
): boolean {
	const normKw = kwName.toLowerCase();
	for (const ab of activeAbilityDefs(card, { zone: 'graveyard', faceIndex })) {
		if (ab.kind !== 'static' || ab.static.k !== 'selfGraveyardKeywordCast') continue;
		if (ab.static.keyword !== normKw) continue;
		if (ab.static.condition && state && controllerId) {
			if (!evaluateCondition(ab.static.condition, { state, controllerId, source: inst })) {
				continue;
			}
		}
		return true;
	}
	return false;
}

/**
 * CR 702.138: Builds granted Escape `CastOption`s for cards in `actor.graveyard` from active
 * `grantGraveyardEscape` statics controlled by `actorId`.
 */
export function collectWave8GraveyardEscapeCastOptions(
	state: GameState,
	actorId: string,
	inst: CardInstance,
	faceIndex: number,
	isMultiFace: boolean,
	requiresTarget: boolean
): CastOption[] {
	if (inst.zone !== 'graveyard' || inst.ownerId !== actorId) return [];
	const card = effectiveCardForObject(inst) ?? inst.card;
	const view = resolveObjectFaces(card, { zone: 'graveyard', faceIndex });
	const faceManaCost = view.manaCost.trim();
	// CR 118.6: A card with no mana cost has an unpayable escape cost equal to its mana cost.
	if (!faceManaCost) return [];
	if (view.types.includes('Land') && !view.types.includes('Creature')) {
		return [];
	}

	const out: CastOption[] = [];
	const seenKeys = new Set<string>();
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (st.k !== 'grantGraveyardEscape') return;
		if (srcControllerId !== actorId) return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (
			!matchesObjectFilter(
				inst,
				{ ...st.filter, zone: 'graveyard' },
				{ state, controllerId: actorId, source: srcPerm, zone: 'graveyard' }
			)
		) {
			return;
		}
		const dedupKey = `${faceManaCost}:${st.exileCount}`;
		if (seenKeys.has(dedupKey)) return;
		seenKeys.add(dedupKey);

		const costDefs: CostDef[] = [
			{
				k: 'exileFrom',
				zone: 'graveyard',
				count: { k: 'const', n: st.exileCount },
				filter: { other: true }
			}
		];
		const idSuffix = `wave8_escape:${srcPerm.instanceId}:${st.exileCount}`;
		out.push({
			id: isMultiFace ? `face${faceIndex}:${idSuffix}` : idSuffix,
			label: isMultiFace ? `Cast with Escape (${view.name})` : 'Cast with Escape',
			costDisplay: `${faceManaCost}, Exile ${st.exileCount} other cards from your graveyard`,
			fromZone: 'graveyard',
			permission: 'keyword_alt',
			...(isMultiFace ? { faceIndex } : {}),
			baseCost: {
				kind: 'alternative',
				manaCost: faceManaCost,
				costDefs
			},
			timing: 'default',
			spellMods: {
				escaped: true,
				castSummarySuffix: ' (Escaped)',
				label: 'Escaped'
			},
			choosesX: faceManaCost.includes('{X}'),
			requiresTarget
		});
	});
	return out;
}

/**
 * CR 702.97 / CR 702.84: Collects granted `scavenge` and `unearth` graveyard activated abilities on
 * `inst` from active `grantGraveyardKeywordAbility` statics controlled by `actor`.
 */
export function collectGrantedGraveyardActivatedAbilitiesWave8(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance
): Array<{
	ability: ActivatedAbility;
	costText: string;
	effectText: string;
	label: string;
	grantSourceCard: ScryfallCard;
	grantSourceName: string;
	abilityId: string;
}> {
	if (inst.zone !== 'graveyard' || inst.ownerId !== actor.playerId) return [];
	const card = effectiveCardForObject(inst) ?? inst.card;
	const view = resolveObjectFaces(card, instanceFaceOptions(inst, 'graveyard'));

	const out: Array<{
		ability: ActivatedAbility;
		costText: string;
		effectText: string;
		label: string;
		grantSourceCard: ScryfallCard;
		grantSourceName: string;
		abilityId: string;
	}> = [];
	const seenIds = new Set<string>();

	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (st.k !== 'grantGraveyardKeywordAbility') return;
		if (srcControllerId !== actor.playerId) return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (
			!matchesObjectFilter(
				inst,
				{ ...st.filter, zone: 'graveyard' },
				{ state, controllerId: actor.playerId, source: srcPerm, zone: 'graveyard' }
			)
		) {
			return;
		}
		const manaCost = (st.costOverride ?? view.manaCost ?? '').trim();
		if (!manaCost) return;

		const abilityId = `wave8_granted:${st.keyword}:${srcPerm.instanceId}`;
		if (seenIds.has(abilityId)) return;
		seenIds.add(abilityId);

		const kwDef: KeywordDef = {
			name: st.keyword,
			cost: manaCost,
			costDefs: [{ k: 'mana', cost: manaCost }]
		};
		const built =
			st.keyword === 'scavenge'
				? buildScavengeAbility(kwDef, abilityId, DUMMY_SPAN)
				: buildUnearthAbility(kwDef, abilityId, DUMMY_SPAN);
		if (!built) return;
		const grantCard = effectiveCardForObject(srcPerm) ?? srcPerm.card;
		out.push({
			...built,
			grantSourceCard: grantCard,
			grantSourceName: grantCard.name,
			abilityId
		});
	});

	return out;
}

export function resolveWave8GrantedActivatedEffects(abilityId: string): {
	steps: EffectStep[];
	targets: TargetSpec[];
	modal?: ModalDef;
	unparsed: [];
} | null {
	const dummyKw: KeywordDef = {
		name: abilityId.startsWith('wave8_granted:scavenge:') ? 'scavenge' : 'unearth',
		cost: '{0}',
		costDefs: [{ k: 'mana', cost: '{0}' }]
	};
	const built = abilityId.startsWith('wave8_granted:scavenge:')
		? buildScavengeAbility(dummyKw, abilityId, DUMMY_SPAN)
		: abilityId.startsWith('wave8_granted:unearth:')
			? buildUnearthAbility(dummyKw, abilityId, DUMMY_SPAN)
			: null;
	if (!built) return null;
	return {
		steps: built.ability.effect,
		targets: built.ability.targets,
		unparsed: []
	};
}

/**
 * Reduces only the generic mana component of `manaCost` by `reduceGeneric` (floored at `0`),
 * preserving all colored, hybrid, Phyrexian, colorless `{C}`, snow `{S}`, and `{X}` symbols.
 * Example: `("{3}{U}{U}", 2) -> "{1}{U}{U}"`, `("{1}{B}", 2) -> "{B}"`, `("{2}", 2) -> "{0}"`.
 */
export function computeGrantedForetellCostWave8(
	manaCost: string | undefined,
	reduceGeneric: number
): string | null {
	const trimmed = manaCost?.trim();
	if (!trimmed) return null;
	const tokens = trimmed.match(/\{[^}]+\}/g);
	if (!tokens || tokens.length === 0) return null;
	parseManaCost(trimmed);

	let genericTotal = 0;
	const otherSymbols: string[] = [];
	for (const tok of tokens) {
		const inner = tok.slice(1, -1).trim();
		if (/^\d+$/.test(inner)) {
			genericTotal += Number(inner);
		} else {
			otherSymbols.push(tok);
		}
	}
	const reducedGeneric = Math.max(0, genericTotal - Math.max(0, reduceGeneric));
	if (otherSymbols.length === 0) {
		return `{${reducedGeneric}}`;
	}
	return reducedGeneric > 0 ? `{${reducedGeneric}}${otherSymbols.join('')}` : otherSymbols.join('');
}

function cardHasInnateForetell(card: ScryfallCard): boolean {
	for (const ab of activeAbilityDefs(card, { zone: 'hand', faceIndex: 0 })) {
		if (ab.kind === 'keyword' && ab.keyword.name.toLowerCase() === 'foretell') {
			return true;
		}
	}
	return false;
}

/**
 * CR 702.143: Returns the granted foretell cost string (e.g. `"{1}{B}"`) if an active
 * `grantHandForetell` static controlled by `actorId` grants foretell to `inst` in hand, or `null`
 * if none applies.
 */
export function getActiveGrantedHandForetellCostWave8(
	state: GameState,
	actorId: string,
	inst: CardInstance
): string | null {
	if (inst.zone !== 'hand') return null;
	const card = effectiveCardForObject(inst) ?? inst.card;
	if (cardHasInnateForetell(card)) return null;
	const view = resolveObjectFaces(card, instanceFaceOptions(inst, 'hand'));
	if (view.types.includes('Land') && !view.types.includes('Creature')) {
		return null;
	}

	let bestCost: string | null = null;
	let bestReduction = -1;
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (st.k !== 'grantHandForetell') return;
		if (srcControllerId !== actorId) return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		if (
			!matchesObjectFilter(
				inst,
				{ ...st.filter, zone: 'hand' },
				{ state, controllerId: actorId, source: srcPerm, zone: 'hand' }
			)
		) {
			return;
		}
		const computed = computeGrantedForetellCostWave8(view.manaCost, st.reduceGeneric);
		if (computed && st.reduceGeneric > bestReduction) {
			bestReduction = st.reduceGeneric;
			bestCost = computed;
		}
	});
	return bestCost;
}

export function buildGrantedHandForetellActionOptionWave8(
	state: GameState,
	actorId: string,
	inst: CardInstance
): HandSpecialActionOption | null {
	const grantedCost = getActiveGrantedHandForetellCostWave8(state, actorId, inst);
	if (!grantedCost) return null;
	return {
		id: 'special:foretell',
		label: 'Foretell {2}',
		costDisplay: '{2}',
		costDefs: [{ k: 'mana', cost: '{2}' }],
		sorcerySpeedOnly: true
	};
}

/**
 * Evaluates dynamic mana ward amount (`dynamicWardMana`) on `perm` across active battlefield statics.
 */
export function getDynamicWardGenericAmountsWave8(
	state: GameState,
	perm: CardInstance
): number[] {
	const out: number[] = [];
	forEachActiveStaticOnBattlefield(state, (srcPerm, srcControllerId, _srcName, st) => {
		if (st.k !== 'dynamicWardMana') return;
		if (
			st.condition &&
			!evaluateCondition(st.condition, { state, controllerId: srcControllerId, source: srcPerm })
		) {
			return;
		}
		const matches =
			st.affected === 'self'
				? perm.instanceId === srcPerm.instanceId
				: st.affected === 'attachedTo'
					? srcPerm.attachedToId === perm.instanceId
					: matchesObjectFilter(perm, st.affected, {
							state,
							controllerId: srcControllerId,
							source: srcPerm
						});
		if (!matches) return;
		const val = evaluateAmount(st.generic, {
			state,
			controllerId: srcControllerId,
			source: srcPerm
		});
		if (val !== null && val > 0) out.push(val);
	});
	return out;
}
