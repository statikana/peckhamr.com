/**
 * Wave 7 — Track P19a runtime module (`effectsWave7.ts`):
 * - Slice P19a.1: Triggered-mana `addMana` completions (`CR 605.1b`, `CR 605.4a`, `CR 106.7`) —
 *   `eventProducedTypes`, `eventProducedColors`, `controlledLandProducedTypes`, `controlledLandProducedColors`,
 *   and until-end-of-turn delayed tap-for-mana triggers (*High Tide*, *Bubbling Muck*, *Pyre Rhymer*).
 * - Slice P19a.2: Multi-sentence coercive hand/graveyard reveal & multi-card selection helpers,
 *   set-life-total (`CR 119.5`), choice-based Layer 5 color / Layer 6 lose-keyword / Layer 7c pump options.
 * - Slice P19a.3: Sacrificed-cost LKI capture & evaluation (`CR 707.10`, `CR 608.2h`), multi-zone
 *   `leastStatAmong` / `greatestStatAmong`, `countedThisWay`, `difference`, and Wave 7 conditions.
 * - Slice P19a.4: `CR 115.7a` mandatory single-target stack redirection & `CR 115.7d–e` optional
 *   multi-target stack redirection, `CR 115.9` single-target stack legality, `CR 614.10` `skipTurn`,
 *   `exileUntil` + `CR 609.4b` `spendManaAsAnyColor`, and delayed next-spell copy triggers (`CR 603.7`, `CR 707.10`).
 *
 * Strictly adheres to ENGINE_INVARIANTS.md:
 * - Zero rules-text reads at runtime.
 * - Zero card-name comparisons at runtime.
 * - Zero direct zone mutations (all zone moves route through `runtime/zones.ts` `moveObject`).
 * - Zero unbounded loops; 100% plain-JSON state & continuations; deterministic PRNG (`nextRandom`).
 */

import { cardManaSteps } from '../compiler/index.ts';
import type {
	Amount,
	Condition,
	EffectParams,
	EffectStep,
	ObjectFilter,
	PlayerFilter,
	Selector,
	TargetSpec
} from '../ir.ts';
import { evaluatePermanent, inspectCardContinuousBreakdown } from '../ruleTree.ts';
import { effectiveCardForObject } from '../scryfall.ts';
import type {
	CardInstance,
	ChoiceAnswer,
	DelayedNextSpellCopyEntry,
	DelayedTapManaTriggerEntry,
	GameState,
	ManaColor,
	PlayerGameState,
	SacrificedCostLkiEntry,
	ScryfallCard,
	StackItem,
	TargetRef,
	ZoneType
} from '../types.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { emitEvent } from './events.ts';
import { executeCastFree, type P16aStepHost } from './effectsWave6.ts';
import { activeAbilityDefs, instanceFaceOptions, resolveObjectFaces } from './faces.ts';
import { addManaToPlayerPool } from './mana.ts';
import {
	matchesObjectFilter,
	objectManaValue,
	objectPower,
	objectToughness,
	type FilterContext
} from './objectFilter.ts';
import { nextRandom } from './random.ts';
import {
	buildColorChoiceOptions,
	chooseBotBestColor
} from './tuckFreezeChosen.ts';
import { flushTriggers } from './triggers.ts';
import { moveObject } from './zones.ts';

const FIVE_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
const ALL_MANA_TYPES: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
const BASIC_LAND_COLORS: ReadonlyArray<[string, ManaColor]> = [
	['Plains', 'W'],
	['Island', 'U'],
	['Swamp', 'B'],
	['Mountain', 'R'],
	['Forest', 'G']
];

// ---- Runtime Host Registration --------------------------------------------------------------

export interface P19aStackRetargetSlot {
	spec: TargetSpec;
	originalTargets: TargetRef[];
	legalCandidates: TargetRef[];
	zone: ZoneType | 'player';
}

export interface P19aRuntimeHost {
	uid: (prefix: string, state: GameState) => string;
	addLog: (
		state: GameState,
		kind: 'rule' | 'cast' | 'combat' | 'trigger' | 'life' | 'sba' | 'system',
		text: string,
		actorId?: string
	) => void;
	findPermanent: (
		state: GameState,
		id: string
	) => { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null;
	triggerOnEtb: (state: GameState, controller: PlayerGameState, inst: CardInstance) => void;
	getStackItemRetargetSlots: (
		state: GameState,
		orig: StackItem,
		controllerId: string
	) => P19aStackRetargetSlot[];
	validateStackItemRetarget: (
		state: GameState,
		orig: StackItem,
		controllerId: string,
		targetsBySpec: TargetRef[][]
	) => boolean;
	chooseBotStackItemRetarget: (
		state: GameState,
		bot: PlayerGameState,
		orig: StackItem,
		slots: P19aStackRetargetSlot[],
		copyIndex: number
	) => { targets: TargetRef[]; targetsBySpec: TargetRef[][] };
	pushCopiedStackItem: (
		state: GameState,
		controller: PlayerGameState,
		orig: StackItem,
		targets: TargetRef[],
		targetsBySpec: TargetRef[][] | undefined,
		opts?: { exceptColors?: ManaColor[]; nonLegendary?: boolean }
	) => StackItem;
	captureTargetObjectVersions: (
		state: GameState,
		targets: TargetRef[]
	) => Record<string, number> | undefined;
}

let p19aHost: P19aRuntimeHost | null = null;

export function registerP19aRuntimeHost(host: P19aRuntimeHost): void {
	p19aHost = host;
}

export function getP19aRuntimeHost(): P19aRuntimeHost | null {
	return p19aHost;
}

export interface P19aStepHost {
	state: GameState;
	you: PlayerGameState;
	sourceId: string;
	sourceCard: ScryfallCard;
	title: string;
	item: StackItem;
	stepIndex: number;
	subStepIndex: number;
	canPause: boolean;
	answers: Record<string, ChoiceAnswer>;
	targets: TargetRef[];
	eventObjectId?: string;
	eventPlayerId?: string;
	sourceChosenCardName?: string;
	amount: (a: Amount | undefined, fallback?: number) => number;
	evalCondition: (c: Condition) => boolean;
	objects: (sel: Selector) => CardInstance[];
	players: (sel: Selector) => PlayerGameState[];
	targetsForSpecIndex: (idx: number) => TargetRef[];
	locate: (
		id: string
	) => { inst: CardInstance; player: PlayerGameState; zone: ZoneType } | undefined;
	bind: (step: EffectStep, objs: CardInstance[]) => void;
	recordEffectAmount: (n: number) => void;
	recordCountedKind: (
		kind: NonNullable<Extract<Amount, { k: 'countedThisWay' }>['kind']>,
		n: number
	) => void;
	saveFrame: (
		stepIndex: number,
		answers: Record<string, ChoiceAnswer>,
		phase: 'optional' | 'step' | 'afterStep',
		subStepIndex: number
	) => StackItem;
	pauseForChoice: (
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: ZoneType,
		defaultObjectIds?: string[],
		answerKey?: string
	) => void;
	pauseForYesNo: (
		chooser: PlayerGameState,
		title: string,
		description: string,
		answerKey: string,
		labels?: { yesLabel?: string; noLabel?: string }
	) => void;
	markPaused: () => void;
	gainLifeForPlayer: (pl: PlayerGameState, amount: number) => void;
	loseLifeForPlayer: (pl: PlayerGameState, amount: number) => void;
	p16aHost: () => P16aStepHost;
}

// ---- Slice P19a.1: Triggered-Mana & Land-Produced Mana (CR 605.1b, CR 106.7) ----------------

function commanderColorsOf(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>();
	for (const col of player.commanderColorIdentity ?? []) {
		if (col !== 'C') set.add(col);
	}
	const zones: Array<readonly CardInstance[]> = [
		player.command,
		player.battlefield,
		player.graveyard,
		player.exile,
		player.hand,
		player.library
	];
	for (const z of zones) {
		for (const c of z) {
			if (!c.isCommander || c.ownerId !== player.playerId) continue;
			for (const col of c.card.colorIdentity) {
				if (col !== 'C') set.add(col);
			}
		}
	}
	return FIVE_COLORS.filter((c) => set.has(c));
}

/**
 * CR 106.7: Computes the mana types (`W, U, B, R, G, C` when `includeColorless`, else `W..G`)
 * that a single permanent on the battlefield could produce right now.
 */
export function permanentCouldProduceManaTypes(
	state: GameState,
	controller: PlayerGameState,
	perm: CardInstance,
	includeColorless: boolean
): ManaColor[] {
	if (perm.phasedOut) return [];
	const ev = evaluatePermanent(state, perm);
	const out = new Set<ManaColor>();
	const allow = (c: ManaColor) => {
		if (c !== 'C' || includeColorless) out.add(c);
	};
	if (ev.isLand) {
		for (const [sub, col] of BASIC_LAND_COLORS) {
			if (ev.hasSubType(sub) || ev.typeLine.includes(sub)) allow(col);
		}
	}
	const bd = inspectCardContinuousBreakdown(perm, state);
	if (bd.items.some((i) => !i.removed && i.canonicalKey === 'mana_any')) {
		for (const c of FIVE_COLORS) allow(c);
	}
	if (!ev.losesAllAbilities) {
		for (const step of cardManaSteps(effectiveCardForObject(perm))) {
			if (step.params?.mana) {
				for (const c of step.params.mana) allow(c);
			}
			if (step.params?.manaWithChosenColor) {
				for (const c of step.params.manaWithChosenColor) allow(c);
				if (perm.chosenColor) allow(perm.chosenColor);
			}
			if (step.params?.manaOrChosenColor) {
				for (const c of step.params.manaOrChosenColor) allow(c);
				if (perm.chosenColor) allow(perm.chosenColor);
			}
			if (step.params?.manaBundles) {
				for (const b of step.params.manaBundles) {
					for (const c of b) allow(c);
				}
			}
			if (step.params?.manaCombinationColors) {
				const cols =
					step.params.manaCombinationColors === 'any'
						? FIVE_COLORS
						: step.params.manaCombinationColors;
				for (const c of cols) allow(c);
			}
			const ch = step.params?.manaChoice;
			if (!ch) continue;
			if (Array.isArray(ch)) {
				for (const c of ch) allow(c);
			} else if (ch === 'any') {
				for (const c of FIVE_COLORS) allow(c);
			} else if (ch === 'commanderIdentity') {
				for (const c of commanderColorsOf(controller)) allow(c);
			} else if (ch === 'chosenColor') {
				if (perm.chosenColor) allow(perm.chosenColor);
			}
		}
	}
	return ALL_MANA_TYPES.filter((c) => out.has(c));
}

export function resolveP19aManaChoiceColors(
	state: GameState,
	controller: PlayerGameState,
	choice:
		| 'eventProducedTypes'
		| 'eventProducedColors'
		| 'controlledLandProducedTypes'
		| 'controlledLandProducedColors',
	eventObjectId?: string
): ManaColor[] {
	if (choice === 'eventProducedTypes' || choice === 'eventProducedColors') {
		const includeC = choice === 'eventProducedTypes';
		let produced: ManaColor[] | undefined;
		if (eventObjectId) {
			for (const pl of state.players) {
				const found =
					pl.battlefield.find((c) => c.instanceId === eventObjectId) ??
					pl.graveyard.find((c) => c.instanceId === eventObjectId) ??
					pl.exile.find((c) => c.instanceId === eventObjectId);
				if (found?.lastManaProduced && found.lastManaProduced.length > 0) {
					produced = found.lastManaProduced;
					break;
				}
			}
		}
		if (!produced || produced.length === 0) {
			produced = state.lastTappedManaProduced;
		}
		if ((!produced || produced.length === 0) && eventObjectId) {
			for (const pl of state.players) {
				const perm = pl.battlefield.find((c) => c.instanceId === eventObjectId);
				if (perm) {
					produced = permanentCouldProduceManaTypes(state, pl, perm, includeC);
					break;
				}
			}
		}
		const set = new Set<ManaColor>();
		for (const c of produced ?? []) {
			if (c !== 'C' || includeC) set.add(c);
		}
		return ALL_MANA_TYPES.filter((c) => set.has(c));
	}

	const includeC = choice === 'controlledLandProducedTypes';
	const set = new Set<ManaColor>();
	for (const perm of controller.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.isLand) continue;
		for (const c of permanentCouldProduceManaTypes(state, controller, perm, includeC)) {
			set.add(c);
		}
	}
	return ALL_MANA_TYPES.filter((c) => set.has(c));
}

export function executeDelayedTapManaTriggerP19a(host: P19aStepHost, step: EffectStep): void {
	const spec = step.params?.delayedTapManaSpec;
	const rt = getP19aRuntimeHost();
	if (!spec || !rt) return;
	const entry: DelayedTapManaTriggerEntry = {
		id: rt.uid('dtapmana', host.state),
		controllerId: host.you.playerId,
		sourceName: host.sourceCard.name,
		who: spec.who,
		...(spec.landSubtype ? { landSubtype: spec.landSubtype } : {}),
		mana: [...spec.mana],
		recipient: spec.recipient
	};
	(host.state.delayedTapManaTriggers ??= []).push(entry);
	rt.addLog(
		host.state,
		'rule',
		`${host.title} created a delayed mana trigger until end of turn (CR 605.1b).`,
		host.you.playerId
	);
}

/**
 * CR 605.1b, 605.4a: Immediately resolves active until-end-of-turn delayed tap-for-mana triggers
 * (e.g. High Tide, Bubbling Muck, Pyre Rhymer) without using the stack.
 */
export function resolveP19aDelayedTappedManaTriggers(
	state: GameState,
	tappingPlayer: PlayerGameState,
	perm: CardInstance
): void {
	const list = state.delayedTapManaTriggers;
	if (!list || list.length === 0) return;
	const ev = evaluatePermanent(state, perm);
	if (!ev.isLand) return;
	const rt = getP19aRuntimeHost();
	for (let i = 0; i < list.length; i++) {
		const entry = list[i];
		if (entry.who === 'you' && tappingPlayer.playerId !== entry.controllerId) continue;
		if (entry.landSubtype && !ev.hasSubType(entry.landSubtype)) continue;
		const recipient =
			entry.recipient === 'tappingPlayer'
				? tappingPlayer
				: state.players.find((pl) => pl.playerId === entry.controllerId);
		if (!recipient || recipient.lost) continue;
		for (const col of entry.mana) {
			addManaToPlayerPool(recipient, col, 1);
		}
		rt?.addLog(
			state,
			'trigger',
			`${entry.sourceName}: ${recipient.username} added ${entry.mana.map((c) => `{${c}}`).join('')} (CR 605.4a).`,
			recipient.playerId
		);
	}
}

// ---- Slice P19a.3: Sacrificed-Cost LKI (CR 707.10) & Wave 7 Amounts / Conditions -----------

export function captureP19aSacrificedCostLki(
	state: GameState,
	perm: CardInstance
): SacrificedCostLkiEntry {
	const ev = evaluatePermanent(state, perm);
	const face = resolveObjectFaces(effectiveCardForObject(perm), instanceFaceOptions(perm, 'battlefield'));
	const types: string[] = [];
	for (const t of ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery']) {
		if (ev.effectiveTypeLine.includes(t)) types.push(t);
	}
	const dashIdx = ev.effectiveTypeLine.indexOf('—');
	const subtypes =
		dashIdx >= 0
			? ev.effectiveTypeLine
					.slice(dashIdx + 1)
					.trim()
					.split(/\s+/)
					.filter(Boolean)
			: [...face.subtypes];
	return {
		instanceId: perm.instanceId,
		power: ev.power,
		toughness: ev.toughness,
		manaValue: objectManaValue(state, perm),
		colors: [...ev.colors],
		types,
		subtypes
	};
}

export function computeP19aMultiZoneStatAggregate(
	state: GameState,
	filter: ObjectFilter,
	stat: 'power' | 'toughness' | 'manaValue',
	mode: 'greatest' | 'least' | 'total',
	ctx: FilterContext
): number {
	const zones: ZoneType[] = filter.zone
		? Array.isArray(filter.zone)
			? (filter.zone.filter((z) => z !== 'stack') as ZoneType[])
			: filter.zone === 'stack'
				? []
				: [filter.zone]
		: ['battlefield'];
	let foundAny = false;
	let best = mode === 'least' ? Infinity : 0;
	let sum = 0;

	for (const pl of state.players) {
		if (pl.lost) continue;
		for (const z of zones) {
			const arr = pl[z as 'battlefield' | 'hand' | 'graveyard' | 'exile' | 'command' | 'library'];
			if (!arr) continue;
			for (const obj of arr) {
				if (z === 'battlefield' && obj.phasedOut) continue;
				const subFilter: ObjectFilter = { ...filter, zone: z };
				if (!matchesObjectFilter(obj, subFilter, { ...ctx, zone: z })) continue;
				let val = 0;
				if (stat === 'manaValue') {
					val = objectManaValue(state, obj);
				} else if (z === 'battlefield') {
					val =
						stat === 'power'
							? (objectPower(state, obj) ?? 0)
							: (objectToughness(state, obj) ?? 0);
				} else {
					const fv = resolveObjectFaces(effectiveCardForObject(obj), instanceFaceOptions(obj, z));
					val = stat === 'power' ? (fv.power ?? 0) : (fv.toughness ?? 0);
				}
				foundAny = true;
				sum += val;
				if (mode === 'greatest') {
					if (val > best) best = val;
				} else if (mode === 'least') {
					if (val < best) best = val;
				}
			}
		}
	}

	if (!foundAny) return 0;
	if (mode === 'total') return Math.max(0, sum);
	return Math.max(0, best);
}

export function evaluateP19aAmount(
	amount: Amount,
	ctx: FilterContext,
	evalSub: (a: Amount) => number
): number | null {
	switch (amount.k) {
		case 'sacrificedCostStat': {
			const lkis = ctx.stackItem?.sacrificedCostLki;
			if (!lkis || lkis.length === 0) return 0;
			if (amount.stat === 'colorsCount') {
				const cols = new Set<ManaColor>();
				for (const e of lkis) {
					for (const c of e.colors) if (c !== 'C') cols.add(c);
				}
				return cols.size;
			}
			let total = 0;
			for (const e of lkis) {
				if (amount.stat === 'power') total += e.power;
				else if (amount.stat === 'toughness') total += e.toughness;
				else if (amount.stat === 'manaValue') total += e.manaValue;
			}
			return Math.max(0, total);
		}
		case 'leastStatAmong':
			return computeP19aMultiZoneStatAggregate(
				ctx.state,
				amount.filter,
				amount.stat,
				'least',
				ctx
			);
		case 'countedThisWay':
			return ctx.stackItem?.lastCountedByKind?.[amount.kind] ?? 0;
		case 'difference': {
			const l = evalSub(amount.left);
			const r = evalSub(amount.right);
			return Math.max(0, l - r);
		}
		default:
			return null;
	}
}

export function evaluateP19aCondition(cond: Condition, ctx: FilterContext): boolean | null {
	switch (cond.k) {
		case 'anyGraveyardAtLeast':
			return ctx.state.players.some((pl) => !pl.lost && pl.graveyard.length >= cond.min);
		case 'controlledTargetAtResolution':
			return Boolean(ctx.stackItem?.targetWasControlledByActor?.[cond.targetIndex]);
		case 'abilityActivatedCountThisTurn': {
			const abId = ctx.stackItem?.abilityId;
			let src = ctx.source;
			if (!src && ctx.stackItem?.sourceInstanceId) {
				for (const pl of ctx.state.players) {
					const found = pl.battlefield.find(
						(c) => c.instanceId === ctx.stackItem!.sourceInstanceId
					);
					if (found) {
						src = found;
						break;
					}
				}
			}
			if (!src || !abId) return false;
			return (src.abilityActivationCountsThisTurn?.[abId] ?? 0) >= cond.min;
		}
		default:
			return null;
	}
}

// ---- Stack Filter Legality Helpers (CR 115.9) -----------------------------------------------

function matchesPlayerFilterForStackTarget(
	state: GameState,
	targetPlayerId: string,
	pf: PlayerFilter,
	controllerId: string
): boolean {
	const pl = state.players.find((p) => p.playerId === targetPlayerId);
	if (!pl || pl.lost) return false;
	if (pf.relation === 'you') return targetPlayerId === controllerId;
	if (pf.relation === 'opponent' || pf.relation === 'each_opponent') {
		return targetPlayerId !== controllerId;
	}
	return true;
}

function stackTargetRefMatchesObjectFilter(
	state: GameState,
	tRef: TargetRef,
	filter: ObjectFilter,
	ctx: FilterContext
): boolean {
	if (tRef.kind === 'permanent') {
		for (const pl of state.players) {
			if (pl.lost) continue;
			const perm = pl.battlefield.find((c) => c.instanceId === tRef.id);
			if (perm && !perm.phasedOut) {
				return matchesObjectFilter(perm, filter, ctx);
			}
		}
		return false;
	}
	if (tRef.kind === 'graveyard_card' || tRef.kind === 'card_in_graveyard') {
		for (const pl of state.players) {
			const card = pl.graveyard.find((c) => c.instanceId === tRef.id);
			if (card) {
				return matchesObjectFilter(card, { ...filter, zone: 'graveyard' }, { ...ctx, zone: 'graveyard' });
			}
		}
		return false;
	}
	if (tRef.kind === 'exile_card') {
		for (const pl of state.players) {
			const card = pl.exile.find((c) => c.instanceId === tRef.id);
			if (card) {
				return matchesObjectFilter(card, { ...filter, zone: 'exile' }, { ...ctx, zone: 'exile' });
			}
		}
		return false;
	}
	return false;
}

export function matchesP19aStackTargetSpec(
	state: GameState,
	stk: StackItem,
	spec: TargetSpec,
	ctx: FilterContext
): boolean {
	if (spec.withSingleTarget || spec.filter.withSingleTarget) {
		// CR 115.9a: "with a single target" checks that the stack object currently has exactly 1 target.
		if (stk.targets.length !== 1) return false;
	}
	if (spec.filter.singleTargetFilter) {
		if (stk.targets.length !== 1) return false;
		if (!stackTargetRefMatchesObjectFilter(state, stk.targets[0], spec.filter.singleTargetFilter, ctx)) {
			return false;
		}
	}
	if (spec.filter.singleTargetPlayer) {
		if (stk.targets.length !== 1 || stk.targets[0].kind !== 'player') return false;
		if (
			!matchesPlayerFilterForStackTarget(
				state,
				stk.targets[0].id,
				spec.filter.singleTargetPlayer,
				ctx.controllerId
			)
		) {
			return false;
		}
	}
	if (spec.filter.targetsFilter) {
		const hit = stk.targets.some((t) =>
			stackTargetRefMatchesObjectFilter(state, t, spec.filter.targetsFilter!, ctx)
		);
		if (!hit) return false;
	}
	if (spec.filter.targetsPlayerFilter) {
		const hit = stk.targets.some(
			(t) =>
				t.kind === 'player' &&
				matchesPlayerFilterForStackTarget(
					state,
					t.id,
					spec.filter.targetsPlayerFilter!,
					ctx.controllerId
				)
		);
		if (!hit) return false;
	}
	return true;
}

// ---- Slice P19a.4: CR 115.7 Stack Target Redirection ----------------------------------------

function emitRetargetEventsP19a(
	state: GameState,
	stk: StackItem,
	prevTargets: TargetRef[],
	newTargets: TargetRef[]
): void {
	const prevKeys = new Set(prevTargets.map((t) => `${t.kind}:${t.id}`));
	for (const nt of newTargets) {
		if (prevKeys.has(`${nt.kind}:${nt.id}`)) continue;
		if (nt.kind === 'permanent') {
			for (const pl of state.players) {
				const perm = pl.battlefield.find((c) => c.instanceId === nt.id);
				if (perm) {
					emitEvent(state, {
						kind: 'BecameTarget',
						objectId: perm.instanceId,
						object: perm,
						controllerId: stk.controllerId,
						by: stk.kind === 'spell' ? 'spell' : 'ability',
						stackItemId: stk.id
					});
					break;
				}
			}
		} else if (nt.kind === 'player') {
			emitEvent(state, {
				kind: 'PlayerTargeted',
				targetPlayerId: nt.id,
				controllerId: stk.controllerId,
				by: stk.kind === 'spell' ? 'spell' : 'ability',
				stackItemId: stk.id
			});
		}
	}
}

function applyNewTargetsToStackItem(
	state: GameState,
	rt: P19aRuntimeHost,
	stk: StackItem,
	newTargetsBySpec: TargetRef[][]
): void {
	const prevTargets = stk.targets.map((t) => ({ ...t }));
	const flatTargets = newTargetsBySpec.flat().map((t) => ({ ...t }));
	// CR 115.7f: When changing targets of a spell/ability with divided damage/counters, preserve per-slot division amounts.
	if (
		stk.targetDivisions &&
		Object.keys(stk.targetDivisions).length > 0 &&
		flatTargets.length === prevTargets.length
	) {
		const nextDiv: Record<string, number> = {};
		for (let i = 0; i < flatTargets.length; i++) {
			const prevAmt = stk.targetDivisions[prevTargets[i].id];
			if (prevAmt !== undefined) nextDiv[flatTargets[i].id] = prevAmt;
		}
		stk.targetDivisions = nextDiv;
	}
	stk.targets = flatTargets;
	stk.targetsBySpec = newTargetsBySpec.map((slot) => slot.map((t) => ({ ...t })));
	stk.targetObjectVersions = rt.captureTargetObjectVersions(state, flatTargets);
	emitRetargetEventsP19a(state, stk, prevTargets, flatTargets);
}

function pickBotSingleRedirectCandidate(
	state: GameState,
	you: PlayerGameState,
	stk: StackItem,
	candidates: TargetRef[]
): TargetRef {
	const stkControlledByOpponent = stk.controllerId !== you.playerId;
	// If an opponent cast/activated it, assume beneficial if targeting themselves/their permanents, harmful if targeting us/ours.
	const origTarget = stk.targets[0];
	let seemsHarmful = true;
	if (origTarget) {
		if (origTarget.kind === 'player') {
			seemsHarmful = stkControlledByOpponent
				? origTarget.id === you.playerId
				: origTarget.id !== you.playerId;
		} else if (origTarget.kind === 'permanent') {
			const ownerPl = state.players.find((p) =>
				p.battlefield.some((c) => c.instanceId === origTarget.id)
			);
			if (ownerPl) {
				seemsHarmful = stkControlledByOpponent
					? ownerPl.playerId === you.playerId
					: ownerPl.playerId !== you.playerId;
			}
		}
	}
	for (const c of candidates) {
		if (c.kind === 'player') {
			if (seemsHarmful && c.id !== you.playerId) return c;
			if (!seemsHarmful && c.id === you.playerId) return c;
		} else if (c.kind === 'permanent') {
			const pl = state.players.find((p) => p.battlefield.some((perm) => perm.instanceId === c.id));
			if (pl) {
				if (seemsHarmful && pl.playerId !== you.playerId) return c;
				if (!seemsHarmful && pl.playerId === you.playerId) return c;
			}
		}
	}
	return candidates[0];
}

function resolveStackItemsForRedirect(host: P19aStepHost, sel: Selector): StackItem[] {
	const s = host.state;
	if (sel.k === 'target') {
		const refs = host.targetsForSpecIndex(sel.index);
		const out: StackItem[] = [];
		for (const r of refs) {
			if (r.kind !== 'stack') continue;
			const found = s.stack.find(
				(it) => it.id !== host.item.id && (it.id === r.id || it.sourceInstanceId === r.id)
			);
			if (found) out.push(found);
		}
		return out;
	}
	if (sel.k === 'eventObject' && host.eventObjectId) {
		const found = s.stack.find(
			(it) =>
				it.id !== host.item.id &&
				(it.id === host.eventObjectId || it.sourceInstanceId === host.eventObjectId)
		);
		return found ? [found] : [];
	}
	if (sel.k === 'all') {
		const stackKind = sel.filter.stackKind ?? 'spellOrAbility';
		return s.stack.filter((stk) => {
			if (stk.id === host.item.id) return false;
			if (stackKind === 'spell' && stk.kind !== 'spell') return false;
			if (stackKind === 'ability' && stk.kind !== 'activated' && stk.kind !== 'triggered') {
				return false;
			}
			if (sel.filter.controller === 'opponent' && stk.controllerId === host.you.playerId) {
				return false;
			}
			if (sel.filter.controller === 'you' && stk.controllerId !== host.you.playerId) {
				return false;
			}
			return stk.targets.length > 0;
		});
	}
	return [];
}

export function executeRedirectTargetsP19a(host: P19aStepHost, step: EffectStep): void {
	const rt = getP19aRuntimeHost();
	const spec = step.params?.redirectSpec;
	if (!rt || !spec) return;
	const s = host.state;
	const you = host.you;

	const stackItems = resolveStackItemsForRedirect(host, step.subject);
	if (stackItems.length === 0) return;

	if (spec.mode === 'changeSingleTarget') {
		const stk = stackItems[0];
		// CR 115.7a: Must currently have a single target; if not or no other legal target exists, target is unchanged.
		if (stk.targets.length !== 1) return;
		const origTarget = stk.targets[0];
		const slots = rt.getStackItemRetargetSlots(s, stk, stk.controllerId);
		const activeSlotIdx = slots.findIndex((sl) => sl.originalTargets.length === 1);
		if (activeSlotIdx < 0) return;
		const sl = slots[activeSlotIdx];
		let altCandidates = sl.legalCandidates.filter(
			(c) => !(c.kind === origTarget.kind && c.id === origTarget.id)
		);
		if (spec.forceTargetSelf) {
			altCandidates = altCandidates.filter(
				(c) => c.kind === 'permanent' && c.id === host.sourceId
			);
		}
		if (altCandidates.length === 0) {
			rt.addLog(
				s,
				'rule',
				`${host.title}: No other legal target exists for ${stk.title}; target remains ${origTarget.label} (CR 115.7a).`,
				you.playerId
			);
			return;
		}

		let chosenRef: TargetRef = altCandidates[0];
		if (altCandidates.length > 1) {
			if (you.isBot || !host.canPause) {
				chosenRef = pickBotSingleRedirectCandidate(s, you, stk, altCandidates);
			} else {
				const ansKey = `p19a_redirect_single:${host.stepIndex}:${stk.id}`;
				const ans = host.answers[ansKey];
				if (!ans || ans.kind !== 'chooseObjects') {
					const zone: ZoneType = sl.zone === 'player' ? 'battlefield' : sl.zone;
					host.pauseForChoice(
						you,
						`${host.title} — Change Target of ${stk.title}`,
						`Choose a new target for ${stk.title} (currently targeting ${origTarget.label}).`,
						altCandidates.map((c) => c.id),
						1,
						1,
						zone,
						[altCandidates[0].id],
						ansKey
					);
					return;
				}
				const pickedId = ans.objectIds[0];
				const matched = altCandidates.find((c) => c.id === pickedId);
				if (matched) chosenRef = matched;
			}
		}

		const nextBySpec = slots.map((slot, idx) =>
			idx === activeSlotIdx ? [{ ...chosenRef }] : slot.originalTargets.map((t) => ({ ...t }))
		);
		if (!rt.validateStackItemRetarget(s, stk, stk.controllerId, nextBySpec)) return;
		applyNewTargetsToStackItem(s, rt, stk, nextBySpec);
		rt.addLog(
			s,
			'rule',
			`${you.username} changed the target of ${stk.title} from ${origTarget.label} to ${chosenRef.label} (CR 115.7a).`,
			you.playerId
		);
		flushTriggers(s);
		return;
	}

	// CR 115.7d–e: "You may choose new targets for target spell/ability [or any number of spells/abilities]."
	for (let k = 0; k < stackItems.length; k++) {
		const stk = stackItems[k];
		const doneKey = `p19a_redirect_done:${host.stepIndex}:${stk.id}`;
		if (host.answers[doneKey]) continue;
		if (stk.targets.length === 0) {
			host.answers[doneKey] = { kind: 'yesNo', yes: false };
			continue;
		}
		const slots = rt.getStackItemRetargetSlots(s, stk, stk.controllerId);
		const sameRefList = (a: TargetRef[], b: TargetRef[]) =>
			a.length === b.length &&
			a.every((x, idx) => x.kind === b[idx]?.kind && x.id === b[idx]?.id);
		const hasAlternative =
			slots.length > 0 &&
			slots.some((sl) => {
				if (sl.spec.min === 0 && sl.originalTargets.length > 0) return true;
				if (sl.legalCandidates.length < sl.spec.min) return false;
				if (sl.legalCandidates.length > sl.originalTargets.length) return true;
				return !sameRefList(sl.legalCandidates, sl.originalTargets);
			});
		if (!hasAlternative) {
			host.answers[doneKey] = { kind: 'yesNo', yes: false };
			continue;
		}

		if (you.isBot || !host.canPause) {
			const nextBySpec: TargetRef[][] = slots.map((sl) => {
				if (sl.spec.min === 1 && sl.spec.max === 1 && sl.legalCandidates.length > 0) {
					const best = pickBotSingleRedirectCandidate(s, you, stk, sl.legalCandidates);
					return [{ ...best }];
				}
				return sl.originalTargets.map((t) => ({ ...t }));
			});
			if (
				rt.validateStackItemRetarget(s, stk, stk.controllerId, nextBySpec) &&
				!sameRefList(nextBySpec.flat(), stk.targets)
			) {
				applyNewTargetsToStackItem(s, rt, stk, nextBySpec);
				rt.addLog(
					s,
					'rule',
					`${you.username} chose new targets for ${stk.title}: ${stk.targets.map((t) => t.label).join(', ')} (CR 115.7d).`,
					you.playerId
				);
			}
			host.answers[doneKey] = { kind: 'yesNo', yes: true };
			continue;
		}

		const ynKey = `p19a_redirect_yn:${host.stepIndex}:${stk.id}`;
		const ynAns = host.answers[ynKey];
		if (!ynAns || ynAns.kind !== 'yesNo') {
			const curDesc = stk.targets.map((t) => t.label).join(', ');
			host.pauseForYesNo(
				you,
				`${host.title} — Retarget ${stk.title}`,
				`Choose new targets for ${stk.title}? (Current target${stk.targets.length === 1 ? '' : 's'}: ${curDesc})`,
				ynKey,
				{ yesLabel: 'Choose new targets', noLabel: 'Keep current targets' }
			);
			return;
		}
		if (!ynAns.yes) {
			host.answers[doneKey] = { kind: 'yesNo', yes: false };
			continue;
		}

		const nextBySpec: TargetRef[][] = [];
		for (let sIdx = 0; sIdx < slots.length; sIdx++) {
			const sl = slots[sIdx];
			if (sl.spec.min > 0 && sl.legalCandidates.length < sl.spec.min) {
				nextBySpec.push(sl.originalTargets.map((t) => ({ ...t })));
				continue;
			}
			const pool: TargetRef[] = [...sl.legalCandidates];
			for (const origT of sl.originalTargets) {
				if (!pool.some((c) => c.kind === origT.kind && c.id === origT.id)) {
					pool.push({ ...origT });
				}
			}
			if (pool.length === 0) {
				nextBySpec.push([]);
				continue;
			}
			const maxPick = Math.min(sl.spec.max, pool.length);
			const slotKey = `p19a_redirect_slot:${host.stepIndex}:${stk.id}:${sIdx}`;
			const slotAns = host.answers[slotKey];
			if (!slotAns || slotAns.kind !== 'chooseObjects') {
				const altCands = sl.legalCandidates.filter(
					(c) => !sl.originalTargets.some((o) => o.kind === c.kind && o.id === c.id)
				);
				const defaultIds = (
					altCands.length >= sl.spec.min
						? altCands.slice(0, Math.max(1, sl.spec.min))
						: pool.slice(0, sl.spec.min)
				).map((c) => c.id);
				const zone: ZoneType = sl.zone === 'player' ? 'battlefield' : sl.zone;
				host.pauseForChoice(
					you,
					`${host.title} — Target Slot ${sIdx + 1} for ${stk.title}`,
					`Choose ${sl.spec.min === maxPick ? maxPick : `${sl.spec.min}–${maxPick}`} target(s) for ${stk.title}.`,
					pool.map((c) => c.id),
					sl.spec.min,
					maxPick,
					zone,
					defaultIds,
					slotKey
				);
				return;
			}
			const pickedRefs: TargetRef[] = [];
			for (const id of slotAns.objectIds) {
				const matched = pool.find((c) => c.id === id);
				if (matched && !pickedRefs.some((r) => r.kind === matched.kind && r.id === matched.id)) {
					pickedRefs.push({ ...matched });
				}
			}
			nextBySpec.push(
				pickedRefs.length >= sl.spec.min && pickedRefs.length <= sl.spec.max
					? pickedRefs
					: sl.originalTargets.map((t) => ({ ...t }))
			);
		}

		if (rt.validateStackItemRetarget(s, stk, stk.controllerId, nextBySpec)) {
			applyNewTargetsToStackItem(s, rt, stk, nextBySpec);
			rt.addLog(
				s,
				'rule',
				`${you.username} chose new targets for ${stk.title}: ${stk.targets.map((t) => t.label).join(', ')} (CR 115.7d).`,
				you.playerId
			);
		}
		host.answers[doneKey] = { kind: 'yesNo', yes: true };
	}
	flushTriggers(s);
}

// ---- CR 614.10: "You skip your next turn" ---------------------------------------------------

export function executeSkipTurnP19a(host: P19aStepHost, step: EffectStep): void {
	const rt = getP19aRuntimeHost();
	const count = Math.max(1, host.amount(step.amount, 1));
	const targets =
		step.subject.k === 'player' || step.subject.k === 'playerRef'
			? host.players(step.subject)
			: [host.you];
	for (const pl of targets) {
		if (pl.lost) continue;
		pl.skipNextTurns = (pl.skipNextTurns ?? 0) + count;
		rt?.addLog(
			host.state,
			'rule',
			`${pl.username} will skip their next ${count === 1 ? 'turn' : `${count} turns`} (CR 614.10).`,
			pl.playerId
		);
	}
}

// ---- Precon Bragos Spirit: CR 500.11 "skips their next combat phase" ------------------------

export function executeSkipCombatPhase(host: P19aStepHost, step: EffectStep): void {
	const rt = getP19aRuntimeHost();
	const count = Math.max(1, host.amount(step.amount, 1));
	const targets =
		step.subject.k === 'player' || step.subject.k === 'playerRef'
			? host.players(step.subject)
			: [host.you];
	for (const pl of targets) {
		if (pl.lost) continue;
		pl.skipNextCombatPhases = (pl.skipNextCombatPhases ?? 0) + count;
		rt?.addLog(
			host.state,
			'rule',
			`${pl.username} will skip their next ${count === 1 ? 'combat phase' : `${count} combat phases`} (CR 500.11).`,
			pl.playerId
		);
	}
}

// ---- Slice P19a.4: `exileUntil` + Impulse Exile (`CR 609.4b`) -------------------------------

function shuffleIdsDeterministic(state: GameState, ids: string[]): string[] {
	const arr = [...ids];
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom(state) * (i + 1));
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
	return arr;
}

export function executeExileUntilP19a(host: P19aStepHost, step: EffectStep): void {
	const spec = step.params?.exileUntilSpec;
	const rt = getP19aRuntimeHost();
	if (!spec) return;
	const s = host.state;
	const you = host.you;

	const libPlayers = spec.libraryOwner ? host.players(spec.libraryOwner) : [you];
	if (libPlayers.length === 0) return;

	const stateKey = `p19a_exile_until_state:${host.stepIndex}`;
	const savedState = host.answers[stateKey];

	for (let pIdx = 0; pIdx < libPlayers.length; pIdx++) {
		const libPl = libPlayers[pIdx];
		if (libPl.lost) continue;
		const plDoneKey = `${stateKey}:done:${libPl.playerId}`;
		if (host.answers[plDoneKey]) continue;

		const plExiledKey = `${stateKey}:exiled:${libPl.playerId}`;
		let exiledIds: string[] = [];
		let hitId: string | null = null;

		const existingExiled = host.answers[plExiledKey];
		if (existingExiled && existingExiled.kind === 'chooseObjects') {
			const raw = existingExiled.objectIds;
			hitId = raw[0] === '__NONE__' ? null : (raw[0] ?? null);
			exiledIds = raw.slice(1);
		} else {
			const fctx: FilterContext = {
				state: s,
				controllerId: you.playerId,
				source: host.locate(host.sourceId)?.inst,
				stackItem: host.item,
				zone: 'exile'
			};
			const maxCards = Math.min(250, libPl.library.length);
			for (let guard = 0; guard < maxCards; guard++) {
				const topCard = libPl.library[0];
				if (!topCard) break;
				moveObject(s, topCard, 'exile', {
					from: { player: libPl, zone: 'library' },
					toPlayer: libPl,
					bumpVersion: true,
					newTimestamp: true
				});
				exiledIds.push(topCard.instanceId);
				if (matchesObjectFilter(topCard, spec.filter, fctx)) {
					hitId = topCard.instanceId;
					break;
				}
			}
			host.answers[plExiledKey] = {
				kind: 'chooseObjects',
				objectIds: [hitId ?? '__NONE__', ...exiledIds]
			};
		}

		const hitInst = hitId
			? s.players.flatMap((pl) => pl.exile).find((c) => c.instanceId === hitId)
			: undefined;

		if (hitInst) {
			if (spec.hitAction === 'playThisTurn' || spec.hitAction === 'playUntilEndOfNextTurn') {
				const turnSerial = s.turnSerial ?? s.turnNumber;
				hitInst.playableFromExileBy = {
					playerId: you.playerId,
					sourceName: host.sourceCard.name,
					duration:
						spec.hitAction === 'playUntilEndOfNextTurn'
							? 'untilEndOfYourNextTurn'
							: 'thisTurn',
					expiresAtEndOfTurn: spec.hitAction === 'playThisTurn',
					...(spec.hitAction === 'playUntilEndOfNextTurn'
						? {
								expiresOnCleanupOfPlayerId: you.playerId,
								grantedOnTurnSerial: turnSerial
							}
						: {}),
					spendManaAsAnyColor: Boolean(spec.spendManaAsAnyColor),
					...(spec.spellsOnly ? { spellsOnly: true } : {})
				};
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'hand') {
				const owner = s.players.find((pl) => pl.playerId === hitInst.ownerId) ?? libPl;
				moveObject(s, hitInst, 'hand', {
					from: { player: owner, zone: 'exile' },
					toPlayer: owner,
					bumpVersion: true,
					newTimestamp: true
				});
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'battlefield') {
				const owner = s.players.find((pl) => pl.playerId === hitInst.ownerId) ?? libPl;
				moveObject(s, hitInst, 'battlefield', {
					from: { player: owner, zone: 'exile' },
					toPlayer: you,
					bumpVersion: true,
					newTimestamp: true
				});
				rt?.triggerOnEtb(s, you, hitInst);
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'battlefieldOrHand') {
				let putBf = true;
				if (!you.isBot && host.canPause) {
					const bhKey = `${stateKey}:bf_or_hand:${libPl.playerId}`;
					const bhAns = host.answers[bhKey];
					if (!bhAns || bhAns.kind !== 'yesNo') {
						host.pauseForYesNo(
							you,
							`${host.title} — ${hitInst.card.name}`,
							`Put ${hitInst.card.name} onto the battlefield or into your hand?`,
							bhKey,
							{ yesLabel: 'Put onto battlefield', noLabel: 'Put into hand' }
						);
						return;
					}
					putBf = bhAns.yes;
				}
				const owner = s.players.find((pl) => pl.playerId === hitInst.ownerId) ?? libPl;
				if (putBf) {
					moveObject(s, hitInst, 'battlefield', {
						from: { player: owner, zone: 'exile' },
						toPlayer: you,
						bumpVersion: true,
						newTimestamp: true
					});
					rt?.triggerOnEtb(s, you, hitInst);
				} else {
					moveObject(s, hitInst, 'hand', {
						from: { player: owner, zone: 'exile' },
						toPlayer: you,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				host.bind(step, [hitInst]);
			} else if (spec.hitAction === 'castFree') {
				let condOk = true;
				if (spec.castFreeCondition) {
					const hitFctx: FilterContext = {
						state: s,
						controllerId: you.playerId,
						source: hitInst,
						stackItem: host.item,
						zone: 'exile'
					};
					if (
						spec.castFreeCondition.k === 'compare' &&
						spec.castFreeCondition.left.k === 'stat' &&
						spec.castFreeCondition.left.stat === 'manaValue'
					) {
						const mv = objectManaValue(s, hitInst);
						const rhs = host.amount(spec.castFreeCondition.right);
						const op = spec.castFreeCondition.op;
						condOk =
							op === '<'
								? mv < rhs
								: op === '<='
									? mv <= rhs
									: op === '='
										? mv === rhs
										: op === '>='
											? mv >= rhs
											: mv > rhs;
					} else {
						condOk = host.evalCondition(spec.castFreeCondition);
						void hitFctx;
					}
				}
				if (condOk) {
					const synBind = `__p19a_exuntil_${host.stepIndex}_${libPl.playerId}`;
					const castStep: EffectStep = {
						verb: 'castFree',
						subject: { k: 'binding', name: synBind },
						params: {
							castFreeSpec: {
								withoutPayingManaCost: true
							}
						},
						span: step.span
					};
					host.bind({ ...step, bindAs: synBind }, [hitInst]);
					executeCastFree(host.p16aHost(), castStep);
					if (s.pendingPrompts.length > 0 && !savedState) {
						// Paused inside executeCastFree
						if (host.item.effectResume) {
							host.markPaused();
							return;
						}
					}
				}
				const stillInExile = s.players
					.flatMap((pl) => pl.exile)
					.find((c) => c.instanceId === hitInst.instanceId);
				if (stillInExile && spec.fallbackToHand) {
					const owner = s.players.find((pl) => pl.playerId === stillInExile.ownerId) ?? you;
					moveObject(s, stillInExile, 'hand', {
						from: { player: owner, zone: 'exile' },
						toPlayer: you,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				host.bind(step, [hitInst]);
			} else {
				host.bind(step, [hitInst]);
			}
		} else {
			const allExiled = exiledIds
				.map((id) => s.players.flatMap((pl) => pl.exile).find((c) => c.instanceId === id))
				.filter((c): c is CardInstance => Boolean(c));
			host.bind(step, allExiled);
		}

		if (spec.restDestination === 'libraryBottomRandom') {
			// Put all cards exiled this way that remain in exile (excluding hitId when hitAction granted playFromExile or stayExiled)
			const keepHitInExile =
				spec.hitAction === 'playThisTurn' ||
				spec.hitAction === 'playUntilEndOfNextTurn' ||
				spec.hitAction === 'none';
			const toBottomIds = exiledIds.filter((id) => !(keepHitInExile && id === hitId));
			const stillExiled = toBottomIds.filter((id) =>
				libPl.exile.some((c) => c.instanceId === id)
			);
			const orderedIds = shuffleIdsDeterministic(s, stillExiled);
			for (const id of orderedIds) {
				const cardInst = libPl.exile.find((c) => c.instanceId === id);
				if (!cardInst) continue;
				moveObject(s, cardInst, 'library', {
					from: { player: libPl, zone: 'exile' },
					toPlayer: libPl,
					insert: 'end',
					bumpVersion: true,
					newTimestamp: true
				});
			}
		} else if (spec.restDestination === 'graveyard') {
			for (const id of exiledIds) {
				if (id === hitId) continue;
				const cardInst = libPl.exile.find((c) => c.instanceId === id);
				if (!cardInst) continue;
				moveObject(s, cardInst, 'graveyard', {
					from: { player: libPl, zone: 'exile' },
					toPlayer: libPl,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true
				});
			}
		}

		host.answers[plDoneKey] = { kind: 'yesNo', yes: true };
	}
	host.recordCountedKind('exiledThisWay', 1);
	flushTriggers(s);
}

// ---- Delayed Next-Spell Copy ("When you next cast an instant or sorcery spell this turn, copy that spell") ----

export function executeDelayedNextSpellCopyP19a(host: P19aStepHost, step: EffectStep): void {
	const spec = step.params?.delayedNextSpellCopySpec;
	const rt = getP19aRuntimeHost();
	if (!spec || !rt) return;
	const entry: DelayedNextSpellCopyEntry = {
		id: rt.uid('dnextcopy', host.state),
		controllerId: host.you.playerId,
		sourceName: host.sourceCard.name,
		...(spec.types ? { types: [...spec.types] } : {}),
		...(spec.notTypes ? { notTypes: [...spec.notTypes] } : {}),
		...(spec.colors ? { colors: [...spec.colors] } : {}),
		copyCount: Math.max(1, spec.copyCount),
		mayChooseNewTargets: spec.mayChooseNewTargets
	};
	(host.state.delayedNextSpellCopies ??= []).push(entry);
	rt.addLog(
		host.state,
		'rule',
		`${host.title} will copy the next matching spell ${host.you.username} casts this turn (CR 603.7).`,
		host.you.playerId
	);
}

export function consumeP19aDelayedSpellCopyOnCast(
	state: GameState,
	actor: PlayerGameState,
	spellTypes: readonly string[],
	spellColors: readonly ManaColor[],
	stackItem: StackItem
): void {
	const list = state.delayedNextSpellCopies;
	if (!list || list.length === 0 || stackItem.isCopy) return;
	const rt = getP19aRuntimeHost();
	if (!rt) return;

	const matched: DelayedNextSpellCopyEntry[] = [];
	const remaining: DelayedNextSpellCopyEntry[] = [];
	for (const entry of list) {
		if (entry.controllerId !== actor.playerId) {
			remaining.push(entry);
			continue;
		}
		if (entry.types?.length && !entry.types.some((t) => spellTypes.includes(t))) {
			remaining.push(entry);
			continue;
		}
		if (entry.notTypes?.length && entry.notTypes.some((t) => spellTypes.includes(t))) {
			remaining.push(entry);
			continue;
		}
		if (entry.colors?.length && !entry.colors.some((c) => spellColors.includes(c))) {
			remaining.push(entry);
			continue;
		}
		matched.push(entry);
	}
	if (matched.length === 0) return;
	state.delayedNextSpellCopies = remaining.length > 0 ? remaining : undefined;

	for (const entry of matched) {
		const slots = entry.mayChooseNewTargets
			? rt.getStackItemRetargetSlots(state, stackItem, actor.playerId)
			: [];
		for (let i = 0; i < entry.copyCount; i++) {
			let targets = stackItem.targets.map((t) => ({ ...t }));
			let targetsBySpec = stackItem.targetsBySpec
				? stackItem.targetsBySpec.map((slot) => slot.map((t) => ({ ...t })))
				: undefined;
			if (entry.mayChooseNewTargets && slots.length > 0) {
				const botRetarget = rt.chooseBotStackItemRetarget(state, actor, stackItem, slots, i);
				targets = botRetarget.targets;
				targetsBySpec = botRetarget.targetsBySpec;
			}
			rt.pushCopiedStackItem(state, actor, stackItem, targets, targetsBySpec);
		}
		rt.addLog(
			state,
			'trigger',
			`${entry.sourceName} copied ${stackItem.title}${entry.copyCount > 1 ? ` (${entry.copyCount}x)` : ''} (CR 707.10).`,
			actor.playerId
		);
	}
}

// ---- Slice P19a.2: Choice-based Animate Color, Lose-Keyword, Pump Choice, & Coercive Extensions ----

export function resolveP19aChosenColorsForAnimate(
	host: P19aStepHost,
	mode: 'single' | 'oneOrMore'
): ManaColor[] | null {
	const s = host.state;
	const you = host.you;
	const rt = getP19aRuntimeHost();
	if (you.isBot || !host.canPause) {
		return [chooseBotBestColor(s, you)];
	}
	const colorOptions = buildColorChoiceOptions();
	const ansKey = `p19a_anim_color:${host.stepIndex}`;
	const ans = host.answers[ansKey];
	if (!ans || ans.kind !== 'chooseMode') {
		const item = host.saveFrame(host.stepIndex, host.answers, 'step', host.subStepIndex);
		enqueueChoicePrompt(s, {
			id: rt ? rt.uid('prompt', s) : `prm_p19a_${host.stepIndex}`,
			kind: 'chooseMode',
			playerId: you.playerId,
			title: `${host.title} — Choose Color${mode === 'oneOrMore' ? '(s)' : ''}`,
			description:
				mode === 'oneOrMore'
					? 'Choose one or more colors.'
					: 'Choose a color.',
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: host.stepIndex,
				answerKey: ansKey
			},
			choice: {
				kind: 'chooseMode',
				modes: colorOptions.labels,
				min: 1,
				max: mode === 'oneOrMore' ? 5 : 1,
				defaultIndices: [0]
			}
		});
		host.markPaused();
		return null;
	}
	const out: ManaColor[] = [];
	for (const idx of ans.indices) {
		const code = colorOptions.colors[idx];
		if (code && !out.includes(code)) out.push(code);
	}
	return out.length > 0 ? out : ['W'];
}

export function resolveP19aChosenPumpDelta(
	host: P19aStepHost,
	choices: ReadonlyArray<{ power: number; toughness: number }>,
	targetSample: CardInstance | undefined
): { power: number; toughness: number } | null {
	if (choices.length === 0) return { power: 0, toughness: 0 };
	if (choices.length === 1) return choices[0];
	const s = host.state;
	const you = host.you;
	const rt = getP19aRuntimeHost();
	if (you.isBot || !host.canPause) {
		// Bot avoids killing its own creature if one option lowers toughness to <= 0.
		if (targetSample && targetSample.controllerId === you.playerId) {
			const curT = objectToughness(s, targetSample) ?? 1;
			const safe = choices.find((c) => curT + c.toughness > 0);
			if (safe) return safe;
		}
		return choices[0];
	}
	const ansKey = `p19a_pump_choice:${host.stepIndex}`;
	const ans = host.answers[ansKey];
	const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
	const modes = choices.map((c) => `${fmt(c.power)}/${fmt(c.toughness)}`);
	if (!ans || ans.kind !== 'chooseMode') {
		const item = host.saveFrame(host.stepIndex, host.answers, 'step', host.subStepIndex);
		enqueueChoicePrompt(s, {
			id: rt ? rt.uid('prompt', s) : `prm_p19a_pump_${host.stepIndex}`,
			kind: 'chooseMode',
			playerId: you.playerId,
			title: `${host.title} — Choose P/T Modification`,
			description: `Choose one (${modes.join(' or ')}).`,
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: host.stepIndex,
				answerKey: ansKey
			},
			choice: {
				kind: 'chooseMode',
				modes,
				min: 1,
				max: 1,
				defaultIndices: [0]
			}
		});
		host.markPaused();
		return null;
	}
	return choices[ans.indices[0] ?? 0] ?? choices[0];
}

export function executeP19aExtendedRevealAndDiscard(
	host: P19aStepHost,
	step: EffectStep
): boolean {
	const pParams: EffectParams | undefined = step.params;
	if (
		!pParams?.partialRevealCount &&
		!pParams?.discardAllMatchingSacrificedColors &&
		!pParams?.discardAllWithChosenName &&
		!pParams?.includeGraveyardInCoercive &&
		!pParams?.coerciveCount
	) {
		return false;
	}

	const s = host.state;
	const you = host.you;
	const rt = getP19aRuntimeHost();
	const targets = host.players(step.subject).filter((pl) => !pl.lost);
	if (targets.length === 0) return true;

	const markRevealed = (card: CardInstance) => {
		const set = new Set<string>(card.knownToPlayerIds ?? []);
		for (const pl of s.players) set.add(pl.playerId);
		card.knownToPlayerIds = [...set];
	};

	for (let tIdx = 0; tIdx < targets.length; tIdx++) {
		const tp = targets[tIdx];
		const tpDoneKey = `p19a_coercive_done:${host.stepIndex}:${tp.playerId}`;
		if (host.answers[tpDoneKey]) continue;

		// 1. Determine revealed subset of hand (full hand unless `partialRevealCount` is set).
		let revealedHand: CardInstance[] = [...tp.hand];
		if (pParams.partialRevealCount === 'randomOne') {
			if (tp.hand.length === 0) {
				host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
				continue;
			}
			const rKey = `p19a_rand_rev:${host.stepIndex}:${tp.playerId}`;
			let pickedId: string | undefined;
			const savedRand = host.answers[rKey];
			if (savedRand && savedRand.kind === 'chooseObjects') {
				pickedId = savedRand.objectIds[0];
			} else {
				const rIdx = Math.floor(nextRandom(s) * tp.hand.length);
				pickedId = tp.hand[rIdx]?.instanceId;
				if (pickedId) {
					host.answers[rKey] = { kind: 'chooseObjects', objectIds: [pickedId] };
				}
			}
			const pickedCard = pickedId ? tp.hand.find((c) => c.instanceId === pickedId) : undefined;
			revealedHand = pickedCard ? [pickedCard] : [];
		} else if (pParams.partialRevealCount) {
			const revCount = Math.max(0, host.amount(pParams.partialRevealCount));
			if (revCount <= 0 || tp.hand.length === 0) {
				host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
				continue;
			}
			if (tp.hand.length > revCount) {
				if (tp.isBot || !host.canPause) {
					revealedHand = tp.hand.slice(0, revCount);
				} else {
					const revKey = `p19a_part_rev:${host.stepIndex}:${tp.playerId}`;
					const revAns = host.answers[revKey];
					if (!revAns || revAns.kind !== 'chooseObjects') {
						host.pauseForChoice(
							tp,
							`${host.title} — Reveal ${revCount} Card(s)`,
							`Choose ${revCount} card(s) from your hand to reveal.`,
							tp.hand.map((c) => c.instanceId),
							revCount,
							revCount,
							'hand',
							tp.hand.slice(0, revCount).map((c) => c.instanceId),
							revKey
						);
						return true;
					}
					revealedHand = revAns.objectIds
						.map((id) => tp.hand.find((c) => c.instanceId === id))
						.filter((c): c is CardInstance => Boolean(c));
				}
			}
		}

		for (const c of revealedHand) markRevealed(c);

		// Pure partial/random reveal without discard ("Target opponent reveals a card at random from their hand")
		if (
			!pParams.coerciveDiscard &&
			!pParams.discardAllMatchingSacrificedColors &&
			!pParams.discardAllWithChosenName
		) {
			host.bind(step, revealedHand);
			host.recordEffectAmount(revealedHand[0] ? objectManaValue(s, revealedHand[0]) : 0);
			host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
			continue;
		}

		// 2. Mass discard matching sacrificed creature's colors or chosen name.
		if (pParams.discardAllMatchingSacrificedColors) {
			const sacCols = new Set<ManaColor>();
			for (const e of host.item.sacrificedCostLki ?? []) {
				for (const col of e.colors) if (col !== 'C') sacCols.add(col);
			}
			const matching =
				sacCols.size === 0
					? []
					: revealedHand.filter((c) => {
							const fv = resolveObjectFaces(
								effectiveCardForObject(c),
								instanceFaceOptions(c, 'hand')
							);
							return fv.colors.some((col) => sacCols.has(col));
						});
			for (const c of matching) {
				moveObject(s, c, 'graveyard', {
					from: { player: tp, zone: 'hand' },
					toPlayer: tp,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true,
					discardReason: 'discard',
					discardPlayerId: tp.playerId
				});
			}
			host.bind(step, matching);
			host.recordEffectAmount(matching.length);
			host.recordCountedKind('discardedThisWay', matching.length);
			host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
			continue;
		}

		if (pParams.discardAllWithChosenName) {
			const targetName = (host.sourceChosenCardName ?? '').trim().toLowerCase();
			const matching = !targetName
				? []
				: revealedHand.filter((c) => {
						const fv = resolveObjectFaces(
							effectiveCardForObject(c),
							instanceFaceOptions(c, 'hand')
						);
						return (
							fv.name.toLowerCase() === targetName ||
							c.card.name.toLowerCase() === targetName
						);
					});
			for (const c of matching) {
				moveObject(s, c, 'graveyard', {
					from: { player: tp, zone: 'hand' },
					toPlayer: tp,
					graveyardReplacement: true,
					bumpVersion: true,
					newTimestamp: true,
					discardReason: 'discard',
					discardPlayerId: tp.playerId
				});
			}
			host.bind(step, matching);
			host.recordEffectAmount(matching.length);
			host.recordCountedKind('discardedThisWay', matching.length);
			host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
			continue;
		}

		// 3. Coercive chooser picks `pickCount` cards from `revealedHand` (+ `tp.graveyard` if `includeGraveyardInCoercive`).
		const spec = pParams.coerciveDiscard!;
		const chooser =
			spec.chooser.k === 'you'
				? you
				: (host.players({ k: 'playerRef', ref: spec.chooser })[0] ?? you);
		const candidatePool: Array<{ inst: CardInstance; fromZone: 'hand' | 'graveyard' }> = [];
		for (const c of revealedHand) {
			const fctx: FilterContext = {
				state: s,
				controllerId: chooser.playerId,
				source: host.locate(host.sourceId)?.inst,
				stackItem: host.item,
				zone: 'hand'
			};
			if (!spec.filter || matchesObjectFilter(c, { ...spec.filter, zone: 'hand' }, fctx)) {
				candidatePool.push({ inst: c, fromZone: 'hand' });
			}
		}
		if (pParams.includeGraveyardInCoercive) {
			for (const c of tp.graveyard) {
				const fctx: FilterContext = {
					state: s,
					controllerId: chooser.playerId,
					source: host.locate(host.sourceId)?.inst,
					stackItem: host.item,
					zone: 'graveyard'
				};
				if (
					!spec.filter ||
					matchesObjectFilter(c, { ...spec.filter, zone: 'graveyard' }, fctx)
				) {
					candidatePool.push({ inst: c, fromZone: 'graveyard' });
				}
			}
		}

		const rawPick = pParams.coerciveCount ? Math.max(0, host.amount(pParams.coerciveCount)) : 1;
		const pickCount = Math.min(rawPick, candidatePool.length);
		if (pickCount <= 0) {
			host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
			continue;
		}

		let chosenEntries = candidatePool.slice(0, pickCount);
		if (candidatePool.length > pickCount || spec.optionalChoice) {
			if (chooser.isBot || !host.canPause) {
				const sorted = [...candidatePool].sort(
					(a, b) => objectManaValue(s, b.inst) - objectManaValue(s, a.inst)
				);
				chosenEntries = sorted.slice(0, pickCount);
			} else {
				const pickKey = `p19a_coercive_pick:${host.stepIndex}:${tp.playerId}`;
				const pickAns = host.answers[pickKey];
				const minPick = spec.optionalChoice ? 0 : pickCount;
				if (!pickAns || pickAns.kind !== 'chooseObjects') {
					const promptZone: ZoneType = pParams.includeGraveyardInCoercive ? 'graveyard' : 'hand';
					host.pauseForChoice(
						chooser,
						`${host.title} — Choose ${pickCount} Card(s)`,
						`Choose ${minPick === pickCount ? pickCount : `up to ${pickCount}`} card(s) from ${tp.username}'s ${pParams.includeGraveyardInCoercive ? 'graveyard or hand' : 'revealed cards'}.`,
						candidatePool.map((e) => e.inst.instanceId),
						minPick,
						pickCount,
						promptZone,
						candidatePool.slice(0, pickCount).map((e) => e.inst.instanceId),
						pickKey
					);
					return true;
				}
				chosenEntries = pickAns.objectIds
					.map((id) => candidatePool.find((e) => e.inst.instanceId === id))
					.filter((e): e is { inst: CardInstance; fromZone: 'hand' | 'graveyard' } => Boolean(e));
			}
		}

		const movedCards: CardInstance[] = [];
		let exiledFromHandCount = 0;
		for (const entry of chosenEntries) {
			const dest = spec.destination;
			moveObject(s, entry.inst, dest, {
				from: { player: tp, zone: entry.fromZone },
				toPlayer: tp,
				...(dest === 'graveyard' ? { graveyardReplacement: true } : {}),
				bumpVersion: true,
				newTimestamp: true,
				...(entry.fromZone === 'hand' && dest === 'graveyard'
					? { discardReason: 'discard', discardPlayerId: tp.playerId }
					: {})
			});
			if (entry.fromZone === 'hand' && dest === 'exile') exiledFromHandCount++;
			movedCards.push(entry.inst);
		}
		if (exiledFromHandCount > 0) {
			host.recordCountedKind('exiledFromHand', exiledFromHandCount);
		}
		if (spec.destination === 'graveyard' && movedCards.length > 0) {
			host.recordCountedKind('discardedThisWay', movedCards.length);
		}
		host.bind(step, movedCards);
		host.recordEffectAmount(movedCards.length);
		rt?.addLog(
			s,
			'rule',
			`${chooser.username} chose ${movedCards.map((c) => c.card.name).join(', ') || 'nothing'} from ${tp.username}.`,
			chooser.playerId
		);
		host.answers[tpDoneKey] = { kind: 'yesNo', yes: true };
	}

	flushTriggers(s);
	return true;
}

// ---- CR 119.5: Set Player Life Total ("target player's life total becomes 10") --------------

export function executeP19aSetLifeTotal(host: P19aStepHost, step: EffectStep): void {
	const targetLife = host.amount(step.amount, 0);
	const targets = host.players(step.subject).filter((pl) => !pl.lost);
	const rt = getP19aRuntimeHost();
	for (const pl of targets) {
		if (pl.lifeTotalCannotChangeThisTurn) continue;
		const delta = targetLife - pl.life;
		if (delta > 0) {
			host.gainLifeForPlayer(pl, delta);
		} else if (delta < 0) {
			host.loseLifeForPlayer(pl, -delta);
		}
		rt?.addLog(
			host.state,
			'life',
			`${pl.username}'s life total became ${pl.life} (CR 119.5).`,
			host.you.playerId
		);
	}
}

// ---- Cleanup Turn State ---------------------------------------------------------------------

export function cleanupP19aTurnState(state: GameState): void {
	state.lastTappedManaProduced = undefined;
	state.delayedTapManaTriggers = undefined;
	state.delayedNextSpellCopies = undefined;
	for (const p of state.players) {
		p.spendManaAsAnyColorFromTopOfLibraryThisTurn = undefined;
		for (const perm of p.battlefield) {
			perm.abilityActivationCountsThisTurn = undefined;
			perm.lastManaProduced = undefined;
		}
	}
}
