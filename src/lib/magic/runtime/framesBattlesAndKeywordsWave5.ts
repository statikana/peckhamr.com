/**
 * Runtime helpers, frame mechanics, cast-cost generalizations, state-based actions,
 * and resolution handlers for Wave 5 (Track P15):
 *
 * - P15.1 Card Frames, Multi-Part Layouts, Loyalty ±X, & Activation/Cast Riders:
 *   - Battles & Sieges (CR 310.1–12, CR 120.3h, CR 704.5p,v–y)
 *   - Rooms door-unlock & Eerie triggers (CR 709.5a–j)
 *   - Preparation cards & prepared designation (CR 723.1–5)
 *   - Omen cards (CR 721.1–5)
 *   - Compleated (CR 702.150a) & ±X loyalty abilities (CR 606.4)
 *   - Activation riders (beforeAttackers, oncePerGame, activatorWho, P15 conditions)
 *
 * - P15.2 Game-State Keywords & Read Ahead:
 *   - Daybound & Nightbound / Day & Night (CR 702.145, CR 732)
 *   - Start your engines! & Max speed (CR 702.178–179, CR 704.5aa)
 *   - Ascend & City's blessing (CR 702.131)
 *   - Read ahead (CR 702.155)
 *
 * - P15.3 & P15.4 CR 702 Keywords:
 *   Power-up (702.193), Gift (702.174), Splice (702.47), Cleave (702.148),
 *   Craft (702.167), Reconfigure (702.151), Job select (702.182), Freerunning (702.173),
 *   Impending (702.176), Assist (702.132), Cipher (702.99), Increment (702.191),
 *   Provoke (702.39), Ripple (702.60), Ravenous (702.156), Paradigm (702.192),
 *   Amplify (702.38), Demonstrate (702.144), Prowl (702.76), Gravestorm (702.69),
 *   Living metal (702.161), More than meets the eye (702.162),
 *   Snow/Legendary/Artifact landwalk (702.14), Transfigure (702.71), Aura swap (702.65).
 *
 * Pure IR and GameState metadata only — zero card-name literal comparisons and zero runtime rules-text reads.
 */
import { compileCard } from '../compiler/index.ts';
import { staticallyInterpretable } from '../compiler/interpretable.ts';
import type { RuntimeTrigger } from '../compiler/triggers.ts';
import type {
	AbilityDef,
	Amount,
	Condition,
	CopyModificationSpec,
	CostDef,
	EffectStep,
	KeywordDef,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	Selector,
	SpellAbility,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import { parseManaCost, withStackItemText, type ManaCostRequirement } from '../oracle.ts';
import { effectiveCardForObject, getCardFaces, makeInherentAbilityCard } from '../scryfall.ts';
import {
	createEmptyCounterMap,
	type CardInstance,
	type CastCostAid,
	type CastOption,
	type CastOptionOptionalCost,
	type CounterType,
	type GameState,
	type ManaColor,
	type PlayerGameState,
	type ScryfallCard,
	type SpellModifications,
	type StackItem,
	type TargetRef
} from '../types.ts';
import { enqueueChoicePrompt, registerPromptHandler } from './choices.ts';
import {
	effectiveSpellManaCost,
	spellAdditionalCost,
	spellChoosesX,
	spellOptionalAdditionalCosts,
	type CostContext
} from './costs.ts';
// --- Track P16b ---
import { emitEvent } from './events.ts';
// --- End Track P16b ---
import {
	activeAbilityDefs,
	activeCharacteristics,
	activeFaceDefs,
	effectiveManaValue,
	instanceFaceOptions,
	resolveObjectFaces,
	stackItemFaceOptions
} from './faces.ts';
import { noteLayerInputsChanged } from './layerCache.ts';
import { evaluatePermanent, splitSubtypes, type EvaluatedPermanent } from './layers.ts';
import { matchesObjectFilter, type FilterContext } from './objectFilter.ts';
import { enqueuePendingTrigger, peekPendingTriggers } from './triggers.ts';
import { moveObject } from './zones.ts';

export interface Wave5RuntimeTrigger extends RuntimeTrigger {
	wave5Tag?: string;
	wave5N?: number;
	wave5CostText?: string;
	wave5Card?: ScryfallCard;
}

export interface Wave5FinalizeCastOptions {
	targets: TargetRef[];
	targetsBySpec?: TargetRef[][];
	chosenModes?: number[];
	xValue: number;
	castOptionId?: string;
	faceIndex?: number;
	fused?: boolean;
	spellMods?: SpellModifications;
	descriptions?: string[];
}

export interface Wave5Host {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	emitEvent: typeof emitEvent;
	flushTriggers: (state: GameState) => void;
	canPayOrAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState,
		phyrexianLifeCount?: number,
		reservedObjectIds?: ReadonlySet<string>
	) => boolean;
	payManaWithAutoTap: (
		player: PlayerGameState,
		req: ManaCostRequirement,
		state: GameState,
		phyrexianLifeCount?: number,
		reservedObjectIds?: ReadonlySet<string>
	) => boolean;
	costContext: (
		state: GameState,
		player: PlayerGameState,
		source: CardInstance,
		xValue: number,
		isSpell: boolean,
		baseMana: ManaCostRequirement | null
	) => CostContext;
	createTokens: (
		state: GameState,
		controller: PlayerGameState,
		spec: TokenSpec,
		count: number,
		sourceName: string
	) => CardInstance[];
	copyPermanentAsToken: (
		state: GameState,
		controller: PlayerGameState,
		original: CardInstance,
		sourceName: string,
		notLegendary?: boolean,
		exceptPT?: { power: number; toughness: number },
		copyMod?: CopyModificationSpec,
		copyOpts?: { tapped?: boolean; tappedAndAttacking?: boolean }
	) => CardInstance;
	copyStackSpell: (
		state: GameState,
		original: StackItem,
		controller: PlayerGameState,
		mayChooseNewTargets?: boolean
	) => StackItem | null;
	addCountersToPermanent: (
		state: GameState,
		perm: CardInstance,
		counterType: CounterType,
		amount: number
	) => number;
	tapPermanent: (state: GameState, perm: CardInstance) => void;
	untapPermanent: (state: GameState, perm: CardInstance) => void;
	finalizeCastSpell: (
		state: GameState,
		actor: PlayerGameState,
		inst: CardInstance,
		sourcePlayer: PlayerGameState,
		sourceZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield',
		opts: Wave5FinalizeCastOptions
	) => void;
	resumeStackItem: (state: GameState, stackItemId: string) => void;
	drawCards: (state: GameState, player: PlayerGameState, count: number) => void;
	markHandCardRevealedToAll: (state: GameState, card: CardInstance) => void;
	shuffleLibrary: (state: GameState, player: PlayerGameState) => void;
	transformPermanentRaw: (state: GameState, perm: CardInstance) => boolean;
	moveStackSpellToZone: (
		state: GameState,
		stackItem: StackItem,
		dest: 'graveyard' | 'exile' | 'hand' | 'library'
	) => void;
}

function keywordNameOf(kw: KeywordDef): string {
	return kw.name.toLowerCase();
}

function cardNameOf(card: ScryfallCard): string {
	return card.name;
}

let hostRef: Wave5Host | null = null;

export function registerWave5Host(host: Wave5Host): void {
	hostRef = host;
}

function getHost(): Wave5Host {
	if (!hostRef) {
		throw new Error('Wave5Host not registered');
	}
	return hostRef;
}

const NON_CREATURE_SUBTYPES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Desert',
	'Gate',
	'Lair',
	'Locus',
	'Mine',
	'Power-Plant',
	'Sphere',
	'Tower',
	'Urza’s',
	"Urza's",
	'Cave',
	'Equipment',
	'Aura',
	'Saga',
	'Class',
	'Case',
	'Room',
	'Background',
	'Cartouche',
	'Curse',
	'Role',
	'Rune',
	'Shard',
	'Shrine',
	'Vehicle',
	'Clue',
	'Food',
	'Gold',
	'Incubator',
	'Junk',
	'Map',
	'Powerstone',
	'Treasure',
	'Blood',
	'Contraption',
	'Fortification',
	'Spacecraft',
	'Siege',
	'Arcane',
	'Adventure',
	'Lesson',
	'Omen',
	'Trap',
	'Chorus'
]);

function evalHasKeyword(ev: EvaluatedPermanent, kwLower: string): boolean {
	return ev.breakdown.items.some(
		(it) => !it.removed && it.kind === 'keyword' && it.canonicalKey === kwLower
	);
}

function evalGrantCount(ev: EvaluatedPermanent, kwLower: string): number {
	let count = 0;
	for (const it of ev.breakdown.items) {
		if (!it.removed && it.kind === 'keyword' && it.canonicalKey === kwLower && !it.isInnate) {
			count += it.grantCount ?? 1;
		}
	}
	return count;
}

function evalSubtypes(ev: EvaluatedPermanent): string[] {
	const dashIdx = ev.effectiveTypeLine.indexOf('—');
	if (dashIdx === -1) return [];
	return splitSubtypes(ev.effectiveTypeLine.slice(dashIdx + 1).trim());
}

function extractCreatureSubtypesForObject(state: GameState, obj: CardInstance): {
	allCreatureTypes: boolean;
	subtypes: string[];
} {
	if (obj.zone === 'battlefield') {
		const ev = evaluatePermanent(state, obj);
		if (ev.hasAllCreatureTypes || evalHasKeyword(ev, 'changeling')) {
			return { allCreatureTypes: true, subtypes: [] };
		}
		if (
			!ev.isCreature &&
			!/\bKindred\b/i.test(ev.effectiveTypeLine) &&
			!/\bTribal\b/i.test(ev.effectiveTypeLine)
		) {
			return { allCreatureTypes: false, subtypes: [] };
		}
		return {
			allCreatureTypes: false,
			subtypes: evalSubtypes(ev).filter((st) => !NON_CREATURE_SUBTYPES.has(st))
		};
	}
	const card = effectiveCardForObject(obj);
	const faceOpts = instanceFaceOptions(obj);
	const resolved = resolveObjectFaces(card, faceOpts);
	const abilities = activeAbilityDefs(card, faceOpts);
	const hasChangeling = abilities.some(
		(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'changeling'
	);
	const isCreatureish =
		resolved.types.includes('Creature') ||
		resolved.types.includes('Kindred') ||
		resolved.types.includes('Tribal');
	if (!isCreatureish) return { allCreatureTypes: false, subtypes: [] };
	if (hasChangeling) return { allCreatureTypes: true, subtypes: [] };
	return {
		allCreatureTypes: false,
		subtypes: resolved.subtypes.filter((st) => !NON_CREATURE_SUBTYPES.has(st))
	};
}

export function objectsShareCreatureSubtype(
	state: GameState,
	a: CardInstance,
	b: CardInstance
): boolean {
	const sa = extractCreatureSubtypesForObject(state, a);
	const sb = extractCreatureSubtypesForObject(state, b);
	if (sa.allCreatureTypes && (sb.allCreatureTypes || sb.subtypes.length > 0)) return true;
	if (sb.allCreatureTypes && (sa.allCreatureTypes || sa.subtypes.length > 0)) return true;
	if (sa.subtypes.length === 0 || sb.subtypes.length === 0) return false;
	const setB = new Set(sb.subtypes.map((s) => s.toLowerCase()));
	return sa.subtypes.some((s) => setB.has(s.toLowerCase()));
}

// ============================================================================
// P15 Static Interpretability & Shared Filter / Amount / Condition Helpers
// ============================================================================

function normalizeFilterForCheck(f: ObjectFilter): ObjectFilter {
	const { isPrepared: _p, sharesCreatureTypeWithSelf: _s, anyOf, ...rest } = f;
	return {
		...rest,
		...(anyOf ? { anyOf: anyOf.map(normalizeFilterForCheck) } : {})
	};
}

function normalizeAmountForCheck(a: Amount): Amount {
	if (a.k === 'playerSpeed' || a.k === 'gravestormCount') return { k: 'const', n: 1 };
	if (a.k === 'count') return { k: 'count', of: normalizeFilterForCheck(a.of) };
	if (a.k === 'mul') return { ...a, of: normalizeAmountForCheck(a.of) };
	if (a.k === 'negate') return { k: 'negate', of: normalizeAmountForCheck(a.of) };
	if (a.k === 'sum' || a.k === 'min' || a.k === 'max') {
		return { k: a.k, args: a.args.map(normalizeAmountForCheck) };
	}
	return a;
}

function normalizeConditionForCheck(c: Condition): Condition {
	switch (c.k) {
		case 'maxSpeed':
		case 'citysBlessing':
		case 'giftPromised':
		case 'isDay':
		case 'isNight':
		case 'isYourTurn':
		case 'selfPrepared':
		case 'isImpending':
		case 'enteredWithXAtLeast':
			return { k: 'evoked' };
		case 'not':
			return { k: 'not', of: normalizeConditionForCheck(c.of) };
		case 'and':
		case 'or':
			return { k: c.k, of: c.of.map(normalizeConditionForCheck) };
		case 'compare':
			return {
				...c,
				left: normalizeAmountForCheck(c.left),
				right: normalizeAmountForCheck(c.right)
			};
		case 'matchesFilter':
			return { ...c, filter: normalizeFilterForCheck(c.filter) };
		case 'objectState':
			return {
				...c,
				...(c.filter ? { filter: normalizeFilterForCheck(c.filter) } : {})
			};
		default:
			return c;
	}
}

function normalizeSelectorForCheck(sel: Selector): Selector {
	if (sel.k === 'all') return { k: 'all', filter: normalizeFilterForCheck(sel.filter) };
	return sel;
}

function normalizeStepForCheck(step: EffectStep): EffectStep {
	let verb = step.verb;
	let subject = normalizeSelectorForCheck(step.subject);
	let amount = step.amount ? normalizeAmountForCheck(step.amount) : undefined;
	if (verb === 'prepare' || verb === 'unprepare') {
		verb = 'suspect';
	} else if (verb === 'increaseSpeed') {
		verb = 'gainEnergy';
		subject = { k: 'playerRef', ref: { k: 'you' } };
		amount = { k: 'const', n: 1 };
	}
	return {
		...step,
		verb,
		subject,
		...(amount ? { amount } : {}),
		...(step.condition ? { condition: normalizeConditionForCheck(step.condition) } : {}),
		...(step.delayed
			? {
					delayed: {
						...step.delayed,
						effect: step.delayed.effect.map(normalizeStepForCheck)
					}
				}
			: {}),
		...(step.params
			? {
					params: {
						...step.params,
						...(step.params.toughness
							? { toughness: normalizeAmountForCheck(step.params.toughness) }
							: {}),
						...(step.params.count ? { count: normalizeAmountForCheck(step.params.count) } : {}),
						...(step.params.setPower
							? { setPower: normalizeAmountForCheck(step.params.setPower) }
							: {}),
						...(step.params.setToughness
							? { setToughness: normalizeAmountForCheck(step.params.setToughness) }
							: {}),
						...(step.params.condition
							? { condition: normalizeConditionForCheck(step.params.condition) }
							: {}),
						...(step.params.winFlipEffect
							? { winFlipEffect: step.params.winFlipEffect.map(normalizeStepForCheck) }
							: {}),
						...(step.params.loseFlipEffect
							? { loseFlipEffect: step.params.loseFlipEffect.map(normalizeStepForCheck) }
							: {}),
						...(step.params.reflexiveTrigger
							? {
									reflexiveTrigger: {
										...step.params.reflexiveTrigger,
										targets: step.params.reflexiveTrigger.targets.map((t) => ({
											...t,
											filter: normalizeFilterForCheck(t.filter),
											...(t.condition
												? { condition: normalizeConditionForCheck(t.condition) }
												: {})
										})),
										effect: step.params.reflexiveTrigger.effect.map(normalizeStepForCheck)
									}
								}
							: {})
					}
				}
			: {})
	};
}

export function staticallyInterpretableP15(
	parse: {
		steps: readonly EffectStep[];
		targets: readonly TargetSpec[];
		unparsed: readonly unknown[];
		modal?: ModalDef;
	},
	isTriggered = false
): boolean {
	return staticallyInterpretable(
		{
			steps: parse.steps.map(normalizeStepForCheck),
			targets: parse.targets.map((t) => ({
				...t,
				filter: normalizeFilterForCheck(t.filter),
				...(t.condition ? { condition: normalizeConditionForCheck(t.condition) } : {}),
				...(t.divideTotal ? { divideTotal: normalizeAmountForCheck(t.divideTotal) } : {})
			})),
			unparsed: [...parse.unparsed],
			...(parse.modal
				? {
						modal: {
							...parse.modal,
							...(parse.modal.conditionalChooseAll
								? {
										conditionalChooseAll: normalizeConditionForCheck(
											parse.modal.conditionalChooseAll
										)
									}
								: {}),
							modes: parse.modal.modes.map((m) => ({
								...m,
								targets: m.targets.map((t) => ({
									...t,
									filter: normalizeFilterForCheck(t.filter),
									...(t.condition ? { condition: normalizeConditionForCheck(t.condition) } : {})
								})),
								effect: m.effect.map(normalizeStepForCheck)
							}))
						}
					}
				: {})
		},
		isTriggered
	);
}

export function matchesP15ObjectFilter(
	filter: ObjectFilter,
	candidate: CardInstance,
	ctx: FilterContext
): boolean {
	if (filter.isPrepared !== undefined) {
		if (candidate.zone !== 'battlefield') return false;
		if (Boolean(candidate.isPrepared) !== filter.isPrepared) return false;
	}
	if (filter.sharesCreatureTypeWithSelf) {
		if (!ctx.source) return false;
		if (!objectsShareCreatureSubtype(ctx.state, ctx.source, candidate)) return false;
	}
	return true;
}

export function evaluateP15Amount(
	amount: Amount,
	state: GameState,
	controllerId: string,
	opts?: {
		resolvePlayer?: (ref: PlayerRef) => PlayerGameState | undefined;
		gravestormOverride?: number;
	}
): number | null {
	if (amount.k === 'playerSpeed') {
		let p: PlayerGameState | undefined;
		if (opts?.resolvePlayer) {
			p = opts.resolvePlayer(amount.player);
		} else if (amount.player.k === 'you') {
			p = state.players.find((pl) => pl.playerId === controllerId);
		} else if (amount.player.k === 'activePlayer') {
			p = state.players[state.activePlayerIndex];
		}
		return p?.speed ?? 0;
	}
	if (amount.k === 'gravestormCount') {
		return (
			opts?.gravestormOverride ?? (state.permanentsPutIntoGraveyardFromBattlefieldThisTurn ?? 0)
		);
	}
	return null;
}

export function evaluateP15Condition(
	cond: Condition,
	state: GameState,
	controllerId: string,
	opts?: {
		source?: CardInstance;
		giftPromised?: boolean;
		enteredWithX?: number;
		castWithImpending?: boolean;
	}
): boolean | null {
	switch (cond.k) {
		case 'maxSpeed': {
			const player = state.players.find((p) => p.playerId === controllerId);
			return (player?.speed ?? 0) >= 4;
		}
		case 'citysBlessing': {
			const player = state.players.find((p) => p.playerId === controllerId);
			return Boolean(player?.hasCitysBlessing);
		}
		case 'giftPromised':
			return Boolean(opts?.giftPromised ?? opts?.source?.giftPromised);
		case 'isDay':
			return state.dayNight === 'day';
		case 'isNight':
			return state.dayNight === 'night';
		case 'isYourTurn':
			return state.players[state.activePlayerIndex]?.playerId === controllerId;
		case 'selfPrepared':
			return Boolean(opts?.source?.isPrepared);
		case 'isImpending': {
			const imp = opts?.castWithImpending ?? opts?.source?.castWithImpending;
			return Boolean(imp) && (opts?.source?.counters.time ?? 0) > 0;
		}
		case 'enteredWithXAtLeast':
			return (opts?.enteredWithX ?? opts?.source?.enteredWithX ?? 0) >= cond.n;
		default:
			return null;
	}
}

// ============================================================================
// P15.1 Preparation Helpers (CR 723)
// ============================================================================

export function permanentHasPrepareSpell(perm: CardInstance): boolean {
	const card = effectiveCardForObject(perm);
	const layout = card.layout ?? 'normal';
	if (layout !== 'prepare') return false;
	return getCardFaces(card).length >= 2;
}

export function setPermanentPrepared(
	state: GameState,
	perm: CardInstance,
	prepared: boolean
): boolean {
	if (perm.zone !== 'battlefield') return false;
	if (prepared) {
		// CR 723.3a: Only permanents with a prepare spell that are not already prepared can become prepared.
		if (!permanentHasPrepareSpell(perm) || perm.isPrepared) return false;
		perm.isPrepared = true;
		noteLayerInputsChanged(state);
		return true;
	}
	if (!perm.isPrepared) return false;
	perm.isPrepared = false;
	noteLayerInputsChanged(state);
	return true;
}

// ============================================================================
// P15.1 Battles & Sieges (CR 310, CR 120.3h, CR 704.5p,v–y)
// ============================================================================

export function isPermanentBattle(state: GameState, perm: CardInstance): boolean {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return false;
	return /\bBattle\b/.test(evaluatePermanent(state, perm).effectiveTypeLine);
}

export function isPermanentSiege(state: GameState, perm: CardInstance): boolean {
	if (!isPermanentBattle(state, perm)) return false;
	return evaluatePermanent(state, perm).hasSubType('Siege');
}

export function printedBattleDefense(perm: CardInstance): number {
	const card = effectiveCardForObject(perm);
	return activeCharacteristics(card, instanceFaceOptions(perm)).defense ?? 0;
}

export function legalProtectorsForBattle(
	state: GameState,
	battle: CardInstance,
	isSiege: boolean
): PlayerGameState[] {
	if (isSiege) {
		return state.players.filter((p) => !p.lost && p.playerId !== battle.controllerId);
	}
	return state.players.filter((p) => !p.lost);
}

export function assignBattleProtectorOnEtb(state: GameState, perm: CardInstance): boolean {
	if (!isPermanentBattle(state, perm)) return false;
	if (perm.siegeProtectorChosen) return false;
	const isSiege = isPermanentSiege(state, perm);
	const candidates = legalProtectorsForBattle(state, perm, isSiege);
	perm.siegeProtectorChosen = true;
	if (candidates.length === 0) {
		perm.protectorId = null;
		return false;
	}
	if (candidates.length === 1) {
		perm.protectorId = candidates[0].playerId;
		return false;
	}
	const ctrl = state.players.find((p) => p.playerId === perm.controllerId);
	if (!ctrl || ctrl.isBot) {
		const sorted = [...candidates].sort((a, b) => a.life - b.life || a.seatIndex - b.seatIndex);
		perm.protectorId = sorted[0].playerId;
		return false;
	}
	perm.protectorId = candidates[0].playerId;
	const host = getHost();
	enqueueChoicePrompt(state, {
		id: host.uid('prm', state),
		playerId: ctrl.playerId,
		kind: 'chooseMode',
		title: `${perm.card.name} — Choose a protector`,
		description: `Choose an opponent to protect ${perm.card.name}.`,
		purpose: 'etb_choice',
		choice: {
			kind: 'chooseMode',
			modes: candidates.map((c) => `${c.username} (${c.life} life)`),
			min: 1,
			max: 1,
			defaultIndices: [0]
		},
		continuation: {
			kind: 'handler',
			name: 'p15_siege_protector_choice',
			data: {
				battleId: perm.instanceId,
				battleVersion: perm.objectVersion || 1,
				candidatePlayerIds: candidates.map((c) => c.playerId)
			}
		}
	});
	return true;
}

function enqueueWave5StackOrPendingTrigger(
	state: GameState,
	opts: {
		source: CardInstance;
		sourceCard?: ScryfallCard;
		controllerId: string;
		label: string;
		wave5Tag: string;
		wave5N?: number;
		wave5CostText?: string;
		wave5Card?: ScryfallCard;
		defendingPlayerId?: string;
		targets?: TargetSpec[];
		giftKind?: StackItem['giftKind'];
		giftRecipientId?: string;
	}
): void {
	const card = opts.sourceCard ?? effectiveCardForObject(opts.source);
	const rt: Wave5RuntimeTrigger = {
		abilityIndex: -1,
		trigger: { event: 'zoneChange', filter: {} },
		effectSupported: true,
		text: opts.label,
		effect: {
			steps: [],
			targets: opts.targets ?? [],
			unparsed: []
		},
		wave5Tag: opts.wave5Tag,
		wave5N: opts.wave5N,
		wave5CostText: opts.wave5CostText,
		wave5Card: opts.wave5Card
	};
	enqueuePendingTrigger(state, {
		ability: rt,
		source: opts.source,
		sourceCard: card,
		controllerId: opts.controllerId,
		mode: 'stack',
		label: opts.label,
		defendingPlayerId: opts.defendingPlayerId,
		wave5Tag: opts.wave5Tag,
		wave5N: opts.wave5N,
		wave5CostText: opts.wave5CostText,
		wave5Card: opts.wave5Card,
		giftKind: opts.giftKind,
		giftRecipientId: opts.giftRecipientId
	});
}

export function onBattleDefenseCountersRemoved(
	state: GameState,
	perm: CardInstance,
	previousDefense: number,
	newDefense: number
): void {
	if (previousDefense <= 0 || newDefense > 0) return;
	if (perm.zone !== 'battlefield') return;
	if (!isPermanentSiege(state, perm)) return;
	const key = `${perm.instanceId}:${perm.objectVersion || 1}`;
	state.siegeZeroDefenseTriggeredKeys ??= [];
	if (!state.siegeZeroDefenseTriggeredKeys.includes(key)) {
		state.siegeZeroDefenseTriggeredKeys.push(key);
	}
	enqueueWave5StackOrPendingTrigger(state, {
		source: perm,
		controllerId: perm.controllerId,
		label: `${perm.card.name} — Siege defeated`,
		wave5Tag: 'siege_defeated'
	});
}

export function hasActiveSiegeDefeatTrigger(state: GameState, perm: CardInstance): boolean {
	const ver = perm.objectVersion || 1;
	const onStack = state.stack.some(
		(s) =>
			s.wave5Tag === 'siege_defeated' &&
			s.sourceInstanceId === perm.instanceId &&
			(s.sourceObjectVersion || 1) === ver
	);
	if (onStack) return true;
	const inPending = peekPendingTriggers(state).some(
		(pt) =>
			pt.wave5Tag === 'siege_defeated' &&
			pt.source.instanceId === perm.instanceId &&
			(pt.source.objectVersion || 1) === ver
	);
	return inPending;
}

export function checkBattleStateBasedActions(state: GameState): boolean {
	const host = getHost();
	let acted = false;
	for (const p of state.players) {
		const snapshot = [...p.battlefield];
		for (const perm of snapshot) {
			if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
			if (!isPermanentBattle(state, perm)) continue;

			// CR 704.5p: If a battle is attached to an object or player, it becomes unattached.
			if (perm.attachedToId !== null) {
				perm.attachedToId = null;
				noteLayerInputsChanged(state);
				acted = true;
			}

			const isSiege = isPermanentSiege(state, perm);
			const defCount = perm.counters.defense || 0;

			// CR 704.5v / CR 704.5w: 0 defense counters SBA.
			if (defCount === 0) {
				if (isSiege) {
					if (!hasActiveSiegeDefeatTrigger(state, perm)) {
						host.addLog(
							state,
							'sba',
							`${perm.card.name} has 0 defense counters and is put into its owner's graveyard.`,
							perm.controllerId
						);
						moveObject(state, perm, 'graveyard', {
							from: { player: p, zone: 'battlefield' },
							bumpVersion: true,
							leaveBattlefieldReset: true,
							detachAttachments: true,
							graveyardReplacement: true,
							commanderRedirect: true,
							ceaseToExist: 'tokens'
						});
						acted = true;
						continue;
					}
				} else {
					host.addLog(
						state,
						'sba',
						`${perm.card.name} has 0 defense counters and is put into its owner's graveyard.`,
						perm.controllerId
					);
					moveObject(state, perm, 'graveyard', {
						from: { player: p, zone: 'battlefield' },
						bumpVersion: true,
						leaveBattlefieldReset: true,
						detachAttachments: true,
						graveyardReplacement: true,
						commanderRedirect: true,
						ceaseToExist: 'tokens'
					});
					acted = true;
					continue;
				}
			}

			// CR 704.5x–y: Protector designation SBA.
			const beingAttacked =
				state.combat.active &&
				state.combat.attackers.some((a) => a.defenderBattleId === perm.instanceId);
			const currentProtector = perm.protectorId
				? state.players.find((pl) => pl.playerId === perm.protectorId && !pl.lost)
				: undefined;
			const illegalSelfProtector =
				isSiege && perm.protectorId === perm.controllerId && !beingAttacked;
			if (!currentProtector || illegalSelfProtector) {
				const candidates = legalProtectorsForBattle(state, perm, isSiege);
				if (candidates.length === 0) {
					host.addLog(
						state,
						'sba',
						`${perm.card.name} has no legal protector and is put into its owner's graveyard.`,
						perm.controllerId
					);
					moveObject(state, perm, 'graveyard', {
						from: { player: p, zone: 'battlefield' },
						bumpVersion: true,
						leaveBattlefieldReset: true,
						detachAttachments: true,
						graveyardReplacement: true,
						commanderRedirect: true,
						ceaseToExist: 'tokens'
					});
					acted = true;
					continue;
				}
				perm.protectorId = candidates[0].playerId;
				acted = true;
			}
		}
	}
	return acted;
}

// ============================================================================
// P15.2 Daybound / Nightbound (CR 702.145, CR 732), Speed (CR 702.179), Ascend (CR 702.131)
// ============================================================================

function faceHasInnateKeyword(card: ScryfallCard, faceIndex: number, kwName: string): boolean {
	const compiled = compileCard(card);
	const face = compiled.faces[faceIndex] ?? compiled.faces[0];
	if (!face) return false;
	return face.abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === kwName);
}

export function permanentDayNightKeywords(
	state: GameState,
	perm: CardInstance
): { daybound: boolean; nightbound: boolean } {
	if (perm.zone !== 'battlefield' || perm.phasedOut || perm.isFaceDown) {
		return { daybound: false, nightbound: false };
	}
	const ev = evaluatePermanent(state, perm);
	return {
		daybound: evalHasKeyword(ev, 'daybound'),
		nightbound: evalHasKeyword(ev, 'nightbound')
	};
}

export function canExternalEffectTransform(state: GameState, perm: CardInstance): boolean {
	const { daybound, nightbound } = permanentDayNightKeywords(state, perm);
	// CR 702.145c,f: Any permanent with daybound or nightbound can't be transformed by anything other than daybound/nightbound.
	return !daybound && !nightbound;
}

export function applyDayboundEtbReplacement(state: GameState, perm: CardInstance): void {
	// CR 702.145b: If it is night and a double-faced card with daybound enters without being transformed, it enters transformed.
	if (state.dayNight !== 'night') return;
	if (perm.transformed || perm.isFaceDown) return;
	const card = effectiveCardForObject(perm);
	const layout = card.layout ?? (card.backFace ? 'transform' : 'normal');
	if (layout !== 'transform') return;
	if (getCardFaces(card).length < 2) return;
	if (faceHasInnateKeyword(card, 0, 'daybound')) {
		perm.transformed = true;
		perm.activeFaceIndex = 1;
	}
}

export function syncDayboundNightboundPermanents(state: GameState): boolean {
	if (!state.dayNight) return false;
	const host = getHost();
	let changed = false;
	for (const p of state.players) {
		for (const perm of p.battlefield) {
			if (perm.zone !== 'battlefield' || perm.phasedOut || perm.isFaceDown) continue;
			const card = effectiveCardForObject(perm);
			const layout = card.layout ?? (card.backFace ? 'transform' : 'normal');
			if (layout !== 'transform' || getCardFaces(card).length < 2) continue;
			const { daybound, nightbound } = permanentDayNightKeywords(state, perm);
			if (state.dayNight === 'night' && daybound && !perm.transformed) {
				if (host.transformPermanentRaw(state, perm)) changed = true;
			} else if (state.dayNight === 'day' && nightbound && perm.transformed) {
				if (host.transformPermanentRaw(state, perm)) changed = true;
			}
		}
	}
	return changed;
}

export function setDayNight(state: GameState, designation: 'day' | 'night'): boolean {
	if (state.dayNight === designation) {
		return syncDayboundNightboundPermanents(state);
	}
	const host = getHost();
	// --- Track P16b ---
	const previous = state.dayNight;
	// --- End Track P16b ---
	state.dayNight = designation;
	noteLayerInputsChanged(state);
	host.addLog(state, 'rule', `It becomes ${designation}.`);
	syncDayboundNightboundPermanents(state);
	// --- Track P16b ---
	host.emitEvent(state, {
		kind: 'DayNightChanged',
		previous,
		current: designation
	});
	// --- End Track P16b ---
	return true;
}

export function onPermanentEnteredCheckDayNight(state: GameState, perm: CardInstance): void {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return;
	if (state.dayNight !== undefined) {
		syncDayboundNightboundPermanents(state);
		return;
	}
	const { daybound, nightbound } = permanentDayNightKeywords(state, perm);
	// CR 702.145d: If it is neither day nor night and a permanent with daybound is on the battlefield, it becomes day.
	if (daybound) {
		setDayNight(state, 'day');
		return;
	}
	// CR 702.145g: If it is neither day nor night, a permanent with nightbound is on the battlefield, and no daybound permanent is, it becomes night.
	if (nightbound) {
		const anyDaybound = state.players.some((pl) =>
			pl.battlefield.some((b) => permanentDayNightKeywords(state, b).daybound)
		);
		if (!anyDaybound) {
			setDayNight(state, 'night');
		}
	}
}

export function checkDayNightUntapTransition(state: GameState): void {
	// CR 732.2: Checked as a turn-based action as the untap step begins.
	if (!state.dayNight) return;
	const prevCount = state.prevTurnSpellsCastByActivePlayer ?? 0;
	if (state.dayNight === 'day' && prevCount === 0) {
		setDayNight(state, 'night');
	} else if (state.dayNight === 'night' && prevCount >= 2) {
		setDayNight(state, 'day');
	}
}

export function increasePlayerSpeed(state: GameState, player: PlayerGameState): number {
	const host = getHost();
	if (!player.speed || player.speed <= 0) {
		player.speed = 1;
		noteLayerInputsChanged(state);
		host.addLog(state, 'rule', `${player.username}'s speed becomes 1.`, player.playerId);
		return 1;
	}
	if (player.speed < 4) {
		player.speed += 1;
		noteLayerInputsChanged(state);
		host.addLog(
			state,
			'rule',
			`${player.username}'s speed increases to ${player.speed}.`,
			player.playerId
		);
		return player.speed;
	}
	return player.speed;
}

export function onPlayerLostLifeCheckSpeedTrigger(
	state: GameState,
	losingPlayerId: string,
	amountLost: number
): void {
	// CR 702.179d: "Whenever one or more opponents lose life during your turn, if your speed is less than 4,
	// your speed increases by 1. This ability triggers only once each turn."
	if (amountLost <= 0) return;
	// --- Track P16b ---
	emitEvent(state, {
		kind: 'LifeLost',
		playerId: losingPlayerId,
		amount: amountLost
	});
	// --- End Track P16b ---
	const active = state.players[state.activePlayerIndex];
	if (!active || active.lost) return;
	if (active.playerId === losingPlayerId) return;
	if (!active.speed || active.speed < 1 || active.speed >= 4) return;
	if (active.speedIncreasedThisTurn) return;
	active.speedIncreasedThisTurn = true;
	const dummyCard = makeInherentAbilityCard(
		'inherent-speed-increase',
		'Start your engines!',
		'Whenever one or more opponents lose life during your turn, if your speed is less than 4, your speed increases by 1.'
	);
	const dummySource: CardInstance = {
		instanceId: `speed_${active.playerId}`,
		card: dummyCard,
		ownerId: active.playerId,
		controllerId: active.playerId,
		zone: 'command',
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
	};
	enqueueWave5StackOrPendingTrigger(state, {
		source: dummySource,
		sourceCard: dummyCard,
		controllerId: active.playerId,
		label: 'Speed increases by 1',
		wave5Tag: 'speed_increase'
	});
}

export function checkSpeedAscendAndDayNightSbas(state: GameState): boolean {
	const host = getHost();
	let acted = false;

	for (const p of state.players) {
		if (p.lost) continue;
		const visiblePermanents = p.battlefield.filter((c) => !c.phasedOut);

		// CR 704.5aa: Start your engines! sets speed to 1 if player has no speed.
		if (!p.speed || p.speed <= 0) {
			const hasSye = visiblePermanents.some((perm) =>
				evalHasKeyword(evaluatePermanent(state, perm), 'start your engines!')
			);
			if (hasSye) {
				p.speed = 1;
				noteLayerInputsChanged(state);
				host.addLog(
					state,
					'sba',
					`${p.username} starts their engines! (Speed is 1.)`,
					p.playerId
				);
				acted = true;
			}
		}

		// CR 702.131b: Ascend on a permanent grants the city's blessing when controlling >= 10 permanents.
		if (!p.hasCitysBlessing && visiblePermanents.length >= 10) {
			const hasAscend = visiblePermanents.some((perm) =>
				evalHasKeyword(evaluatePermanent(state, perm), 'ascend')
			);
			if (hasAscend) {
				p.hasCitysBlessing = true;
				noteLayerInputsChanged(state);
				host.addLog(state, 'sba', `${p.username} gets the city's blessing!`, p.playerId);
				acted = true;
			}
		}

		// CR 702.145d,g: Daybound/Nightbound initial day/night check if granted dynamically.
		if (state.dayNight === undefined) {
			for (const perm of visiblePermanents) {
				const { daybound, nightbound } = permanentDayNightKeywords(state, perm);
				if (daybound) {
					setDayNight(state, 'day');
					acted = true;
					break;
				}
				if (nightbound) {
					setDayNight(state, 'night');
					acted = true;
					break;
				}
			}
		}
	}

	if (syncDayboundNightboundPermanents(state)) {
		acted = true;
	}

	return acted;
}

export function checkSpellAscendOnResolve(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): void {
	if (controller.hasCitysBlessing) return;
	const defs = activeAbilityDefs(item.card, stackItemFaceOptions(item));
	const hasAscend = defs.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'ascend');
	if (!hasAscend) return;
	const permCount = controller.battlefield.filter((c) => !c.phasedOut).length;
	if (permCount >= 10) {
		controller.hasCitysBlessing = true;
		noteLayerInputsChanged(state);
		getHost().addLog(
			state,
			'rule',
			`${controller.username} gets the city's blessing!`,
			controller.playerId
		);
	}
}

// ============================================================================
// P15.2 & P15.4 ETB Replacement / Choice Helpers: Read ahead, Amplify, Ravenous
// ============================================================================

export function sagaHasReadAhead(perm: CardInstance): { hasReadAhead: boolean; maxChapter: number } {
	if (perm.isFaceDown) return { hasReadAhead: false, maxChapter: 1 };
	const card = effectiveCardForObject(perm);
	const faces = activeFaceDefs(card, instanceFaceOptions(perm, 'battlefield'));
	const face = faces[0];
	if (!face) return { hasReadAhead: false, maxChapter: 1 };
	const hasReadAhead =
		Boolean(face.hasReadAhead) ||
		face.abilities.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'read ahead');
	let maxChapter = 1;
	for (const ab of face.abilities) {
		if (ab.kind === 'triggered' && ab.trigger.chapterNumbers) {
			for (const ch of ab.trigger.chapterNumbers) {
				if (ch > maxChapter) maxChapter = ch;
			}
		}
	}
	return { hasReadAhead, maxChapter };
}

export function permanentHasRavenous(perm: CardInstance): boolean {
	const card = effectiveCardForObject(perm);
	return activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield')).some(
		(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'ravenous'
	);
}

export function faceHasCompleated(perm: CardInstance): boolean {
	if (perm.isFaceDown) return false;
	const card = effectiveCardForObject(perm);
	return activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield')).some(
		(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'compleated'
	);
}

export function getAmplifyTotalN(perm: CardInstance): number {
	if (perm.isFaceDown) return 0;
	const card = effectiveCardForObject(perm);
	const abilities = activeAbilityDefs(card, instanceFaceOptions(perm, 'battlefield'));
	let total = 0;
	for (const ab of abilities) {
		if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'amplify') {
			total += ab.keyword.n ?? 1;
		}
	}
	return total;
}

export function amplifyMatchingHandCards(
	state: GameState,
	enteringPerm: CardInstance,
	hand: readonly CardInstance[]
): CardInstance[] {
	const prevZone = enteringPerm.zone;
	const card = effectiveCardForObject(enteringPerm);
	const resolved = resolveObjectFaces(card, instanceFaceOptions(enteringPerm, 'battlefield'));
	const abilities = activeAbilityDefs(card, instanceFaceOptions(enteringPerm, 'battlefield'));
	const permAll = abilities.some(
		(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'changeling'
	);
	const permSubs = resolved.subtypes.filter((st) => !NON_CREATURE_SUBTYPES.has(st));
	if (!permAll && permSubs.length === 0) {
		void prevZone;
		return [];
	}
	const permSet = new Set(permSubs.map((s) => s.toLowerCase()));
	return hand.filter((h) => {
		if (h.instanceId === enteringPerm.instanceId) return false;
		const hCard = effectiveCardForObject(h);
		const hRes = resolveObjectFaces(hCard, { zone: 'hand' });
		if (!hRes.types.includes('Creature')) return false;
		const hDefs = activeAbilityDefs(hCard, { zone: 'hand' });
		const hAll = hDefs.some(
			(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'changeling'
		);
		const hSubs = hRes.subtypes.filter((st) => !NON_CREATURE_SUBTYPES.has(st));
		if (permAll && (hAll || hSubs.length > 0)) return true;
		if (hAll && (permAll || permSubs.length > 0)) return true;
		return hSubs.some((s) => permSet.has(s.toLowerCase()));
	});
}

export function applyWave5EtbCountersAndSetup(
	state: GameState,
	perm: CardInstance,
	placeCounters: (
		state: GameState,
		perm: CardInstance,
		counter: CounterType,
		amount: number
	) => number,
	amplifyCounters = 0
): void {
	if (perm.zone !== 'battlefield' || perm.phasedOut) return;
	if (!perm.isFaceDown) {
		// CR 310.4b: A battle enters the battlefield with defense counters equal to its printed defense.
		if (isPermanentBattle(state, perm) && (perm.counters.defense || 0) === 0) {
			const def = printedBattleDefense(perm);
			if (def > 0) {
				placeCounters(state, perm, 'defense', def);
			}
		}
		// Auto-assign Battle protector if not yet chosen (e.g. 2-player game or bot).
		if (isPermanentBattle(state, perm) && !perm.siegeProtectorChosen) {
			const isSiege = isPermanentSiege(state, perm);
			const cands = legalProtectorsForBattle(state, perm, isSiege);
			perm.siegeProtectorChosen = true;
			if (cands.length === 0) {
				perm.protectorId = null;
			} else {
				const sorted = [...cands].sort((a, b) => a.life - b.life || a.seatIndex - b.seatIndex);
				perm.protectorId = sorted[0].playerId;
			}
		}
		// CR 702.156a: Ravenous — enters with X +1/+1 counters.
		if (permanentHasRavenous(perm) && (perm.enteredWithX ?? 0) > 0) {
			placeCounters(state, perm, '+1/+1', perm.enteredWithX!);
		}
		// CR 702.176a: Impending N — enters with N time counters if cast for its impending cost.
		if (perm.castWithImpending) {
			const impKw = findPermanentKeywordDef(perm, 'impending');
			const impN = impKw ? (impKw.impendingN ?? impKw.n ?? 1) : 0;
			if (impN > 0) {
				placeCounters(state, perm, 'time', impN);
			}
		}
		// CR 702.38a: Amplify N — enters with N +1/+1 counters per revealed matching creature card.
		if (amplifyCounters > 0) {
			placeCounters(state, perm, '+1/+1', amplifyCounters);
		}
		// CR 723.3a: "~ enters prepared." static self-replacement on ETB.
		if (
			permanentHasPrepareSpell(perm) &&
			activeAbilityDefs(effectiveCardForObject(perm), instanceFaceOptions(perm)).some(
				(a) => a.kind === 'static' && a.static.k === 'entersPrepared'
			)
		) {
			setPermanentPrepared(state, perm, true);
		}
		// CR 702.145d,g: Daybound / Nightbound initial day/night establishment.
		onPermanentEnteredCheckDayNight(state, perm);
	}
}

export function applyReadAheadEtb(
	state: GameState,
	perm: CardInstance,
	counterMultiplier: number
): boolean {
	const { hasReadAhead, maxChapter } = sagaHasReadAhead(perm);
	if (!hasReadAhead) return false;
	const host = getHost();
	const ctrl = state.players.find((p) => p.playerId === perm.controllerId);
	if (!ctrl || ctrl.isBot || maxChapter <= 1) {
		const chosen = maxChapter;
		perm.readAheadChosenChapter = chosen;
		const added = chosen * counterMultiplier;
		if (added > 0) {
			perm.counters.lore = (perm.counters.lore || 0) + added;
			host.emitEvent(state, {
				kind: 'CounterPlaced',
				objectId: perm.instanceId,
				object: perm,
				counterType: 'lore',
				amount: added,
				previousCount: 0,
				newCount: perm.counters.lore
			});
		}
		return true;
	}
	enqueueChoicePrompt(state, {
		id: host.uid('prm', state),
		playerId: ctrl.playerId,
		kind: 'chooseNumber',
		title: `${perm.card.name} — Read ahead`,
		description: `Choose starting chapter (1 to ${maxChapter}) for ${perm.card.name}.`,
		purpose: 'etb_choice',
		choice: {
			kind: 'chooseNumber',
			min: 1,
			max: maxChapter,
			defaultNumber: 1,
			reason: 'Read ahead — choose starting chapter'
		},
		continuation: {
			kind: 'handler',
			name: 'p15_read_ahead_choice',
			data: {
				sagaId: perm.instanceId,
				sagaVersion: perm.objectVersion || 1,
				multiplier: counterMultiplier
			}
		}
	});
	return true;
}

export function applyAmplifyOnEtb(
	state: GameState,
	perm: CardInstance,
	counterMultiplier: number
): boolean {
	if (perm.amplifyDone || perm.zone !== 'battlefield') return false;
	const card = effectiveCardForObject(perm);
	const abilities = activeAbilityDefs(card, instanceFaceOptions(perm));
	let totalAmplifyN = 0;
	for (const ab of abilities) {
		if (ab.kind === 'keyword' && keywordNameOf(ab.keyword) === 'amplify') {
			totalAmplifyN += ab.keyword.n ?? 1;
		}
	}
	if (totalAmplifyN <= 0) return false;
	perm.amplifyDone = true;
	const ctrl = state.players.find((p) => p.playerId === perm.controllerId);
	if (!ctrl) return false;
	const matchingHand = ctrl.hand.filter(
		(h) => h.instanceId !== perm.instanceId && objectsShareCreatureSubtype(state, perm, h)
	);
	if (matchingHand.length === 0) return false;
	const host = getHost();
	if (ctrl.isBot) {
		for (const h of matchingHand) {
			host.markHandCardRevealedToAll(state, h);
		}
		const countersToAdd = totalAmplifyN * matchingHand.length * counterMultiplier;
		if (countersToAdd > 0) {
			perm.counters['+1/+1'] = (perm.counters['+1/+1'] || 0) + countersToAdd;
			noteLayerInputsChanged(state);
		}
		return false;
	}
	enqueueChoicePrompt(state, {
		id: host.uid('prm', state),
		playerId: ctrl.playerId,
		kind: 'chooseObjects',
		title: `${perm.card.name} — Amplify ${totalAmplifyN}`,
		description: `Choose any number of creature cards in your hand that share a creature type with ${perm.card.name} to reveal.`,
		purpose: 'etb_choice',
		candidateInstanceIds: matchingHand.map((h) => h.instanceId),
		countRequired: 0,
		choice: {
			kind: 'chooseObjects',
			candidates: matchingHand.map((h) => h.instanceId),
			min: 0,
			max: matchingHand.length,
			zone: 'hand',
			reason: `Amplify ${totalAmplifyN}`
		},
		continuation: {
			kind: 'handler',
			name: 'p15_amplify_choice',
			data: {
				permId: perm.instanceId,
				permVersion: perm.objectVersion || 1,
				amplifyN: totalAmplifyN,
				multiplier: counterMultiplier
			}
		}
	});
	return true;
}

// ============================================================================
// P15.3 & P15.4 Cast Options, Gift, Splice, Assist, Cleave, Freerunning, Prowl, Impending, MttM
// ============================================================================

export function findFaceGiftKeyword(
	card: ScryfallCard,
	faceIndex?: number
): KeywordDef | undefined {
	const defs = activeAbilityDefs(card, { faceIndex: faceIndex ?? 0 });
	for (const a of defs) {
		if (a.kind === 'keyword' && keywordNameOf(a.keyword) === 'gift') {
			return a.keyword;
		}
	}
	return undefined;
}

export function buildAssistCostAid(
	state: GameState,
	actor: PlayerGameState,
	card: ScryfallCard,
	faceIndex: number | undefined,
	genericAmount: number
): CastCostAid | null {
	if (genericAmount <= 0) return null;
	const defs = activeAbilityDefs(card, { faceIndex: faceIndex ?? 0 });
	const hasAssist = defs.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'assist');
	if (!hasAssist) return null;
	const others = state.players.filter((p) => !p.lost && p.playerId !== actor.playerId);
	if (others.length === 0) return null;
	return {
		id: 'aid:assist',
		label: 'Assist (another player pays generic mana)',
		kind: 'assistPlayer',
		candidateIds: others.map((p) => p.playerId),
		paysGeneric: 1,
		maxGenericReduction: genericAmount
	};
}

export function buildWave5OptionalCastCosts(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	faceIndex: number
): CastOptionOptionalCost[] {
	const out: CastOptionOptionalCost[] = [];
	const card = effectiveCardForObject(inst);
	const compiled = compileCard(card);
	const face = compiled.faces[faceIndex] ?? compiled.faces[0];
	if (!face) return out;

	// CR 702.174a: Gift optional additional cost ("choose an opponent").
	const giftKw = findFaceGiftKeyword(card, faceIndex);
	if (giftKw) {
		const hasLivingOpponent = state.players.some(
			(p) => !p.lost && p.playerId !== actor.playerId
		);
		if (hasLivingOpponent) {
			const enablesTarget =
				Boolean(face.giftPromisedSpellSpec && face.giftPromisedSpellSpec.targets.length > 0) ||
				face.abilities.some(
					(a) =>
						a.kind === 'spell' &&
						a.targets.some((t) => t.condition?.k === 'giftPromised')
				);
			out.push({
				id: 'opt:gift',
				label: `Promise Gift (${giftKw.param ?? 'a card'})`,
				costDisplay: 'Promise gift to an opponent',
				costDefs: [],
				maxCount: 1,
				kickedTag: 'gift',
				...(enablesTarget ? { enablesTarget: true } : {})
			});
		}
	}

	// CR 702.47a: Splice onto [subtype/type] — scan other cards in actor's hand with matching spliceFilter.
	const isInstantOrSorcery =
		face.characteristics.types.includes('Instant') ||
		face.characteristics.types.includes('Sorcery');
	if (isInstantOrSorcery) {
		for (const handCard of actor.hand) {
			if (handCard.instanceId === inst.instanceId) continue;
			const hCard = effectiveCardForObject(handCard);
			const hDefs = activeAbilityDefs(hCard, { faceIndex: 0 });
			for (const ab of hDefs) {
				if (ab.kind !== 'keyword' || keywordNameOf(ab.keyword) !== 'splice') continue;
				const sf = ab.keyword.spliceFilter;
				if (!sf) continue;
				const typesOk =
					!sf.types || sf.types.some((t) => face.characteristics.types.includes(t));
				const subtypesOk =
					!sf.subtypes ||
					sf.subtypes.some((st) => face.characteristics.subtypes.includes(st));
				if (!typesOk || !subtypesOk) continue;
				const costDefs = ab.keyword.costDefs ?? [];
				const costStr = ab.keyword.cost ?? '';
				out.push({
					id: `opt:splice:${handCard.instanceId}`,
					label: `Splice ${hCard.name}`,
					costDisplay: costStr || 'Splice',
					costDefs,
					maxCount: 1,
					kickedTag: `splice:${handCard.instanceId}`,
					spliceCard: hCard
				});
			}
		}
	}

	return out;
}

export function splicedSpellAbilitiesForOptionalCounts(
	actor: PlayerGameState,
	optionalCostCounts: Record<string, number> | undefined
): Array<{ handInst: CardInstance; card: ScryfallCard; spell: SpellAbility }> {
	if (!optionalCostCounts) return [];
	const out: Array<{ handInst: CardInstance; card: ScryfallCard; spell: SpellAbility }> = [];
	for (const [optId, count] of Object.entries(optionalCostCounts)) {
		if (!count || count <= 0 || !optId.startsWith('opt:splice:')) continue;
		const handId = optId.slice('opt:splice:'.length);
		const handInst = actor.hand.find((c) => c.instanceId === handId);
		if (!handInst) continue;
		const hCard = effectiveCardForObject(handInst);
		const compiled = compileCard(hCard);
		const spell = compiled.faces[0]?.abilities.find(
			(a): a is SpellAbility => a.kind === 'spell'
		);
		if (spell) {
			out.push({ handInst, card: hCard, spell });
		}
	}
	return out;
}

export function collectWave5CastOptionsForCard(
	state: GameState,
	actor: PlayerGameState,
	inst: CardInstance,
	fromZone: 'hand' | 'command' | 'exile' | 'graveyard' | 'library' | 'battlefield',
	hasZonePermission: boolean
): CastOption[] {
	const out: CastOption[] = [];
	const card = effectiveCardForObject(inst);

	// CR 723.3c: Casting a copy of a prepared permanent's prepare spell from the battlefield.
	if (fromZone === 'battlefield') {
		if (
			inst.zone !== 'battlefield' ||
			inst.controllerId !== actor.playerId ||
			!inst.isPrepared
		) {
			return out;
		}
		// CR 723.3c: The copy uses ONLY the printed card's prepare spell (ignoring copy exceptions on the permanent).
		const baseCard = inst.copiableCard ?? inst.card;
		if ((baseCard.layout ?? 'normal') !== 'prepare') return out;
		const compiled = compileCard(baseCard);
		const prepFace = compiled.faces[1];
		if (!prepFace) return out;
		const mandatoryAdditionalCosts = spellAdditionalCost(baseCard, 1)?.defs ?? [];
		const baseOptCosts = spellOptionalAdditionalCosts(baseCard, 1);
		const wave5OptCosts = buildWave5OptionalCastCosts(state, actor, inst, 1);
		const optionalAdditionalCosts = [...baseOptCosts, ...wave5OptCosts];
		const spellAb = prepFace.abilities.find((a): a is SpellAbility => a.kind === 'spell');
		const requiresTarget = Boolean(
			spellAb &&
				(spellAb.targets.some((t) => !t.condition && t.min > 0) ||
					spellAb.modal?.modes.some((m) => m.targets.some((t) => t.min > 0)))
		);
		const choosesX = spellChoosesX(baseCard, undefined, undefined, 1);
		out.push({
			id: 'battlefield:prepare_copy',
			label: `Cast Prepared Spell: ${prepFace.name}`,
			costDisplay: prepFace.characteristics.manaCost || '{0}',
			fromZone: 'battlefield',
			permission: 'preparation_copy',
			faceIndex: 1,
			baseCost: { kind: 'printed' },
			...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
			...(optionalAdditionalCosts.length > 0 ? { optionalAdditionalCosts } : {}),
			timing: 'default',
			spellMods: {
				preparationCopy: true,
				label: `Prepared Copy (${prepFace.name})`
			},
			choosesX,
			requiresTarget
		});
		return out;
	}

	const canCastFromZone =
		fromZone === 'hand' ||
		(fromZone === 'command' && inst.isCommander && inst.ownerId === actor.playerId) ||
		((fromZone === 'exile' || fromZone === 'library') && hasZonePermission);
	if (!canCastFromZone) return out;

	const compiled = compileCard(card);
	const face0 = compiled.faces[0];
	if (!face0) return out;

	for (const ab of face0.abilities) {
		if (ab.kind !== 'keyword') continue;
		const kw = ab.keyword;
		const kwName = keywordNameOf(kw);

		// CR 702.148a: Cleave [cost]
		if (kwName === 'cleave' && face0.cleavedSpellSpec && (kw.cost || kw.costDefs)) {
			const cleaveSpec = face0.cleavedSpellSpec;
			const mandatoryAdditionalCosts = cleaveSpec.additionalCosts;
			const wave5Opt = buildWave5OptionalCastCosts(state, actor, inst, 0);
			const requiresTarget = Boolean(
				cleaveSpec.targets.some((t) => !t.condition && t.min > 0) ||
					cleaveSpec.modal?.modes.some((m) => m.targets.some((t) => t.min > 0))
			);
			const choosesX = Boolean(kw.cost && /\{X\}/i.test(kw.cost));
			out.push({
				id: 'alt:cleave',
				label: 'Cast with Cleave',
				costDisplay: kw.cost ?? '',
				fromZone,
				permission: 'keyword_alt',
				faceIndex: 0,
				baseCost: { kind: 'alternative', manaCost: kw.cost, costDefs: kw.costDefs },
				...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
				...(wave5Opt.length > 0 ? { optionalAdditionalCosts: wave5Opt } : {}),
				timing: 'default',
				spellMods: {
					cleaved: true,
					castSummarySuffix: ' (Cleaved)',
					label: 'Cleaved'
				},
				choosesX,
				requiresTarget
			});
		}

		// CR 702.173a: Freerunning [cost]
		if (kwName === 'freerunning' && (kw.cost || kw.costDefs)) {
			const freerunningUnlocked =
				Boolean(actor.dealtCombatDamageWithCommanderThisTurn) ||
				Boolean(
					actor.dealtCombatDamageWithSubtypesThisTurn?.some(
						(st) => st.toLowerCase() === 'assassin' || st === '__ALL_CREATURE_TYPES__'
					)
				);
			if (freerunningUnlocked) {
				const mandatoryAdditionalCosts = spellAdditionalCost(card, 0)?.defs ?? [];
				const optCosts = [
					...spellOptionalAdditionalCosts(card, 0),
					...buildWave5OptionalCastCosts(state, actor, inst, 0)
				];
				const spellAb = face0.abilities.find((a): a is SpellAbility => a.kind === 'spell');
				const requiresTarget = Boolean(
					spellAb &&
						(spellAb.targets.some((t) => !t.condition && t.min > 0) ||
							spellAb.modal?.modes.some((m) => m.targets.some((t) => t.min > 0)))
				);
				out.push({
					id: 'alt:freerunning',
					label: 'Cast with Freerunning',
					costDisplay: kw.cost ?? '',
					fromZone,
					permission: 'keyword_alt',
					faceIndex: 0,
					baseCost: { kind: 'alternative', manaCost: kw.cost, costDefs: kw.costDefs },
					...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
					...(optCosts.length > 0 ? { optionalAdditionalCosts: optCosts } : {}),
					timing: 'default',
					spellMods: {
						freerunning: true,
						castSummarySuffix: ' (Freerunning)',
						label: 'Freerunning'
					},
					choosesX: Boolean(kw.cost && /\{X\}/i.test(kw.cost)),
					requiresTarget
				});
			}
		}

		// CR 702.76a: Prowl [cost]
		if (kwName === 'prowl' && (kw.cost || kw.costDefs)) {
			const hitSubtypes = actor.dealtCombatDamageWithSubtypesThisTurn ?? [];
			let prowlUnlocked = false;
			if (hitSubtypes.length > 0) {
				const cardCreatureSubtypes = extractCreatureSubtypesForObject(state, inst);
				if (
					cardCreatureSubtypes.allCreatureTypes ||
					(hitSubtypes.includes('__ALL_CREATURE_TYPES__') &&
						cardCreatureSubtypes.subtypes.length > 0)
				) {
					prowlUnlocked = true;
				} else {
					const hitLower = new Set(hitSubtypes.map((s) => s.toLowerCase()));
					prowlUnlocked = cardCreatureSubtypes.subtypes.some((s) =>
						hitLower.has(s.toLowerCase())
					);
				}
			}
			if (prowlUnlocked) {
				const mandatoryAdditionalCosts = spellAdditionalCost(card, 0)?.defs ?? [];
				const optCosts = [
					...spellOptionalAdditionalCosts(card, 0),
					...buildWave5OptionalCastCosts(state, actor, inst, 0)
				];
				const spellAb = face0.abilities.find((a): a is SpellAbility => a.kind === 'spell');
				const requiresTarget = Boolean(
					spellAb &&
						(spellAb.targets.some((t) => !t.condition && t.min > 0) ||
							spellAb.modal?.modes.some((m) => m.targets.some((t) => t.min > 0)))
				);
				out.push({
					id: 'alt:prowl',
					label: 'Cast with Prowl',
					costDisplay: kw.cost ?? '',
					fromZone,
					permission: 'keyword_alt',
					faceIndex: 0,
					baseCost: { kind: 'alternative', manaCost: kw.cost, costDefs: kw.costDefs },
					...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
					...(optCosts.length > 0 ? { optionalAdditionalCosts: optCosts } : {}),
					timing: 'default',
					spellMods: {
						prowled: true,
						castSummarySuffix: ' (Prowl)',
						label: 'Prowl'
					},
					choosesX: Boolean(kw.cost && /\{X\}/i.test(kw.cost)),
					requiresTarget
				});
			}
		}

		// CR 702.176a: Impending N—[cost]
		if (kwName === 'impending' && (kw.cost || kw.costDefs)) {
			const impN = kw.impendingN ?? kw.n ?? 1;
			const mandatoryAdditionalCosts = spellAdditionalCost(card, 0)?.defs ?? [];
			const optCosts = [
				...spellOptionalAdditionalCosts(card, 0),
				...buildWave5OptionalCastCosts(state, actor, inst, 0)
			];
			out.push({
				id: 'alt:impending',
				label: `Cast with Impending ${impN}`,
				costDisplay: kw.cost ?? '',
				fromZone,
				permission: 'keyword_alt',
				faceIndex: 0,
				baseCost: { kind: 'alternative', manaCost: kw.cost, costDefs: kw.costDefs },
				...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
				...(optCosts.length > 0 ? { optionalAdditionalCosts: optCosts } : {}),
				timing: 'default',
				spellMods: {
					impendingN: impN,
					castSummarySuffix: ` (Impending ${impN})`,
					label: `Impending ${impN}`
				},
				choosesX: Boolean(kw.cost && /\{X\}/i.test(kw.cost)),
				requiresTarget: false
			});
		}

		// CR 702.162a: More Than Meets the Eye [cost] — cast converted (back face up, faceIndex: 1).
		if (
			kwName === 'more than meets the eye' &&
			(kw.cost || kw.costDefs) &&
			compiled.faces.length >= 2
		) {
			const mandatoryAdditionalCosts = spellAdditionalCost(card, 1)?.defs ?? [];
			const optCosts = [
				...spellOptionalAdditionalCosts(card, 1),
				...buildWave5OptionalCastCosts(state, actor, inst, 1)
			];
			out.push({
				id: 'alt:more_than_meets_the_eye',
				label: `Cast Converted (${compiled.faces[1].name})`,
				costDisplay: kw.cost ?? '',
				fromZone,
				permission: 'keyword_alt',
				faceIndex: 1,
				baseCost: { kind: 'alternative', manaCost: kw.cost, costDefs: kw.costDefs },
				...(mandatoryAdditionalCosts.length > 0 ? { mandatoryAdditionalCosts } : {}),
				...(optCosts.length > 0 ? { optionalAdditionalCosts: optCosts } : {}),
				timing: 'default',
				spellMods: {
					castTransformed: true,
					convertedMttm: true,
					castSummarySuffix: ' (Converted)',
					label: 'Converted'
				},
				choosesX: Boolean(kw.cost && /\{X\}/i.test(kw.cost)),
				requiresTarget: false
			});
		}
	}

	return out;
}

// ============================================================================
// P15.3 Gift Delivery Helper (CR 702.174d–j)
// ============================================================================

export function deliverPromisedGift(
	state: GameState,
	giftKind: NonNullable<StackItem['giftKind']>,
	recipientId: string | undefined,
	sourceName: string,
	giverId?: string
): void {
	if (!recipientId) return;
	const recipient = state.players.find((p) => p.playerId === recipientId && !p.lost);
	if (!recipient) return;
	const host = getHost();
	switch (giftKind) {
		case 'card':
			host.addLog(
				state,
				'rule',
				`${sourceName}'s promised gift: ${recipient.username} draws a card.`,
				recipient.playerId
			);
			host.drawCards(state, recipient, 1);
			break;
		case 'food':
			host.createTokens(
				state,
				recipient,
				{
					name: 'Food Token',
					power: 0,
					toughness: 0,
					colors: [],
					typeLine: 'Token Artifact — Food',
					keywords: [],
					quotedAbilities: ['{2}, {T}, Sacrifice ~: You gain 3 life.']
				},
				1,
				sourceName
			);
			break;
		case 'treasure':
			host.createTokens(
				state,
				recipient,
				{
					name: 'Treasure Token',
					power: 0,
					toughness: 0,
					colors: [],
					typeLine: 'Token Artifact — Treasure',
					keywords: [],
					quotedAbilities: ['{T}, Sacrifice ~: Add one mana of any color.']
				},
				1,
				sourceName
			);
			break;
		case 'tappedFish':
			host.createTokens(
				state,
				recipient,
				{
					name: 'Fish Token',
					power: 1,
					toughness: 1,
					colors: ['U'],
					typeLine: 'Token Creature — Fish',
					keywords: [],
					tapped: true
				},
				1,
				sourceName
			);
			break;
		case 'octopus':
			host.createTokens(
				state,
				recipient,
				{
					name: 'Octopus Token',
					power: 8,
					toughness: 8,
					colors: ['U'],
					typeLine: 'Token Creature — Octopus',
					keywords: []
				},
				1,
				sourceName
			);
			break;
		case 'extraTurn':
			state.extraTurnQueue ??= [];
			state.extraTurnQueue.push(recipient.playerId);
			host.addLog(
				state,
				'rule',
				`${sourceName}'s promised gift: ${recipient.username} takes an extra turn after this one.`,
				recipient.playerId
			);
			break;
	}
	if (giverId) {
		host.emitEvent(state, {
			kind: 'GiftGiven',
			playerId: giverId,
			recipientId: recipient.playerId,
			giftKind
		});
	}
}

// ============================================================================
// P15.3 & P15.4 Cast, Attack, Combat-Damage, & Paradigm Triggers
// ============================================================================

export function collectWave5CastTriggers(
	state: GameState,
	castItem: StackItem,
	castCard: CardInstance,
	caster: PlayerGameState
): Array<{
	ability: Wave5RuntimeTrigger;
	source: CardInstance;
	sourceCard: ScryfallCard;
	controllerId: string;
	label: string;
	wave5Tag: string;
	wave5N?: number;
	wave5Card?: ScryfallCard;
}> {
	const out: Array<{
		ability: Wave5RuntimeTrigger;
		source: CardInstance;
		sourceCard: ScryfallCard;
		controllerId: string;
		label: string;
		wave5Tag: string;
		wave5N?: number;
		wave5Card?: ScryfallCard;
	}> = [];
	if (castItem.kind !== 'spell' || castItem.isCopy) return out;

	// 1. Spell self-cast triggers: Ripple N (CR 702.60a) & Demonstrate (CR 702.144a)
	const spellDefs = activeAbilityDefs(castItem.card, stackItemFaceOptions(castItem));
	for (let i = 0; i < spellDefs.length; i++) {
		const ab = spellDefs[i];
		if (ab.kind !== 'keyword') continue;
		const spellKwName = keywordNameOf(ab.keyword);
		if (spellKwName === 'ripple') {
			const n = ab.keyword.n ?? 4;
			const label = `${castItem.card.name} — Ripple ${n}`;
			const rt: Wave5RuntimeTrigger = {
				abilityIndex: i,
				trigger: { event: 'cast', filter: { object: 'self' } },
				effectSupported: true,
				text: label,
				effect: { steps: [], targets: [], unparsed: [] },
				wave5Tag: 'ripple',
				wave5N: n
			};
			out.push({
				ability: rt,
				source: castCard,
				sourceCard: castItem.card,
				controllerId: caster.playerId,
				label,
				wave5Tag: 'ripple',
				wave5N: n
			});
		} else if (spellKwName === 'demonstrate') {
			const label = `${castItem.card.name} — Demonstrate`;
			const rt: Wave5RuntimeTrigger = {
				abilityIndex: i,
				trigger: { event: 'cast', filter: { object: 'self' } },
				effectSupported: true,
				text: label,
				effect: { steps: [], targets: [], unparsed: [] },
				wave5Tag: 'demonstrate'
			};
			out.push({
				ability: rt,
				source: castCard,
				sourceCard: castItem.card,
				controllerId: caster.playerId,
				label,
				wave5Tag: 'demonstrate'
			});
		}
	}
	if (castItem.grantedSpellKeywords?.length) {
		for (let gi = 0; gi < castItem.grantedSpellKeywords.length; gi++) {
			const gkw = castItem.grantedSpellKeywords[gi]!;
			const rm = gkw.match(/^ripple(?:\s+(\d+))?$/i);
			if (!rm) continue;
			const n = rm[1] ? Number(rm[1]) : 4;
			const label = `${castItem.card.name} — Ripple ${n}`;
			const rt: Wave5RuntimeTrigger = {
				abilityIndex: -1 - gi,
				trigger: { event: 'cast', filter: { object: 'self' } },
				effectSupported: true,
				text: label,
				effect: { steps: [], targets: [], unparsed: [] },
				wave5Tag: 'ripple',
				wave5N: n
			};
			out.push({
				ability: rt,
				source: castCard,
				sourceCard: castItem.card,
				controllerId: caster.playerId,
				label,
				wave5Tag: 'ripple',
				wave5N: n
			});
		}
	}

	// 2. Battlefield Increment triggers on caster's creatures (CR 702.191a–b)
	const manaSpent = castItem.manaSpentCount ?? 0;
	for (const perm of caster.battlefield) {
		if (perm.zone !== 'battlefield' || perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.isCreature) continue;
		if (!(manaSpent > ev.power || manaSpent > ev.toughness)) continue;
		if (!evalHasKeyword(ev, 'increment')) continue;
		// Count instances of 'increment' on perm (innate + granted, CR 702.191b)
		const pCard = effectiveCardForObject(perm);
		const pDefs = activeAbilityDefs(pCard, instanceFaceOptions(perm));
		let innateCount = 0;
		if (!ev.losesAllAbilities) {
			for (const d of pDefs) {
				if (d.kind === 'keyword' && keywordNameOf(d.keyword) === 'increment') innateCount++;
			}
		}
		const grantedCount = evalGrantCount(ev, 'increment');
		const totalInstances = Math.max(1, innateCount + grantedCount);
		for (let k = 0; k < totalInstances; k++) {
			const label = `${perm.card.name} — Increment`;
			const rt: Wave5RuntimeTrigger = {
				abilityIndex: -1,
				trigger: { event: 'cast', filter: { player: { relation: 'you' } } },
				effectSupported: true,
				text: label,
				effect: { steps: [], targets: [], unparsed: [] },
				wave5Tag: 'increment',
				wave5N: manaSpent
			};
			out.push({
				ability: rt,
				source: perm,
				sourceCard: pCard,
				controllerId: caster.playerId,
				label,
				wave5Tag: 'increment',
				wave5N: manaSpent
			});
		}
	}

	return out;
}

export function enqueueProvokeAttackTriggers(
	state: GameState,
	attacker: CardInstance,
	defenderPlayerId: string
): void {
	if (attacker.zone !== 'battlefield' || attacker.phasedOut) return;
	const ev = evaluatePermanent(state, attacker);
	if (!evalHasKeyword(ev, 'provoke')) return;
	const pCard = effectiveCardForObject(attacker);
	const pDefs = activeAbilityDefs(pCard, instanceFaceOptions(attacker));
	let innateCount = 0;
	if (!ev.losesAllAbilities) {
		for (const d of pDefs) {
			if (d.kind === 'keyword' && keywordNameOf(d.keyword) === 'provoke') innateCount++;
		}
	}
	const count = Math.max(1, innateCount + evalGrantCount(ev, 'provoke'));
	const defender = state.players.find((p) => p.playerId === defenderPlayerId && !p.lost);
	if (!defender) return;
	const hasTargetableCreature = defender.battlefield.some(
		(c) => !c.phasedOut && evaluatePermanent(state, c).isCreature
	);
	if (!hasTargetableCreature) return;

	const targetSpec: TargetSpec = {
		kind: 'object',
		filter: {
			zone: 'battlefield',
			types: ['Creature'],
			controllerRef: { k: 'defendingPlayer' }
		},
		min: 0,
		max: 1
	};
	for (let i = 0; i < count; i++) {
		enqueueWave5StackOrPendingTrigger(state, {
			source: attacker,
			sourceCard: pCard,
			controllerId: attacker.controllerId,
			defendingPlayerId: defenderPlayerId,
			label: `${attacker.card.name} — Provoke`,
			wave5Tag: 'provoke',
			targets: [targetSpec]
		});
	}
}

export function recordCombatDamagePlayerWave5(
	state: GameState,
	attacker: CardInstance,
	damagedPlayer: PlayerGameState
): void {
	const controller = state.players.find((p) => p.playerId === attacker.controllerId);
	if (!controller) return;
	const ev = evaluatePermanent(state, attacker);

	// CR 702.173a Freerunning & CR 702.76a Prowl tracking
	if (attacker.isCommander) {
		controller.dealtCombatDamageWithCommanderThisTurn = true;
	}
	if (ev.isCreature) {
		controller.dealtCombatDamageWithSubtypesThisTurn ??= [];
		if (ev.hasAllCreatureTypes || evalHasKeyword(ev, 'changeling')) {
			if (!controller.dealtCombatDamageWithSubtypesThisTurn.includes('__ALL_CREATURE_TYPES__')) {
				controller.dealtCombatDamageWithSubtypesThisTurn.push('__ALL_CREATURE_TYPES__');
			}
		} else {
			for (const st of evalSubtypes(ev)) {
				if (!NON_CREATURE_SUBTYPES.has(st)) {
					if (!controller.dealtCombatDamageWithSubtypesThisTurn.includes(st)) {
						controller.dealtCombatDamageWithSubtypesThisTurn.push(st);
					}
				}
			}
		}
	}

	// CR 702.99b Cipher: encoded card on creature dealing combat damage to a player
	if (attacker.encodedSpellCards && attacker.encodedSpellCards.length > 0) {
		const ver = attacker.objectVersion || 1;
		for (const encodedCard of attacker.encodedSpellCards) {
			// Verify the encoded card is still in exile linked to this creature (CR 702.99c)
			const stillExiled = state.players.some((pl) =>
				pl.exile.some(
					(ex) =>
						ex.exiledBy?.sourceInstanceId === attacker.instanceId &&
						ex.exiledBy?.sourceObjectVersion === ver &&
						ex.card.id === encodedCard.id
				)
			);
			if (!stillExiled) continue;
			enqueueWave5StackOrPendingTrigger(state, {
				source: attacker,
				controllerId: controller.playerId,
				label: `${attacker.card.name} — Cipher (${encodedCard.name})`,
				wave5Tag: 'cipher_cast',
				wave5Card: encodedCard,
				defendingPlayerId: damagedPlayer.playerId
			});
		}
	}
}

export function handleCipherSpellPostResolve(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): boolean {
	if (item.isCopy) return false;
	const defs = activeAbilityDefs(item.card, stackItemFaceOptions(item));
	const hasCipher = defs.some((a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'cipher');
	if (!hasCipher) return false;

	const creatures = controller.battlefield.filter(
		(c) => !c.phasedOut && evaluatePermanent(state, c).isCreature
	);
	if (creatures.length === 0) return false;

	const host = getHost();
	const ownerId = item.ownerId ?? item.controllerId;
	const owner = state.players.find((p) => p.playerId === ownerId);
	if (!owner) return false;

	host.moveStackSpellToZone(state, item, 'exile');
	const exiled = owner.exile.find((c) => c.instanceId === item.sourceInstanceId);
	if (!exiled || exiled.zone !== 'exile') return true;

	if (controller.isBot) {
		const targetCreature = creatures[0];
		exiled.exiledBy = {
			sourceInstanceId: targetCreature.instanceId,
			sourceObjectVersion: targetCreature.objectVersion || 1
		};
		targetCreature.encodedSpellCards ??= [];
		targetCreature.encodedSpellCards.push(exiled.card);
		host.addLog(
			state,
			'rule',
			`${controller.username} exiles ${exiled.card.name} encoded on ${targetCreature.card.name} (Cipher).`,
			controller.playerId
		);
		return true;
	}

	// Human controller: offer choice of creature (0..1; if 0 chosen, move to graveyard!)
	enqueueChoicePrompt(state, {
		id: host.uid('prm', state),
		playerId: controller.playerId,
		kind: 'chooseObjects',
		title: `${item.card.name} — Cipher`,
		description: `You may choose a creature you control to exile ${item.card.name} encoded on it.`,
		candidateInstanceIds: creatures.map((c) => c.instanceId),
		countRequired: 0,
		choice: {
			kind: 'chooseObjects',
			candidates: creatures.map((c) => c.instanceId),
			min: 0,
			max: 1,
			zone: 'battlefield',
			reason: 'Cipher — choose a creature to encode onto (or none)'
		},
		continuation: {
			kind: 'handler',
			name: 'p15_cipher_encode_choice',
			data: {
				exiledId: exiled.instanceId,
				exiledVersion: exiled.objectVersion || 1
			}
		}
	});
	return true;
}

export function handleParadigmSpellPostResolve(
	state: GameState,
	item: StackItem,
	controller: PlayerGameState
): boolean {
	const defs = activeAbilityDefs(item.card, stackItemFaceOptions(item));
	const hasParadigm = defs.some(
		(a) => a.kind === 'keyword' && keywordNameOf(a.keyword) === 'paradigm'
	);
	if (!hasParadigm) return false;

	const host = getHost();
	const lowerName = item.card.name.toLowerCase();
	controller.paradigmResolvedNames ??= [];
	if (!controller.paradigmResolvedNames.includes(lowerName)) {
		controller.paradigmResolvedNames.push(lowerName);
		controller.paradigmCards ??= [];
		controller.paradigmCards.push(item.card);
		host.addLog(
			state,
			'rule',
			`${controller.username} establishes Paradigm for ${item.card.name}!`,
			controller.playerId
		);
	}

	if (!item.isCopy) {
		host.moveStackSpellToZone(state, item, 'exile');
	}
	return true;
}

export function enqueueParadigmMain1Triggers(state: GameState, activePlayer: PlayerGameState): void {
	if (!activePlayer.paradigmCards || activePlayer.paradigmCards.length === 0) return;
	for (const card of activePlayer.paradigmCards) {
		const dummySource: CardInstance = {
			instanceId: `paradigm_${activePlayer.playerId}_${card.id}`,
			card,
			ownerId: activePlayer.playerId,
			controllerId: activePlayer.playerId,
			zone: 'exile',
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
		};
		enqueueWave5StackOrPendingTrigger(state, {
			source: dummySource,
			sourceCard: card,
			controllerId: activePlayer.playerId,
			label: `${card.name} — Paradigm`,
			wave5Tag: 'paradigm_main1',
			wave5Card: card
		});
	}
}

// ============================================================================
// P15.3 & P15.4 Craft, Reconfigure, Transfigure, Aura Swap Helpers
// ============================================================================

function findPermanentKeywordDef(
	perm: CardInstance,
	kwName: string
): KeywordDef | undefined {
	const card = effectiveCardForObject(perm);
	const defs = activeAbilityDefs(card, instanceFaceOptions(perm));
	for (const a of defs) {
		if (a.kind === 'keyword' && keywordNameOf(a.keyword) === kwName) {
			return a.keyword;
		}
	}
	return undefined;
}

function candidateMatchesCraftMaterial(
	state: GameState,
	actor: PlayerGameState,
	sourcePerm: CardInstance,
	cand: CardInstance,
	filter: ObjectFilter
): boolean {
	if (cand.instanceId === sourcePerm.instanceId) return false;
	// CR 702.167b: Material filter can match either a permanent you control on battlefield or a card in your graveyard.
	const { zone: _z, controller: _c, owner: _o, other: _oth, ...coreFilter } = filter;
	const ctx: FilterContext = {
		state,
		controllerId: actor.playerId,
		source: sourcePerm
	};
	return matchesObjectFilter(cand, coreFilter, ctx);
}

export function selectCraftMaterialObjects(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	preferredIds?: readonly string[]
): CardInstance[] | null {
	const kw = findPermanentKeywordDef(perm, 'craft');
	if (!kw) return [];
	const materials = kw.craftMaterials ?? [];
	if (materials.length === 0) return [];

	const pool: CardInstance[] = [
		...actor.graveyard,
		...actor.battlefield.filter((b) => b.instanceId !== perm.instanceId && !b.phasedOut)
	];

	if (kw.craftAnyNumber) {
		const singleFilter = materials[0];
		if (preferredIds && preferredIds.length > 0) {
			const chosen: CardInstance[] = [];
			for (const pid of preferredIds) {
				const found = pool.find((c) => c.instanceId === pid);
				if (found && candidateMatchesCraftMaterial(state, actor, perm, found, singleFilter)) {
					chosen.push(found);
				}
			}
			return chosen;
		}
		return pool.filter((c) =>
			candidateMatchesCraftMaterial(state, actor, perm, c, singleFilter)
		);
	}

	// Fixed material slots — find distinct matching objects via bounded backtracking (slots <= 6).
	const orderedPool = preferredIds && preferredIds.length > 0
		? [
				...pool.filter((c) => preferredIds.includes(c.instanceId)),
				...pool.filter((c) => !preferredIds.includes(c.instanceId))
			]
		: pool;

	const used = new Set<string>();
	const result: CardInstance[] = [];

	function assignSlot(slotIdx: number): boolean {
		if (slotIdx >= materials.length) return true;
		const filter = materials[slotIdx];
		for (const cand of orderedPool) {
			if (used.has(cand.instanceId)) continue;
			if (!candidateMatchesCraftMaterial(state, actor, perm, cand, filter)) continue;
			used.add(cand.instanceId);
			result.push(cand);
			if (assignSlot(slotIdx + 1)) return true;
			result.pop();
			used.delete(cand.instanceId);
		}
		return false;
	}

	return assignSlot(0) ? result : null;
}

export function checkWave5AbilityActivation(
	state: GameState,
	actor: PlayerGameState,
	perm: CardInstance,
	abilityId: string,
	costKeyword?: string
): string | null {
	if (abilityId.startsWith('reconfigure_unattach_')) {
		if (!perm.attachedToId) {
			return 'Cannot unattach: permanent is not attached to a creature.';
		}
	}
	if (costKeyword === 'craft') {
		const selected = selectCraftMaterialObjects(state, actor, perm);
		if (selected === null) {
			return 'Missing required materials to Craft.';
		}
	}
	return null;
}

export function payCraftMaterialsOnActivate(
	state: GameState,
	actor: PlayerGameState,
	sourceInstanceId: string,
	sourceCard: ScryfallCard,
	preferredIds?: readonly string[]
): ScryfallCard[] {
	// Source permanent may have just been exiled as part of `exileFrom self`; reconstruct dummy source if needed
	const dummyPerm: CardInstance =
		actor.exile.find((c) => c.instanceId === sourceInstanceId) ??
		actor.battlefield.find((c) => c.instanceId === sourceInstanceId) ?? {
			instanceId: sourceInstanceId,
			card: sourceCard,
			ownerId: actor.playerId,
			controllerId: actor.playerId,
			zone: 'exile',
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
		};

	const chosen = selectCraftMaterialObjects(state, actor, dummyPerm, preferredIds) ?? [];
	const craftedCards: ScryfallCard[] = [];
	for (const mat of chosen) {
		const snap = effectiveCardForObject(mat);
		const wasBf = mat.zone === 'battlefield';
		const res = moveObject(state, mat, 'exile', {
			from: wasBf ? 'anyBattlefield' : { player: actor, zone: 'graveyard' },
			bumpVersion: true,
			leaveBattlefieldReset: wasBf,
			detachAttachments: wasBf,
			ceaseToExist: 'tokens'
		});
		if (res === 'exile' && mat.zone === 'exile') {
			craftedCards.push(snap);
		}
	}
	return craftedCards;
}

// ============================================================================
// Free Spell / Copy Casting Helper (Siege Defeat, Ripple, Cipher, Paradigm)
// ============================================================================

function autoSelectFreeSpellTargets(
	state: GameState,
	controller: PlayerGameState,
	card: ScryfallCard,
	faceIndex: number
): { ok: boolean; targets: TargetRef[]; targetsBySpec: TargetRef[][] } {
	const compiled = compileCard(card);
	const face = compiled.faces[faceIndex] ?? compiled.faces[0];
	const spell = face?.abilities.find((a): a is SpellAbility => a.kind === 'spell');
	if (!spell || spell.targets.length === 0) {
		return { ok: true, targets: [], targetsBySpec: [] };
	}
	const targets: TargetRef[] = [];
	const targetsBySpec: TargetRef[][] = [];
	const usedIds = new Set<string>();

	for (const spec of spell.targets) {
		if (spec.condition) {
			targetsBySpec.push([]);
			continue;
		}
		const specTargets: TargetRef[] = [];
		if (spec.kind === 'player' || spec.kind === 'objectOrPlayer') {
			const opp = state.players.find((p) => !p.lost && p.playerId !== controller.playerId);
			const chosenPlayer =
				spec.player?.relation === 'you' ? controller : (opp ?? controller);
			if (chosenPlayer && spec.min > 0) {
				const ref: TargetRef = {
					kind: 'player',
					id: chosenPlayer.playerId,
					label: chosenPlayer.username
				};
				specTargets.push(ref);
				targets.push(ref);
			}
		}
		if (specTargets.length < spec.min && (spec.kind === 'object' || spec.kind === 'objectOrPlayer')) {
			const ctx: FilterContext = { state, controllerId: controller.playerId };
			for (const p of state.players) {
				for (const perm of p.battlefield) {
					if (perm.phasedOut) continue;
					if (spec.otherTarget && usedIds.has(perm.instanceId)) continue;
					if (matchesObjectFilter(perm, spec.filter, ctx)) {
						const ref: TargetRef = {
							kind: 'permanent',
							id: perm.instanceId,
							label: perm.card.name
						};
						specTargets.push(ref);
						targets.push(ref);
						usedIds.add(perm.instanceId);
						if (specTargets.length >= spec.min) break;
					}
				}
				if (specTargets.length >= spec.min) break;
			}
		}
		if (specTargets.length < spec.min) {
			return { ok: false, targets: [], targetsBySpec: [] };
		}
		targetsBySpec.push(specTargets);
	}
	return { ok: true, targets, targetsBySpec };
}

function castExiledCardFree(
	state: GameState,
	controller: PlayerGameState,
	exiledInst: CardInstance,
	opts: { faceIndex?: number; castTransformed?: boolean; isCopyCard?: boolean }
): boolean {
	const host = getHost();
	const owner = state.players.find((p) => p.playerId === exiledInst.ownerId);
	if (!owner) return false;
	const fi = opts.faceIndex ?? 0;
	const card = effectiveCardForObject(exiledInst);
	const compiled = compileCard(card);
	const face = compiled.faces[fi] ?? compiled.faces[0];
	if (!face) return false;
	if (face.characteristics.types.includes('Land') && face.characteristics.types.length === 1) {
		return false;
	}
	const targetSel = autoSelectFreeSpellTargets(state, controller, card, fi);
	if (!targetSel.ok) return false;

	host.finalizeCastSpell(state, controller, exiledInst, owner, 'exile', {
		targets: targetSel.targets,
		targetsBySpec: targetSel.targetsBySpec,
		xValue: 0,
		faceIndex: fi,
		spellMods: {
			...(opts.castTransformed ? { castTransformed: true } : {}),
			label: opts.castTransformed ? 'Cast Transformed (Free)' : 'Cast without paying mana cost'
		}
	});
	if (opts.isCopyCard && state.stack.length > 0) {
		const top = state.stack[state.stack.length - 1];
		if (top.sourceInstanceId === exiledInst.instanceId) {
			top.isCopy = true;
		}
	}
	return true;
}

function castCardCopyFromExileFree(
	state: GameState,
	controller: PlayerGameState,
	card: ScryfallCard
): boolean {
	const host = getHost();
	const copyInst: CardInstance = {
		instanceId: host.uid('w5copy', state),
		card,
		ownerId: controller.playerId,
		controllerId: controller.playerId,
		zone: 'exile',
		tapped: false,
		summoningSick: false,
		damageMarked: 0,
		deathtouchDamageMarked: false,
		counters: createEmptyCounterMap(),
		tempPowerMod: 0,
		tempToughnessMod: 0,
		grantedKeywords: [],
		attachedToId: null,
		isToken: true,
		isCommander: false,
		commanderCastCount: 0,
		usedLoyaltyThisTurn: false,
		transformed: false
	};
	const compiled = compileCard(card);
	const face = compiled.faces[0];
	if (!face) return false;
	const targetSel = autoSelectFreeSpellTargets(state, controller, card, 0);
	if (!targetSel.ok) return false;

	const stackId = host.uid('stack', state);
	const item: StackItem = withStackItemText(
		{
			id: stackId,
			sourceInstanceId: copyInst.instanceId,
			card,
			ownerId: controller.playerId,
			controllerId: controller.playerId,
			kind: 'spell',
			title: `${card.name} (Copy)`,
			targets: targetSel.targets,
			...(targetSel.targetsBySpec.length > 0 ? { targetsBySpec: targetSel.targetsBySpec } : {}),
			xValue: 0,
			requiresGuidedResolution: !compiled.fullySupported,
			createdAt: state.turnNumber,
			isCopy: true,
			faceIndex: 0,
			manaSpentCount: 0,
			manaColorsSpent: []
		},
		card
	);
	state.stack.push(item);
	controller.spellsCastThisTurn = (controller.spellsCastThisTurn ?? 0) + 1;
	if (state.players[state.activePlayerIndex]?.playerId === controller.playerId) {
		state.spellsCastByActivePlayerThisTurn = (state.spellsCastByActivePlayerThisTurn ?? 0) + 1;
	}
	host.addLog(
		state,
		'cast',
		`${controller.username} casts a copy of ${card.name} without paying its mana cost.`,
		controller.playerId
	);
	host.emitEvent(state, {
		kind: 'Cast',
		playerId: controller.playerId,
		objectId: copyInst.instanceId,
		object: copyInst
	});
	return true;
}

// ============================================================================
// Wave 5 Stack Resolution Dispatcher (`resolveWave5StackItem`)
// ============================================================================

export function isWave5StackItem(item: StackItem): boolean {
	if (item.wave5Tag) return true;
	if (item.kind === 'activated' && item.abilityId) {
		if (
			item.abilityId.startsWith('craft_') ||
			item.abilityId.startsWith('reconfigure_unattach_') ||
			item.abilityId.startsWith('transfigure_') ||
			item.abilityId.startsWith('aura_swap_')
		) {
			return true;
		}
	}
	return false;
}

export function resolveWave5StackItem(state: GameState, item: StackItem): 'done' | 'paused' {
	const host = getHost();
	const controller = state.players.find((p) => p.playerId === item.controllerId);
	if (!controller || controller.lost) return 'done';

	// 1. Activated keyword abilities: Reconfigure unattach, Craft, Transfigure, Aura swap
	if (item.kind === 'activated' && item.abilityId) {
		if (item.abilityId.startsWith('reconfigure_unattach_')) {
			const perm = controller.battlefield.find(
				(c) =>
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined ||
						(c.objectVersion || 1) === item.sourceObjectVersion)
			);
			if (perm && perm.attachedToId) {
				// --- Track P16b ---
				const prevHostId = perm.attachedToId;
				// --- End Track P16b ---
				perm.attachedToId = null;
				noteLayerInputsChanged(state);
				// --- Track P16b ---
				emitEvent(state, {
					kind: 'Unattached',
					attachmentId: perm.instanceId,
					attachment: perm,
					hostId: prevHostId
				});
				// --- End Track P16b ---
				host.addLog(
					state,
					'rule',
					`${controller.username} unattaches ${perm.card.name}.`,
					controller.playerId
				);
			}
			return 'done';
		}

		if (item.abilityId.startsWith('craft_')) {
			// Return source card from exile to battlefield transformed under its owner's control (CR 702.167a)
			let exiledSource: CardInstance | undefined;
			let holder: PlayerGameState | undefined;
			for (const p of state.players) {
				const found = p.exile.find((c) => c.instanceId === item.sourceInstanceId);
				if (found) {
					exiledSource = found;
					holder = p;
					break;
				}
			}
			if (exiledSource && holder && !exiledSource.isToken) {
				const owner = state.players.find((p) => p.playerId === exiledSource!.ownerId);
				if (owner && !owner.lost) {
					const craftedSnapshot = item.splicedCards ?? [];
					const res = moveObject(state, exiledSource, 'battlefield', {
						from: { player: holder, zone: 'exile' },
						toPlayer: owner,
						controllerId: owner.playerId,
						bumpVersion: true,
						newTimestamp: true,
						beforeInsert: (entering, dest) => {
							if (dest === 'battlefield') {
								entering.transformed = true;
								entering.activeFaceIndex = 1;
								entering.craftedWithCards = craftedSnapshot;
								entering.summoningSick = true;
							}
						}
					});
					if (res === 'battlefield' && exiledSource.zone === 'battlefield') {
						noteLayerInputsChanged(state);
						host.addLog(
							state,
							'rule',
							`${exiledSource.card.name} returns transformed via Craft.`,
							controller.playerId
						);
					}
				}
			}
			return 'done';
		}

		if (item.abilityId.startsWith('transfigure_')) {
			// CR 702.71a: Search your library for a creature card with the same mana value as this permanent, put onto battlefield, shuffle.
			const targetMv = effectiveManaValue(item.card, { faceIndex: item.faceIndex ?? 0 });
			const matching = controller.library.filter((c) => {
				const cc = effectiveCardForObject(c);
				const resolved = resolveObjectFaces(cc, { zone: 'library' });
				return (
					resolved.types.includes('Creature') &&
					effectiveManaValue(cc, { zone: 'library' }) === targetMv
				);
			});
			if (matching.length === 0) {
				host.shuffleLibrary(state, controller);
				return 'done';
			}
			if (controller.isBot || item.wave5Resume?.step === 'transfigure_picked') {
				const pickedId =
					item.wave5Resume?.step === 'transfigure_picked'
						? item.wave5Resume.chosenObjectIds?.[0]
						: matching[0].instanceId;
				const picked = pickedId
					? controller.library.find((c) => c.instanceId === pickedId)
					: undefined;
				if (picked) {
					moveObject(state, picked, 'battlefield', {
						from: { player: controller, zone: 'library' },
						toPlayer: controller,
						controllerId: controller.playerId,
						bumpVersion: true,
						newTimestamp: true,
						beforeInsert: (entering, dest) => {
							if (dest === 'battlefield') entering.summoningSick = true;
						}
					});
				}
				host.shuffleLibrary(state, controller);
				return 'done';
			}
			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				title: `${item.card.name} — Transfigure`,
				description: `Choose up to one creature card with mana value ${targetMv} from your library to put onto the battlefield.`,
				candidateInstanceIds: matching.map((c) => c.instanceId),
				countRequired: 0,
				choice: {
					kind: 'chooseObjects',
					candidates: matching.map((c) => c.instanceId),
					min: 0,
					max: 1,
					zone: 'library',
					reason: `Transfigure (mana value ${targetMv})`
				},
				continuation: {
					kind: 'handler',
					name: 'p15_wave5_resume',
					data: { stackItemId: item.id, nextStep: 'transfigure_picked' }
				}
			});
			return 'paused';
		}

		if (item.abilityId.startsWith('aura_swap_')) {
			// CR 702.65a: You may exchange this permanent with an Aura card in your hand.
			const auraPerm = controller.battlefield.find(
				(c) =>
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined ||
						(c.objectVersion || 1) === item.sourceObjectVersion)
			);
			if (!auraPerm) return 'done';
			const attachedHostId = auraPerm.attachedToId;
			const handAuras = controller.hand.filter((h) => {
				const hc = effectiveCardForObject(h);
				const res = resolveObjectFaces(hc, { zone: 'hand' });
				return res.types.includes('Enchantment') && res.subtypes.includes('Aura');
			});
			if (handAuras.length === 0) return 'done';

			if (controller.isBot || item.wave5Resume?.step === 'aura_swap_picked') {
				const chosenId =
					item.wave5Resume?.step === 'aura_swap_picked'
						? item.wave5Resume.chosenObjectIds?.[0]
						: handAuras[0].instanceId;
				if (!chosenId) return 'done';
				const chosenAura = controller.hand.find((h) => h.instanceId === chosenId);
				if (!chosenAura) return 'done';
				moveObject(state, auraPerm, 'hand', {
					from: 'anyBattlefield',
					bumpVersion: true,
					leaveBattlefieldReset: true,
					detachAttachments: true,
					commanderRedirect: true,
					ceaseToExist: 'tokens'
				});
				const enterRes = moveObject(state, chosenAura, 'battlefield', {
					from: { player: controller, zone: 'hand' },
					toPlayer: controller,
					controllerId: controller.playerId,
					bumpVersion: true,
					newTimestamp: true,
					beforeInsert: (entering, dest) => {
						if (dest === 'battlefield' && attachedHostId) {
							entering.attachedToId = attachedHostId;
						}
					}
				});
				if (enterRes === 'battlefield' && chosenAura.zone === 'battlefield') {
					noteLayerInputsChanged(state);
				}
				return 'done';
			}

			enqueueChoicePrompt(state, {
				id: host.uid('prm', state),
				playerId: controller.playerId,
				kind: 'chooseObjects',
				title: `${item.card.name} — Aura swap`,
				description: `You may choose an Aura card in your hand to exchange with ${auraPerm.card.name}.`,
				candidateInstanceIds: handAuras.map((h) => h.instanceId),
				countRequired: 0,
				choice: {
					kind: 'chooseObjects',
					candidates: handAuras.map((h) => h.instanceId),
					min: 0,
					max: 1,
					zone: 'hand',
					reason: 'Aura swap'
				},
				continuation: {
					kind: 'handler',
					name: 'p15_wave5_resume',
					data: { stackItemId: item.id, nextStep: 'aura_swap_picked' }
				}
			});
			return 'paused';
		}
	}

	// 2. Wave 5 triggered abilities
	switch (item.wave5Tag) {
		case 'speed_increase': {
			increasePlayerSpeed(state, controller);
			return 'done';
		}

		case 'siege_defeated': {
			// CR 310.11b: Exile Siege, then controller may cast it transformed without paying its mana cost.
			if (!item.wave5Resume) {
				let perm: CardInstance | undefined;
				for (const p of state.players) {
					perm = p.battlefield.find(
						(c) =>
							c.instanceId === item.sourceInstanceId &&
							(item.sourceObjectVersion === undefined ||
								(c.objectVersion || 1) === item.sourceObjectVersion)
					);
					if (perm) break;
				}
				if (!perm) return 'done';
				const res = moveObject(state, perm, 'exile', {
					from: 'anyBattlefield',
					bumpVersion: true,
					leaveBattlefieldReset: true,
					detachAttachments: true,
					ceaseToExist: 'tokens'
				});
				if (res !== 'exile' || perm.zone !== 'exile' || perm.isToken) return 'done';
				const faces = getCardFaces(effectiveCardForObject(perm));
				if (faces.length < 2) return 'done';
				if (controller.isBot) {
					castExiledCardFree(state, controller, perm, {
						faceIndex: 1,
						castTransformed: true
					});
					return 'done';
				}
				item.wave5Resume = {
					step: 'await_cast_decision',
					cardId: perm.instanceId,
					cardVersion: perm.objectVersion || 1
				};
				enqueueChoicePrompt(state, {
					id: host.uid('prm', state),
					playerId: controller.playerId,
					kind: 'yesNo',
					title: `${faces[1].name} — Siege Defeated`,
					description: `Cast ${faces[1].name} transformed without paying its mana cost?`,
					choice: {
						kind: 'yesNo',
						question: `Cast ${faces[1].name} without paying its mana cost?`
					},
					continuation: {
						kind: 'handler',
						name: 'p15_wave5_resume',
						data: { stackItemId: item.id, nextStep: 'siege_cast_answered' }
					}
				});
				return 'paused';
			}
			if (item.wave5Resume.step === 'siege_cast_answered') {
				if (item.wave5Resume.chosenNumber === 1 && item.wave5Resume.cardId) {
					for (const p of state.players) {
						const ex = p.exile.find(
							(c) =>
								c.instanceId === item.wave5Resume?.cardId &&
								(c.objectVersion || 1) === (item.wave5Resume?.cardVersion || 1)
						);
						if (ex) {
							castExiledCardFree(state, controller, ex, {
								faceIndex: 1,
								castTransformed: true
							});
							break;
						}
					}
				}
				return 'done';
			}
			return 'done';
		}

		case 'gift_etb': {
			if (item.giftKind && item.giftRecipientId) {
				deliverPromisedGift(state, item.giftKind, item.giftRecipientId, item.card.name, controller.playerId);
			}
			return 'done';
		}

		case 'increment': {
			// CR 702.191a: Re-check intervening-if on resolution (source is still a creature and manaSpent > current P or T).
			const perm = controller.battlefield.find(
				(c) =>
					c.instanceId === item.sourceInstanceId &&
					(item.sourceObjectVersion === undefined ||
						(c.objectVersion || 1) === item.sourceObjectVersion)
			);
			if (!perm || perm.phasedOut) return 'done';
			const ev = evaluatePermanent(state, perm);
			if (!ev.isCreature) return 'done';
			const spent = item.wave5N ?? 0;
			if (spent > ev.power || spent > ev.toughness) {
				host.addCountersToPermanent(state, perm, '+1/+1', 1);
			}
			return 'done';
		}

		case 'provoke': {
			// CR 702.39a: Untap target creature defending player controls and force it to block source if able.
			const targetRef = item.targets[0];
			if (!targetRef || targetRef.kind !== 'permanent') return 'done';
			let targetPerm: CardInstance | undefined;
			for (const p of state.players) {
				targetPerm = p.battlefield.find((c) => c.instanceId === targetRef.id && !c.phasedOut);
				if (targetPerm) break;
			}
			if (!targetPerm) return 'done';
			const expectedVer = item.targetObjectVersions?.[targetRef.id];
			if (expectedVer !== undefined && (targetPerm.objectVersion || 1) !== expectedVer) {
				return 'done';
			}
			if (!evaluatePermanent(state, targetPerm).isCreature) return 'done';
			host.untapPermanent(state, targetPerm);
			targetPerm.provokeMustBlockId = item.sourceInstanceId;
			host.addLog(
				state,
				'combat',
				`${item.card.name} provokes ${targetPerm.card.name}!`,
				controller.playerId
			);
			return 'done';
		}

		case 'ripple': {
			// CR 702.60a: Reveal top N cards of library; cast any with same name without paying mana cost; put rest on bottom.
			const n = Math.max(0, item.wave5N ?? 4);
			const topCards = controller.library.slice(0, n);
			if (topCards.length === 0) return 'done';
			for (const c of topCards) {
				host.markHandCardRevealedToAll(state, c);
			}
			const sourceName = cardNameOf(item.card);
			const matching = topCards.filter((c) => cardNameOf(c.card) === sourceName);
			const restIds = topCards
				.filter((c) => cardNameOf(c.card) !== sourceName)
				.map((c) => c.instanceId);

			// Cast matching cards without paying their mana costs
			for (const m of matching) {
				const owner = state.players.find((p) => p.playerId === m.ownerId) ?? controller;
				const targetSel = autoSelectFreeSpellTargets(state, controller, m.card, 0);
				if (targetSel.ok) {
					host.finalizeCastSpell(state, controller, m, owner, 'library', {
						targets: targetSel.targets,
						targetsBySpec: targetSel.targetsBySpec,
						xValue: 0,
						faceIndex: 0,
						spellMods: { label: 'Ripple (Free)' }
					});
				} else {
					restIds.push(m.instanceId);
				}
			}

			// Put remaining revealed cards on bottom of library
			for (const rid of restIds) {
				const cardInLib = controller.library.find((c) => c.instanceId === rid);
				if (cardInLib) {
					moveObject(state, cardInLib, 'library', {
						from: { player: controller, zone: 'library' },
						toPlayer: controller,
						insert: 'end',
						emit: false
					});
				}
			}
			return 'done';
		}

		case 'demonstrate': {
			// CR 702.144a: You may copy this spell. If you do, choose an opponent to also copy this spell (opponent's copy on top).
			const origSpell =
				state.stack.find((s) => s.sourceInstanceId === item.sourceInstanceId && s.kind === 'spell') ??
				item.triggerEventStackItem;
			if (!origSpell) return 'done';
			const livingOpponents = state.players.filter(
				(p) => !p.lost && p.playerId !== controller.playerId
			);

			if (!item.wave5Resume && !controller.isBot) {
				item.wave5Resume = { step: 'await_demonstrate_may' };
				enqueueChoicePrompt(state, {
					id: host.uid('prm', state),
					playerId: controller.playerId,
					kind: 'yesNo',
					title: `${item.card.name} — Demonstrate`,
					description: `Copy ${item.card.name}? If you do, an opponent also copies it.`,
					choice: {
						kind: 'yesNo',
						question: `Copy ${item.card.name} with Demonstrate?`
					},
					continuation: {
						kind: 'handler',
						name: 'p15_wave5_resume',
						data: { stackItemId: item.id, nextStep: 'demonstrate_answered' }
					}
				});
				return 'paused';
			}

			if (item.wave5Resume?.step === 'demonstrate_answered' && item.wave5Resume.chosenNumber === 0) {
				return 'done';
			}

			// Create controller's copy first, then opponent's copy on top so opponent's resolves first (CR 702.144a).
			host.copyStackSpell(state, origSpell, controller, true);
			if (livingOpponents.length > 0) {
				const chosenOpponent = livingOpponents[0];
				host.copyStackSpell(state, origSpell, chosenOpponent, true);
			}
			return 'done';
		}

		case 'cipher_cast':
		case 'paradigm_main1': {
			const copyCard = item.wave5Card ?? item.card;
			if (!item.wave5Resume && !controller.isBot) {
				item.wave5Resume = { step: 'await_free_copy' };
				enqueueChoicePrompt(state, {
					id: host.uid('prm', state),
					playerId: controller.playerId,
					kind: 'yesNo',
					title: `${copyCard.name} — Cast Copy`,
					description: `Cast a copy of ${copyCard.name} without paying its mana cost?`,
					choice: {
						kind: 'yesNo',
						question: `Cast a copy of ${copyCard.name} without paying its mana cost?`
					},
					continuation: {
						kind: 'handler',
						name: 'p15_wave5_resume',
						data: { stackItemId: item.id, nextStep: 'free_copy_answered' }
					}
				});
				return 'paused';
			}
			if (item.wave5Resume?.step === 'free_copy_answered' && item.wave5Resume.chosenNumber === 0) {
				return 'done';
			}
			castCardCopyFromExileFree(state, controller, copyCard);
			return 'done';
		}
	}

	return 'done';
}

// ============================================================================
// Prompt Continuation Handlers (Plain JSON-Serializable Continuations)
// ============================================================================

registerPromptHandler('p15_siege_protector_choice', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const battleId = String(data.battleId ?? '');
	const battleVer = Number(data.battleVersion || 1);
	const candidateIds = Array.isArray(data.candidatePlayerIds)
		? data.candidatePlayerIds.map(String)
		: [];
	if (answer.kind !== 'chooseMode' || answer.indices.length === 0) return;
	const chosenPlayerId = candidateIds[answer.indices[0]];
	if (!chosenPlayerId) return;
	for (const p of state.players) {
		const battle = p.battlefield.find(
			(c) => c.instanceId === battleId && (c.objectVersion || 1) === battleVer
		);
		if (battle) {
			battle.protectorId = chosenPlayerId;
			break;
		}
	}
});

registerPromptHandler('p15_read_ahead_choice', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const sagaId = String(data.sagaId ?? '');
	const sagaVer = Number(data.sagaVersion || 1);
	const mult = Number(data.multiplier ?? 1);
	const chosen = answer.kind === 'chooseNumber' ? Math.max(1, answer.n) : 1;
	for (const p of state.players) {
		const saga = p.battlefield.find(
			(c) => c.instanceId === sagaId && (c.objectVersion || 1) === sagaVer
		);
		if (saga) {
			saga.readAheadChosenChapter = chosen;
			const added = chosen * mult;
			if (added > 0) {
				const prev = saga.counters.lore || 0;
				saga.counters.lore = prev + added;
				noteLayerInputsChanged(state);
				getHost().emitEvent(state, {
					kind: 'CounterPlaced',
					objectId: saga.instanceId,
					object: saga,
					counterType: 'lore',
					amount: added,
					previousCount: prev,
					newCount: saga.counters.lore
				});
				getHost().flushTriggers(state);
			}
			break;
		}
	}
});

registerPromptHandler('p15_amplify_choice', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const permId = String(data.permId ?? '');
	const permVer = Number(data.permVersion || 1);
	const amplifyN = Number(data.amplifyN ?? 1);
	const mult = Number(data.multiplier ?? 1);
	if (answer.kind !== 'chooseObjects' || answer.objectIds.length === 0) return;
	const ctrl = state.players.find((p) => p.playerId === prompt.playerId);
	if (!ctrl) return;
	const perm = ctrl.battlefield.find(
		(c) => c.instanceId === permId && (c.objectVersion || 1) === permVer
	);
	if (!perm) return;
	let revealedCount = 0;
	for (const oid of answer.objectIds) {
		const h = ctrl.hand.find((c) => c.instanceId === oid);
		if (h && objectsShareCreatureSubtype(state, perm, h)) {
			getHost().markHandCardRevealedToAll(state, h);
			revealedCount++;
		}
	}
	const added = amplifyN * revealedCount * mult;
	if (added > 0) {
		const prev = perm.counters['+1/+1'] || 0;
		perm.counters['+1/+1'] = prev + added;
		noteLayerInputsChanged(state);
		getHost().emitEvent(state, {
			kind: 'CounterPlaced',
			objectId: perm.instanceId,
			object: perm,
			counterType: '+1/+1',
			amount: added,
			previousCount: prev,
			newCount: perm.counters['+1/+1']
		});
	}
});

registerPromptHandler('p15_cipher_encode_choice', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const exiledId = String(data.exiledId ?? '');
	const exiledVer = Number(data.exiledVersion || 1);
	let exiled: CardInstance | undefined;
	let holder: PlayerGameState | undefined;
	for (const p of state.players) {
		const found = p.exile.find(
			(c) => c.instanceId === exiledId && (c.objectVersion || 1) === exiledVer
		);
		if (found) {
			exiled = found;
			holder = p;
			break;
		}
	}
	if (!exiled || !holder) return;
	if (answer.kind !== 'chooseObjects' || answer.objectIds.length === 0) {
		moveObject(state, exiled, 'graveyard', {
			from: { player: holder, zone: 'exile' },
			bumpVersion: true,
			graveyardReplacement: true,
			commanderRedirect: true
		});
		return;
	}
	const ctrl = state.players.find((p) => p.playerId === prompt.playerId);
	const creature = ctrl?.battlefield.find((c) => c.instanceId === answer.objectIds[0]);
	if (!creature) {
		moveObject(state, exiled, 'graveyard', {
			from: { player: holder, zone: 'exile' },
			bumpVersion: true,
			graveyardReplacement: true,
			commanderRedirect: true
		});
		return;
	}
	exiled.exiledBy = {
		sourceInstanceId: creature.instanceId,
		sourceObjectVersion: creature.objectVersion || 1
	};
	creature.encodedSpellCards ??= [];
	creature.encodedSpellCards.push(exiled.card);
	getHost().addLog(
		state,
		'rule',
		`${ctrl!.username} exiles ${exiled.card.name} encoded on ${creature.card.name} (Cipher).`,
		ctrl!.playerId
	);
});

export function wave5TriggerTargetSpecs(item: StackItem): TargetSpec[] | null {
	if (item.wave5Tag === 'provoke') {
		return [
			{
				kind: 'object',
				filter: {
					zone: 'battlefield',
					types: ['Creature'],
					controllerRef: { k: 'defendingPlayer' }
				},
				min: 0,
				max: 1
			}
		];
	}
	return null;
}

registerPromptHandler('p15_wave5_resume', (state, prompt, answer) => {
	const data = prompt.continuation?.kind === 'handler' ? prompt.continuation.data : undefined;
	if (!data) return;
	const stackItemId = String(data.stackItemId ?? '');
	const nextStep = String(data.nextStep ?? '');
	const item = state.stack.find((s) => s.id === stackItemId);
	if (!item) return;
	item.wave5Resume ??= { step: nextStep };
	item.wave5Resume.step = nextStep;
	if (answer.kind === 'yesNo') {
		item.wave5Resume.chosenNumber = answer.yes ? 1 : 0;
	} else if (answer.kind === 'chooseObjects') {
		item.wave5Resume.chosenObjectIds = [...answer.objectIds];
	} else if (answer.kind === 'chooseNumber') {
		item.wave5Resume.chosenNumber = answer.n;
	}
	getHost().resumeStackItem(state, item.id);
});
