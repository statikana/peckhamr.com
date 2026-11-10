/**
 * Effect interpreter (ENGINE_ARCHITECTURE_PLAN.md section 2.1 and Phase 3).
 *
 * Executes an ordered list of IR EffectSteps against GameState. Steps can refer to the results of
 * earlier steps through bindings ("it", "its controller", "that many"); a binding records the objects
 * a step acted on and a last-known-information snapshot of each taken just before the step ran
 * (CR 608.2h), so a later step reads the object as it last existed even after it changed zones.
 *
 * Rules for this file (the architecture ratchet enforces the first two):
 * - It never reads rules text or compares card names. Everything it knows about an ability comes from
 *   the IR; card names are used for log lines only.
 * - Every zone change goes through runtime/zones.ts moveObject (directly or via an engine port).
 * - Engine primitives (damage, destroy with dies triggers, search prompts, ...) are reached through
 *   `EffectPorts`, registered by engine.ts at load, so there is no import cycle with the engine.
 *
 * Entry points: `executeEffectSteps(state, ctx, steps)` runs steps; `staticallyInterpretable` and
 * `interpretableNow` decide whether an ability can resolve here or must use the legacy
 * executeParsedEffect path (Phase 3 switches verbs over one at a time; see INTERPRETED_VERBS).
 * Phase 5 can call executeEffectSteps for triggered abilities with `eventObjectId`/`eventAmount`.
 */
import type {
	Amount,
	Condition,
	EffectStep,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	TargetSpec,
	TokenSpec,
	Verb
} from '../ir.ts';
import type {
	CardInstance,
	CounterType,
	DelayedTrigger,
	EffectBindingSnapshot,
	EffectResumeFrame,
	GameState,
	LibrarySearchSpec,
	ManaColor,
	PlayerGameState,
	ScryfallCard,
	StackItem,
	TargetRef,
	TriggerEventLki,
	VfxEvent
} from '../types.ts';
import { cardManaSteps, compileCard } from '../compiler/index.ts';
import { legacySearchSpec } from '../compiler/effects.ts';
import { evaluatePermanent, inspectCardContinuousBreakdown } from '../ruleTree.ts';
import { enqueueChoicePrompt } from './choices.ts';
import { emitEvent } from './events.ts';
import { activeRuleModifiers, tokenMultiplier } from './replace.ts';
import { withSimultaneousDestroyLki } from './triggers.ts';
import { nextRandom } from './random.ts';
import { allocateTimestamp, moveObject, rearrangeLibrary } from './zones.ts';
import { PROMPTING_VERBS } from '../compiler/interpretable.ts';

/** Seeded randomness lives in runtime/random.ts (re-exported here for existing importers). */
export { nextRandom };

// ---- Engine ports ---------------------------------------------------------------------------

/** Engine primitives the interpreter uses. engine.ts registers them once at module load. */
export interface EffectPorts {
	uid(prefix: string, state?: GameState): string;
	addLog(state: GameState, kind: 'rule' | 'cast' | 'trigger' | 'life' | 'combat', text: string, actorId?: string): void;
	emitVfx(state: GameState, event: Omit<VfxEvent, 'id' | 'timestamp'>): void;
	findPermanent(state: GameState, id: string): { inst: CardInstance; owner: PlayerGameState; controller: PlayerGameState } | null;
	power(state: GameState, inst: CardInstance): number;
	toughness(state: GameState, inst: CardInstance): number;
	hasKeyword(state: GameState, inst: CardInstance, keyword: string): boolean;
	drawCards(state: GameState, player: PlayerGameState, count: number): void;
	/** Non-combat damage to a target permanent or player (protection, lifelink, events). */
	damageTarget(state: GameState, sourcePlayerId: string, target: TargetRef, amount: number): void;
	/** Destroy (CR 701.7): indestructible, dies triggers. */
	destroy(state: GameState, inst: CardInstance, title: string, controllerId: string): void;
	/** Moves a permanent off the battlefield (replacement effects, attachments, tokens cease to exist). */
	moveFromBattlefield(state: GameState, inst: CardInstance, to: 'graveyard' | 'exile' | 'hand' | 'library'): string;
	/** Counters a spell unless it can't be countered. Returns true if it was countered. */
	counterSpell(state: GameState, item: StackItem, target: StackItem, controller: PlayerGameState): boolean;
	createToken(state: GameState, controller: PlayerGameState, spec: TokenSpec): CardInstance;
	copyPermanentAsToken(state: GameState, controller: PlayerGameState, inst: CardInstance, title: string, notLegendary?: boolean): void;
	triggerOnEtb(state: GameState, controller: PlayerGameState, inst: CardInstance): void;
	triggerOnAttach(state: GameState, controller: PlayerGameState, attached: CardInstance, to: CardInstance): void;
	addCounters(state: GameState, inst: CardInstance, counter: CounterType, amount: number): number;
	proliferate(state: GameState, controller: PlayerGameState, chosenIds?: string[]): void;
	/** Scry or "look at the top N, put them back in any order": bot decision or human prompt. */
	scry(state: GameState, player: PlayerGameState, item: StackItem, count: number, mode: 'scry' | 'rearrange', mayShuffle: boolean): void;
	search(state: GameState, player: PlayerGameState, spec: LibrarySearchSpec, item: StackItem): void;
	phaseOut(state: GameState, inst: CardInstance): void;
	endTurn(state: GameState, playerId: string): void;
	/** "The player whose turn it is may end the turn": ends it for a bot/the controller, else prompts. */
	activePlayerMayEndTurn(state: GameState, controller: PlayerGameState, sourceName: string): void;
	win(state: GameState, player: PlayerGameState, reason: string): void;
	lose(state: GameState, player: PlayerGameState, reason: string): void;
	/** CR 303.4f–g: Legal object/player ids an Aura entering without being cast may enchant, ranked by bot heuristic. */
	legalAuraAttachCandidates(state: GameState, aura: CardInstance, controller: PlayerGameState): string[];
}

let ports: EffectPorts | null = null;

export function registerEffectPorts(p: EffectPorts): void {
	ports = p;
}

function P(): EffectPorts {
	if (!ports) throw new Error('runtime/effects: engine ports not registered (import engine.ts first)');
	return ports;
}

// ---- Context and bindings -------------------------------------------------------------------

export interface EffectContext {
	/** "You": the controller of the resolving spell or ability. */
	controller: PlayerGameState;
	/** The source object (spell card, permanent with the ability). */
	sourceId: string;
	/** For log lines and protection checks only. */
	sourceCard: ScryfallCard;
	title: string;
	/** The resolving stack item (search/scry prompts hold on to it). */
	item: StackItem;
	/** Chosen targets that are still legal, all belonging to target spec 0. */
	targets: TargetRef[];
	targetSpecs: TargetSpec[];
	xValue: number;
	overload?: boolean;
	/** Preferred colour when resolving an `addMana` step with `manaChoice`. */
	preferredColor?: ManaColor;
	/** Triggered abilities (Phase 5): the object and amount the trigger event was about. */
	eventObjectId?: string;
	eventAmount?: number;
	/** Steps C+D: the event object's version when the event happened (CR 400.7) and its LKI. */
	eventObjectVersion?: number;
	eventLki?: TriggerEventLki;
	/** "That player": the player the trigger event was about. */
	eventPlayerId?: string;
}

export interface EffectResult {
	/** An "end the turn" step ran; the caller must stop resolving (CR 723). */
	turnEnded: boolean;
	/** The spell exiles itself as it resolves ("Exile ~."). */
	exileSelf: boolean;
	/**
	 * Step E2: a human must choose before the steps can go on. The prompt is queued and the resume
	 * frame is stored on the stack item (`item.effectResume`); the caller leaves the item on the stack
	 * (CR 608.2n) and resolves it again, by id, once the prompt is answered.
	 */
	paused?: boolean;
}

/** Plain data (JSON-safe): bindings are serialised into the stack item when resolution pauses. */
type Snapshot = EffectBindingSnapshot['lki'];
type Bound = EffectBindingSnapshot;

type Bindings = Map<string, Bound[]>;

// ---- Gating (compiler/interpretable.ts) ------------------------------------------------------

export { INTERPRETED_VERBS, optionalPrefix, staticallyInterpretable, withoutOptional } from '../compiler/interpretable.ts';

function targetRefMatchesSpec(t: TargetRef, spec: TargetSpec): boolean {
	if (spec.kind === 'player') return t.kind === 'player';
	if (spec.kind === 'objectOrPlayer') return t.kind === 'player' || t.kind === 'permanent';
	const zone = spec.filter.zone;
	if (zone === 'stack') return t.kind === 'stack';
	if (zone === 'graveyard') return t.kind === 'graveyard_card' || t.kind === 'card_in_graveyard';
	return t.kind === 'permanent';
}

/**
 * Checks that need the game state: the chosen targets fit the compiled target spec, and a human
 * chooser's prompt (scry, search) only happens at the last step (resuming after a prompt is not
 * implemented yet, so those fall back).
 */
export function interpretableNow(
	state: GameState,
	item: StackItem,
	parse: { steps: EffectStep[]; targets: TargetSpec[] },
	controller: PlayerGameState,
	overload: boolean
): boolean {
	const spec = parse.targets[0];
	if (!spec) {
		if (item.targets.length > 0) return false;
	} else if (overload) {
		if (spec.kind !== 'object') return false;
	} else if (parse.targets.length === 2 && parse.steps.some((s) => s.verb === 'fight')) {
		if (item.targets.length !== 2) return false;
		if (!targetRefMatchesSpec(item.targets[0], parse.targets[0])) return false;
		if (!targetRefMatchesSpec(item.targets[1], parse.targets[1])) return false;
	} else if (parse.targets.length > 1) {
		if (item.targets.length === 0 || item.targets.length > parse.targets.length) return false;
		if (!item.targets.every((t) => parse.targets.some((sp) => targetRefMatchesSpec(t, sp)))) return false;
	} else {
		// CR 608.2b: targets that became illegal were dropped; the spell resolves with the rest.
		if (item.targets.length === 0 && spec.min > 0) return false;
		if (item.targets.length > spec.max) return false;
		if (!item.targets.every((t) => targetRefMatchesSpec(t, spec))) return false;
	}
	// Step E2: an item on the stack can pause for a human's scry or search prompt and resume after
	// it. Anything else (an inline triggered mana ability) can't, so a human prompt must come last.
	if (state.stack.some((s) => s.id === item.id)) return true;
	const last = parse.steps.length - 1;
	for (let i = 0; i < parse.steps.length; i++) {
		const step = parse.steps[i];
		if (!PROMPTING_VERBS.has(step.verb) || i === last) continue;
		const chooser = step.actor ? playerFromRefStatic(state, step.actor, item, controller) : controller;
		if (!chooser || !chooser.isBot) return false;
	}
	return true;
}

/** Player lookup before any step has run (bindings are empty: a binding's controller is the target's). */
function playerFromRefStatic(state: GameState, ref: PlayerRef, item: StackItem, controller: PlayerGameState): PlayerGameState | null {
	if (ref.k === 'you') return controller;
	if (ref.k === 'activePlayer') return state.players[state.activePlayerIndex] ?? null;
	if (ref.k === 'eventPlayer') return state.players.find((p) => p.playerId === item.eventPlayerId) ?? null;
	if (ref.k === 'controllerOf' || ref.k === 'ownerOf') {
		const t = item.targets[0];
		if (!t) return null;
		const found = P().findPermanent(state, t.id);
		if (!found) return null;
		return ref.k === 'controllerOf' ? found.controller : found.owner;
	}
	const t = item.targets[ref.index];
	return t?.kind === 'player' ? state.players.find((p) => p.playerId === t.id) ?? null : null;
}

// ---- Unified Damage Pipeline (CR 120.3–120.4, 122.1c, 702.16e, 702.80a, 702.90b–c) ---------

export interface SourceDamageInfo {
	hasDeathtouch: boolean;
	hasLifelink: boolean;
	hasInfect: boolean;
	hasWither: boolean;
	colors: ManaColor[];
	types: string[];
}

export function sourceDamageInfo(
	state: GameState,
	sourcePerm: CardInstance | null,
	sourceCard: ScryfallCard
): SourceDamageInfo {
	if (sourcePerm && sourcePerm.zone === 'battlefield') {
		const ev = evaluatePermanent(state, sourcePerm);
		const kws = ev.activeKeywords.map((k) => k.toLowerCase());
		return {
			hasDeathtouch: kws.includes('deathtouch'),
			hasLifelink: kws.includes('lifelink'),
			hasInfect: kws.includes('infect'),
			hasWither: kws.includes('wither'),
			colors: sourcePerm.isFaceDown ? [] : [...ev.colors],
			types: ev.typeLine
				.split(/\s+[—-]\s+/)[0]
				.split(/\s+/)
				.filter(Boolean)
		};
	}
	const face = compileCard(sourceCard).faces[0];
	const kws = new Set<string>((sourceCard.keywords ?? []).map((k) => k.toLowerCase()));
	for (const ab of face.abilities) {
		if (ab.kind === 'keyword') kws.add(ab.keyword.name.toLowerCase());
	}
	return {
		hasDeathtouch: kws.has('deathtouch'),
		hasLifelink: kws.has('lifelink'),
		hasInfect: kws.has('infect'),
		hasWither: kws.has('wither'),
		colors: [...(face.characteristics.colors ?? sourceCard.colors ?? [])],
		types: [...(face.characteristics.types ?? [])]
	};
}

export function permanentProtectedFromSource(
	state: GameState,
	target: CardInstance,
	srcInfo: SourceDamageInfo,
	evTarget?: ReturnType<typeof evaluatePermanent>
): boolean {
	const ev = evTarget ?? evaluatePermanent(state, target);
	const colorMap: Record<string, ManaColor> = {
		white: 'W',
		blue: 'U',
		black: 'B',
		red: 'R',
		green: 'G'
	};
	const typeMap: Record<string, string> = {
		creatures: 'Creature',
		creature: 'Creature',
		artifacts: 'Artifact',
		artifact: 'Artifact',
		enchantments: 'Enchantment',
		enchantment: 'Enchantment',
		lands: 'Land',
		land: 'Land',
		planeswalkers: 'Planeswalker',
		planeswalker: 'Planeswalker',
		instants: 'Instant',
		instant: 'Instant',
		sorceries: 'Sorcery',
		sorcery: 'Sorcery'
	};
	for (const kw of ev.activeKeywords) {
		const low = kw.toLowerCase();
		if (!low.startsWith('protection from ')) continue;
		const qual = low.slice('protection from '.length).trim();
		if (qual === 'everything') return true;
		if (qual === 'all colors' && srcInfo.colors.length > 0) return true;
		if (qual === 'multicolored' && srcInfo.colors.length >= 2) return true;
		if (qual === 'monocolored' && srcInfo.colors.length === 1) return true;
		if (qual === 'colorless' && srcInfo.colors.length === 0) return true;
		if (colorMap[qual] && srcInfo.colors.includes(colorMap[qual])) return true;
		if (typeMap[qual] && srcInfo.types.some((t) => t.toLowerCase() === typeMap[qual].toLowerCase())) {
			return true;
		}
	}
	return false;
}

export function dealDamageToPermanent(
	state: GameState,
	target: CardInstance,
	rawAmount: number,
	sourceId: string,
	srcInfo: SourceDamageInfo,
	opts?: { combat?: boolean; actorId?: string; vfxLabel?: string }
): number {
	const p = P();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || target.zone !== 'battlefield' || target.phasedOut) return 0;

	const evTarget = evaluatePermanent(state, target);

	// CR 702.16b / 702.16e: Protection prevents all damage from sources with the stated quality.
	if (permanentProtectedFromSource(state, target, srcInfo, evTarget)) return 0;

	// CR 120.3 / 615.7: Damage prevention shield on permanent.
	if ((target.damagePreventionShield ?? 0) > 0) {
		const prevented = Math.min(dmg, target.damagePreventionShield!);
		target.damagePreventionShield! -= prevented;
		dmg -= prevented;
		if (dmg <= 0) return 0;
	}

	// CR 122.1c: If a permanent with a shield counter on it would be dealt damage,
	// prevent that damage and remove a shield counter from it.
	if ((target.counters.shield || 0) > 0) {
		target.counters.shield = Math.max(0, (target.counters.shield || 0) - 1);
		p.addLog(
			state,
			'rule',
			`A shield counter prevented ${dmg} damage to ${target.card.name} and was removed (CR 122.1c).`,
			opts?.actorId ?? target.controllerId
		);
		return 0;
	}

	if (evTarget.isPlaneswalker) {
		// CR 120.3c / 306.8: Damage dealt to a planeswalker removes that many loyalty counters.
		target.counters.loyalty = Math.max(0, (target.counters.loyalty || 0) - dmg);
	}
	if (evTarget.isCreature) {
		// CR 702.80 / 702.90b–c: Source with wither or infect deals damage to a creature in the form of -1/-1 counters.
		if (srcInfo.hasInfect || srcInfo.hasWither) {
			p.addCounters(state, target, '-1/-1', dmg);
		} else {
			target.damageMarked += dmg;
		}
		if (srcInfo.hasDeathtouch) {
			target.deathtouchDamageMarked = true;
		}
	} else if (!evTarget.isPlaneswalker) {
		target.damageMarked += dmg;
	}

	emitEvent(state, {
		kind: 'DamageDealt',
		sourceId,
		targetId: target.instanceId,
		targetKind: 'permanent',
		amount: dmg,
		combat
	});
	p.emitVfx(state, {
		kind: 'damage',
		...(combat ? { sourceId } : {}),
		targetId: target.instanceId,
		amount: dmg,
		...(opts?.vfxLabel ? { label: opts.vfxLabel } : {})
	});
	return dmg;
}

export function dealDamageToPlayer(
	state: GameState,
	pl: PlayerGameState,
	rawAmount: number,
	sourceId: string,
	srcInfo: SourceDamageInfo,
	opts?: { combat?: boolean; vfxSourceId?: string; vfxLabel?: string }
): number {
	const p = P();
	const combat = opts?.combat ?? false;
	let dmg = rawAmount;
	if (dmg <= 0 || pl.lost) return 0;
	if (pl.protectionFromEverythingThisTurn) return 0;

	if ((pl.damagePreventionShield ?? 0) > 0) {
		const prevented = Math.min(dmg, pl.damagePreventionShield!);
		pl.damagePreventionShield! -= prevented;
		dmg -= prevented;
		if (dmg <= 0) return 0;
	}

	if (srcInfo.hasInfect) {
		// CR 702.90b: Damage dealt to a player by a source with infect is dealt in the form of poison counters.
		pl.poison = (pl.poison || 0) + dmg;
	} else {
		const cantChange =
			Boolean(pl.lifeTotalCannotChangeThisTurn) ||
			activeRuleModifiers(state, 'lifeTotalCantChange', pl.playerId).length > 0;
		if (!cantChange) pl.life -= dmg;
	}

	emitEvent(state, {
		kind: 'DamageDealt',
		sourceId,
		targetId: pl.playerId,
		targetKind: 'player',
		amount: dmg,
		combat
	});
	p.emitVfx(state, {
		kind: 'damage',
		sourceId: opts?.vfxSourceId ?? sourceId,
		targetId: pl.playerId,
		amount: dmg,
		...(opts?.vfxLabel ? { label: opts.vfxLabel } : {})
	});
	return dmg;
}

export function applyLifelinkGain(
	state: GameState,
	controller: PlayerGameState,
	totalDealt: number
): void {
	if (totalDealt <= 0 || controller.lost) return;
	const cantChange =
		Boolean(controller.lifeTotalCannotChangeThisTurn) ||
		activeRuleModifiers(state, 'lifeTotalCantChange', controller.playerId).length > 0;
	if (!cantChange) controller.life += totalDealt;
}

// ---- Interpreter ----------------------------------------------------------------------------

export function proliferateCandidates(
	state: GameState,
	controller: PlayerGameState
): { candidates: string[]; defaultIds: string[] } {
	const allCounterTypes: CounterType[] = [
		'+1/+1',
		'-1/-1',
		'loyalty',
		'charge',
		'shield',
		'stun',
		'lore',
		'time'
	];
	const controllerPositiveTypes: CounterType[] = [
		'+1/+1',
		'loyalty',
		'charge',
		'shield',
		'lore',
		'time'
	];
	const opponentNegativeTypes: CounterType[] = ['-1/-1', 'stun'];
	const candidates: string[] = [];
	const defaultIds: string[] = [];
	for (const pl of state.players) {
		if (pl.lost) continue;
		const isSelf = pl.playerId === controller.playerId;
		for (const perm of pl.battlefield) {
			if (perm.phasedOut) continue;
			if (allCounterTypes.some((cType) => (perm.counters[cType] || 0) > 0)) {
				candidates.push(perm.instanceId);
				const wantTypes = isSelf ? controllerPositiveTypes : opponentNegativeTypes;
				if (wantTypes.some((cType) => (perm.counters[cType] || 0) > 0)) {
					defaultIds.push(perm.instanceId);
				}
			}
		}
		if (
			pl.poison > 0 ||
			(pl.experienceCounters || 0) > 0 ||
			(pl.energyCounters || 0) > 0
		) {
			candidates.push(pl.playerId);
			if (isSelf) {
				if (
					((pl.experienceCounters || 0) > 0 || (pl.energyCounters || 0) > 0) &&
					pl.poison === 0
				) {
					defaultIds.push(pl.playerId);
				}
			} else if (pl.poison > 0) {
				defaultIds.push(pl.playerId);
			}
		}
	}
	return { candidates, defaultIds };
}

class Run {
	readonly state: GameState;
	readonly ctx: EffectContext;
	readonly bindings: Bindings = new Map();
	readonly result: EffectResult = { turnEnded: false, exileSelf: false };
	/** Index of the step being executed. */
	stepIndex = 0;
	/** Choices made by humans for the current step while it was paused (playerId -> object ids). */
	answers: Record<string, string[]> = {};
	/** Can this run pause for a human (the item is on the stack, so it can be resumed by id)? */
	readonly canPause: boolean;

	constructor(state: GameState, ctx: EffectContext, resume?: EffectResumeFrame) {
		this.state = state;
		this.ctx = ctx;
		this.canPause = state.stack.some((s) => s.id === ctx.item.id);
		if (resume) {
			this.stepIndex = resume.stepIndex;
			for (const [name, bound] of resume.bindings) this.bindings.set(name, bound.map((b) => ({ id: b.id, lki: { ...b.lki } })));
			this.result.exileSelf = Boolean(resume.exileSelf);
			this.answers = { ...resume.answers };
		}
	}

	/**
	 * A human must choose objects for the current step. Queues a chooseObjects prompt whose
	 * continuation names this stack item and step, saves the resume frame on the stack item, and
	 * stops the run. Nothing of the step has happened yet (the step runs again from its start on
	 * resume, with `answers` filled in), so simultaneous choices stay simultaneous (CR 101.4).
	 */
	pauseForChoice(
		chooser: PlayerGameState,
		title: string,
		description: string,
		candidates: string[],
		min: number,
		max: number,
		zone: 'battlefield' | 'hand' | 'library',
		defaultObjectIds?: string[],
		answerKey?: string
	): void {
		const item = this.saveFrame(this.stepIndex, this.answers);
		enqueueChoicePrompt(this.state, {
			id: P().uid('prompt', this.state),
			kind: 'chooseObjects',
			playerId: chooser.playerId,
			title,
			description,
			candidateInstanceIds: candidates,
			countRequired: min,
			continuation: {
				kind: 'effect_choice',
				stackItemId: item.id,
				stepIndex: this.stepIndex,
				...(answerKey ? { answerKey } : {})
			},
			choice: {
				kind: 'chooseObjects',
				candidates,
				min,
				max,
				zone,
				reason: title,
				...(defaultObjectIds ? { defaultObjectIds } : {})
			}
		});
		this.result.paused = true;
	}

	/** Stores the resume frame (plain data) on the stack item and returns the item. */
	saveFrame(stepIndex: number, answers: Record<string, string[]>): StackItem {
		const item = this.state.stack.find((s) => s.id === this.ctx.item.id)!;
		item.effectResume = {
			stepIndex,
			bindings: [...this.bindings.entries()].map(([name, bound]) => [name, bound.map((b) => ({ id: b.id, lki: { ...b.lki } }))]),
			exileSelf: this.result.exileSelf || undefined,
			answers: { ...answers }
		};
		return item;
	}

	/**
	 * The objects `chooser` picks for the current step: a human's stored answer, or null when the
	 * human hasn't answered yet (the caller pauses). Answers naming objects that are no longer
	 * candidates are dropped, and missing picks are filled from the remaining candidates.
	 */
	answered(chooser: PlayerGameState, candidates: CardInstance[], min: number, max = min): CardInstance[] | null {
		const ids = this.answers[chooser.playerId];
		if (!ids) return null;
		const picked = ids.map((id) => candidates.find((c) => c.instanceId === id)).filter((c): c is CardInstance => Boolean(c));
		for (const c of candidates) if (picked.length < min && !picked.includes(c)) picked.push(c);
		return picked.slice(0, max);
	}

	get you(): PlayerGameState {
		return this.ctx.controller;
	}

	player(id: string): PlayerGameState | undefined {
		return this.state.players.find((p) => p.playerId === id);
	}

	snapshot(inst: CardInstance): Snapshot {
		const onBattlefield = inst.zone === 'battlefield';
		return {
			controllerId: inst.controllerId,
			ownerId: inst.ownerId,
			power: onBattlefield ? P().power(this.state, inst) : parseInt(inst.card.power ?? '0', 10) || 0,
			toughness: onBattlefield ? P().toughness(this.state, inst) : parseInt(inst.card.toughness ?? '0', 10) || 0,
			manaValue: inst.card.cmc
		};
	}

	/** Finds an object by id in any zone (battlefield first). */
	locate(id: string): { inst: CardInstance; holder: PlayerGameState; zone: 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' } | null {
		for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'library'] as const) {
			for (const p of this.state.players) {
				const inst = p[zone].find((c) => c.instanceId === id);
				if (inst) return { inst, holder: p, zone };
			}
		}
		return null;
	}

	// ---- Amounts

	amount(a: Amount | undefined, fallback = 0): number {
		if (!a) return fallback;
		switch (a.k) {
			case 'const':
				return a.n;
			case 'x':
				return this.ctx.xValue;
			case 'negate':
				return -this.amount(a.of);
			case 'sum':
				return a.args.reduce((s, x) => s + this.amount(x), 0);
			case 'min':
				return Math.min(...a.args.map((x) => this.amount(x)));
			case 'max':
				return Math.max(...a.args.map((x) => this.amount(x)));
			case 'count':
				return this.objects({ k: 'all', filter: a.of }).length;
			case 'resultCount':
				return this.bindings.get(a.of)?.length ?? 0;
			case 'eventAmount':
				return this.ctx.eventAmount ?? 0;
			case 'life': {
				const p = this.playerRef(a.of);
				return p ? p.life : 0;
			}
			case 'cardsIn': {
				const p = this.playerRef(a.of);
				return p ? p[a.zone === 'stack' ? 'hand' : (a.zone as 'hand')].length : 0;
			}
			case 'devotion':
				return devotion(this.you, a.colors);
			case 'stat': {
				const snap = this.refSnapshot(a.of, Boolean(a.lki));
				if (!snap) return 0;
				return a.stat === 'power' ? snap.power : a.stat === 'toughness' ? snap.toughness : snap.manaValue;
			}
		}
	}

	refSnapshot(ref: Ref, lki: boolean): Snapshot | null {
		if (ref.k === 'binding') {
			const b = this.bindings.get(ref.name)?.[0];
			if (!b) return null;
			if (lki) return b.lki;
			const now = this.locate(b.id);
			return now ? this.snapshot(now.inst) : b.lki;
		}
		const id = this.refId(ref);
		const found = id ? this.locate(id) : null;
		if (ref.k === 'eventObject') {
			// CR 608.2h / 400.7: the event object as it is now if it's still the same object on the
			// battlefield; otherwise (it died, or a "dies" trigger) as it last existed there.
			const same =
				found &&
				found.zone === 'battlefield' &&
				(this.ctx.eventObjectVersion === undefined || found.inst.objectVersion === this.ctx.eventObjectVersion);
			if (same) return this.snapshot(found.inst);
			if (this.ctx.eventLki) return { ...this.ctx.eventLki };
			return found ? this.snapshot(found.inst) : null;
		}
		if (ref.k === 'self') {
			const expectedVer = this.ctx.item?.sourceObjectVersion;
			const stillOnBattlefield =
				found &&
				found.zone === 'battlefield' &&
				(expectedVer === undefined || found.inst.objectVersion === expectedVer);
			if (stillOnBattlefield) {
				return this.snapshot(found.inst);
			}
			const lkiPower =
				this.ctx.item?.sourceLkiPower ??
				found?.inst.lastKnownPower ??
				this.ctx.item?.lkiPower ??
				(parseInt(this.ctx.sourceCard.power ?? '0', 10) || 0);
			const lkiToughness =
				this.ctx.item?.sourceLkiToughness ??
				found?.inst.lastKnownToughness ??
				this.ctx.item?.lkiToughness ??
				(parseInt(this.ctx.sourceCard.toughness ?? '0', 10) || 0);
			return {
				controllerId: this.ctx.controller.playerId,
				ownerId: found?.inst.ownerId ?? this.ctx.controller.playerId,
				power: lkiPower,
				toughness: lkiToughness,
				manaValue: this.ctx.sourceCard.cmc
			};
		}
		return found ? this.snapshot(found.inst) : null;
	}

	refId(ref: Ref): string | null {
		switch (ref.k) {
			case 'self':
				return this.ctx.sourceId;
			case 'target':
				return this.ctx.targets[ref.index]?.id ?? null;
			case 'binding':
				return this.bindings.get(ref.name)?.[0]?.id ?? null;
			case 'eventObject':
				return this.ctx.eventObjectId ?? null;
			case 'affected':
				return null;
		}
	}

	playerRef(ref: PlayerRef): PlayerGameState | null {
		switch (ref.k) {
			case 'you':
				return this.you;
			case 'activePlayer':
				return this.state.players[this.state.activePlayerIndex] ?? null;
			case 'eventPlayer':
				return this.ctx.eventPlayerId ? (this.player(this.ctx.eventPlayerId) ?? null) : null;
			case 'target': {
				const t = this.ctx.targets[ref.index];
				return t?.kind === 'player' ? (this.player(t.id) ?? null) : null;
			}
			case 'controllerOf':
			case 'ownerOf': {
				const snap = this.refSnapshot(ref.of, true);
				if (!snap) return null;
				return this.player(ref.k === 'controllerOf' ? snap.controllerId : snap.ownerId) ?? null;
			}
		}
	}

	// ---- Selectors

	/** CR 101.4: Active Player, Non-Active Player (APNAP) turn order starting from `state.activePlayerIndex`. */
	apnapPlayers(): PlayerGameState[] {
		const n = this.state.players.length;
		if (n === 0) return [];
		const start = (((this.state.activePlayerIndex ?? 0) % n) + n) % n;
		const out: PlayerGameState[] = [];
		for (let i = 0; i < n; i++) {
			const pl = this.state.players[(start + i) % n];
			if (pl && !pl.lost) out.push(pl);
		}
		return out;
	}

	players(sel: Selector): PlayerGameState[] {
		if (sel.k === 'playerRef') {
			const p = this.playerRef(sel.ref);
			return p && !p.lost ? [p] : [];
		}
		if (sel.k === 'target') {
			const refs =
				this.ctx.targetSpecs.length > 1
					? this.ctx.targets.length === this.ctx.targetSpecs.length
						? [this.ctx.targets[sel.index]]
						: this.ctx.targets.filter((t) => targetRefMatchesSpec(t, this.ctx.targetSpecs[sel.index]))
					: this.ctx.targets;
			return refs
				.filter((t): t is TargetRef => Boolean(t && t.kind === 'player'))
				.map((t) => this.player(t.id))
				.filter((p): p is PlayerGameState => Boolean(p && !p.lost));
		}
		if (sel.k !== 'player') return [];
		switch (sel.filter.relation) {
			case 'you':
				return [this.you];
			case 'each_opponent':
			case 'opponent':
				return this.apnapPlayers().filter((p) => p.playerId !== this.you.playerId);
			case 'each_player':
			case 'any':
				return this.apnapPlayers();
			case 'target':
				return this.players({ k: 'target', index: 0 });
		}
	}

	/** Objects a selector refers to, in their current zones. */
	objects(sel: Selector): CardInstance[] {
		switch (sel.k) {
			case 'self': {
				const f = this.locate(this.ctx.sourceId);
				return f ? [f.inst] : [];
			}
			case 'binding':
				return (this.bindings.get(sel.name) ?? [])
					.map((b) => this.locate(b.id)?.inst)
					.filter((c): c is CardInstance => Boolean(c));
			case 'target': {
				if (this.ctx.overload) {
					const spec = this.ctx.targetSpecs[sel.index];
					return spec ? this.objects({ k: 'all', filter: spec.filter }) : [];
				}
				const refs =
					this.ctx.targetSpecs.length > 1
						? this.ctx.targets.length === this.ctx.targetSpecs.length
							? [this.ctx.targets[sel.index]]
							: this.ctx.targets.filter((t) => targetRefMatchesSpec(t, this.ctx.targetSpecs[sel.index]))
						: this.ctx.targets;
				return refs
					.filter((t) => t.kind !== 'player' && t.kind !== 'stack')
					.map((t) => this.locate(t.id)?.inst)
					.filter((c): c is CardInstance => Boolean(c && !c.phasedOut));
			}
			case 'eventObject': {
				// CR 400.7: once the event object changes zones again it's a new object.
				const f = this.ctx.eventObjectId ? this.locate(this.ctx.eventObjectId) : null;
				if (!f || f.inst.phasedOut) return [];
				if (this.ctx.eventObjectVersion !== undefined && f.inst.objectVersion !== this.ctx.eventObjectVersion) return [];
				return [f.inst];
			}
			case 'all': {
				const zone = sel.filter.zone ?? 'battlefield';
				const out: CardInstance[] = [];
				for (const p of this.apnapPlayers()) {
					if (zone === 'battlefield') {
						for (const c of p.battlefield) if (!c.phasedOut && this.matches(c, sel.filter, 'battlefield')) out.push(c);
					} else if (zone === 'graveyard') {
						for (const c of p.graveyard) if (this.matches(c, sel.filter, 'graveyard')) out.push(c);
					} else if (zone === 'hand') {
						for (const c of p.hand) if (this.matches(c, sel.filter, 'hand')) out.push(c);
					}
				}
				return out;
			}
			default:
				return [];
		}
	}

	matches(c: CardInstance, f: ObjectFilter, zone: 'battlefield' | 'graveyard' | 'hand'): boolean {
		const ev = zone === 'battlefield' ? evaluatePermanent(this.state, c) : null;
		const card = c.copiableCard ?? c.card;
		const typeLine = ev ? ev.typeLine : card.typeLine;
		const hasSub = (s: string) => (ev ? ev.hasSubType(s) : typeLine.includes(s));
		if (f.types && !f.types.some((t) => typeLine.includes(t))) return false;
		if (f.subtypes && !f.subtypes.some(hasSub)) return false;
		if (f.notTypes && f.notTypes.some((t) => typeLine.includes(t))) return false;
		if (f.supertypes && !f.supertypes.every((t) => typeLine.includes(t))) return false;
		if (f.notSupertypes && f.notSupertypes.some((t) => typeLine.includes(t))) return false;
		const you = this.you.playerId;
		const controllerId = zone === 'battlefield' ? c.controllerId : c.ownerId;
		if (f.controller === 'you' && controllerId !== you) return false;
		if (f.controller === 'opponent' && controllerId === you) return false;
		if (f.owner === 'you' && c.ownerId !== you) return false;
		if (f.owner === 'opponent' && c.ownerId === you) return false;
		if (f.tapped !== undefined && c.tapped !== f.tapped) return false;
		if (f.token !== undefined && c.isToken !== f.token) return false;
		if (f.other && c.instanceId === this.ctx.sourceId) return false;
		const cols = ev ? (c.isFaceDown ? [] : ev.colors) : (card.colors ?? []);
		if (f.colors && !f.colors.some((col) => cols.includes(col))) return false;
		if (f.manaValue && !compare(card.cmc, f.manaValue.op, this.amount(f.manaValue.value))) return false;
		if (f.attacking !== undefined) {
			const attacking = this.state.combat.attackers.some((a) => a.attackerInstanceId === c.instanceId);
			if (attacking !== f.attacking) return false;
		}
		return true;
	}

	bind(step: EffectStep, objs: CardInstance[]): void {
		if (!step.bindAs) return;
		this.bindings.set(
			step.bindAs,
			objs.map((o) => ({ id: o.instanceId, lki: this.snapshot(o) }))
		);
	}

	// ---- Steps

	run(steps: EffectStep[]): void {
		for (; this.stepIndex < steps.length; this.stepIndex++) {
			if (this.result.turnEnded) return;
			const step = steps[this.stepIndex];
			const promptsBefore = this.state.pendingPrompts.length;
			this.step(step);
			if (this.result.paused) return;
			this.answers = {};
			// A scry or search step queued a human's prompt and more steps follow: pause, and resume at
			// the next step once every such prompt is answered (the prompt does the step's own work).
			const queued = this.state.pendingPrompts.slice(promptsBefore);
			if (this.canPause && PROMPTING_VERBS.has(step.verb) && queued.length > 0 && this.stepIndex < steps.length - 1) {
				const item = this.saveFrame(this.stepIndex + 1, {});
				for (const pr of queued) pr.continuation = { kind: 'effect_resume', stackItemId: item.id, stepIndex: this.stepIndex + 1 };
				this.result.paused = true;
				return;
			}
		}
	}

	step(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const title = this.ctx.title;
		switch (step.verb) {
			case 'draw':
				for (const pl of this.players(step.subject)) {
					const n = this.amount(step.amount, 1);
					if (n <= 0) continue;
					p.drawCards(s, pl, n);
					p.addLog(s, 'rule', `${pl.username} drew ${n} card(s).`, you.playerId);
				}
				return;
			case 'gainLife':
			case 'loseLife': {
				const n = Math.max(0, this.amount(step.amount));
				const targets =
					step.subject.k === 'none' && step.actor
						? this.players({ k: 'playerRef', ref: step.actor })
						: this.players(step.subject);
				for (const pl of targets) {
					const delta = step.verb === 'gainLife' ? n : -n;
					const cantChange =
						Boolean(pl.lifeTotalCannotChangeThisTurn) ||
						activeRuleModifiers(s, 'lifeTotalCantChange', pl.playerId).length > 0;
					if (!cantChange) pl.life += delta;
					p.emitVfx(s, {
						kind: delta >= 0 ? 'heal' : 'damage',
						sourceId: you.playerId,
						targetId: pl.playerId,
						amount: n,
						label: `${delta >= 0 ? '+' : '-'}${n} Life`
					});
				}
				if (targets.length > 0) {
					const who = targets.length === 1 ? targets[0].username : `${targets.length} players`;
					p.addLog(s, 'life', `${who} ${step.verb === 'gainLife' ? 'gained' : 'lost'} ${n} life from ${title}.`, you.playerId);
				}
				return;
			}
			case 'damage':
				return this.damage(step);
			case 'fight':
				return this.fight(step);
			case 'destroy': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const toDestroy: CardInstance[] = [];
				for (const o of objs) {
					const ev = evaluatePermanent(s, o);
					if (ev.activeKeywords.some((k) => k.toLowerCase() === 'indestructible')) {
						p.addLog(s, 'rule', `${o.card.name} is Indestructible and was not destroyed.`);
						continue;
					}
					// CR 122.1c: If a permanent with a shield counter on it would be destroyed,
					// instead remove a shield counter from it.
					if ((o.counters.shield || 0) > 0) {
						o.counters.shield = Math.max(0, (o.counters.shield || 0) - 1);
						p.addLog(
							s,
							'rule',
							`A shield counter was removed from ${o.card.name} instead of destroying it (CR 122.1c).`,
							you.playerId
						);
						continue;
					}
					toDestroy.push(o);
				}
				if (toDestroy.length > 0) {
					withSimultaneousDestroyLki(s, toDestroy, () => {
						for (const o of toDestroy) p.destroy(s, o, title, you.playerId);
					});
				}
				if (step.subject.k === 'all') {
					p.addLog(s, 'cast', `${title} destroyed ${toDestroy.length} permanent(s).`, you.playerId);
				}
				return;
			}
			case 'exile':
				return this.exile(step);
			case 'bounce': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					p.moveFromBattlefield(s, o, 'hand');
					p.addLog(s, 'cast', `${title} returned ${o.card.name} to its owner's hand.`, you.playerId);
				}
				return;
			}
			case 'move':
				return this.move(step);
			case 'counterSpell': {
				const ids = this.ctx.targets.filter((t) => t.kind === 'stack').map((t) => t.id);
				const countered: Bound[] = [];
				for (const id of ids) {
					const target = s.stack.find((x) => x.id === id || x.sourceInstanceId === id);
					if (!target) continue;
					countered.push({
						id: target.sourceInstanceId,
						lki: {
							controllerId: target.controllerId,
							ownerId: target.ownerId ?? target.controllerId,
							power: 0,
							toughness: 0,
							manaValue: target.card.cmc
						}
					});
					p.counterSpell(s, this.ctx.item, target, you);
				}
				if (step.bindAs) this.bindings.set(step.bindAs, countered);
				return;
			}
			case 'createToken': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				const spec = step.params?.token;
				if (!actor || !spec) return;
				const n = Math.max(0, this.amount(step.amount, 1)) * tokenMultiplier(s, actor.playerId);
				const made: CardInstance[] = [];
				for (let i = 0; i < n; i++) made.push(p.createToken(s, actor, spec));
				if (n > 0) p.addLog(s, 'cast', `${actor.username} created ${n}x ${spec.name}.`, actor.playerId);
				this.bind(step, made);
				return;
			}
			case 'copyPermanent': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				const actor = step.actor ? this.playerRef(step.actor) : you;
				if (!actor) return;
				const notLegendary = Boolean(step.params?.notLegendary);
				for (const o of objs) p.copyPermanentAsToken(s, actor, o, title, notLegendary);
				return;
			}
			case 'putCounters': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const counter = step.params?.counter ?? '+1/+1';
				const n = this.amount(step.amount, 1);
				for (const o of objs) p.addCounters(s, o, counter, n);
				if (step.subject.k === 'all') {
					p.addLog(s, 'cast', `${you.username} put ${n} ${counter} counter(s) on ${objs.length} permanent(s).`, you.playerId);
				}
				return;
			}
			case 'proliferate': {
				const { candidates, defaultIds } = proliferateCandidates(s, you);
				if (
					!you.isBot &&
					this.canPause &&
					candidates.length > 0 &&
					!this.answers[you.playerId]
				) {
					this.pauseForChoice(
						you,
						`${title} — Proliferate`,
						'Choose any number of permanents and/or players with counters to proliferate (CR 701.34a).',
						candidates,
						0,
						candidates.length,
						'battlefield',
						defaultIds
					);
					return;
				}
				const chosenIds = this.answers[you.playerId];
				p.proliferate(s, you, chosenIds);
				return;
			}
			case 'pump': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const pw = this.amount(step.amount);
				const tg = this.amount(step.params?.toughness);
				for (const o of objs) {
					o.tempPowerMod += pw;
					o.tempToughnessMod += tg;
				}
				return;
			}
			case 'grant': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					for (const kw of step.params?.keywords ?? []) {
						if (!o.grantedKeywords.includes(kw)) o.grantedKeywords.push(kw);
					}
				}
				return;
			}
			case 'grantPlayer': {
				const rules = step.params?.playerRules ?? [];
				for (const pl of this.players(step.subject)) {
					if (rules.includes('lifeTotalCantChange')) pl.lifeTotalCannotChangeThisTurn = true;
					if (rules.includes('protectionFromEverything')) pl.protectionFromEverythingThisTurn = true;
					p.addLog(s, 'rule', `${pl.username}'s life total can't change and they have protection from everything until their next turn.`, you.playerId);
				}
				return;
			}
			case 'addMana': {
				const times = Math.max(0, this.amount(step.amount, 1));
				if (step.params?.mana) {
					const mana = step.params.mana;
					const loops = mana.length > 1 ? 1 : times;
					for (let i = 0; i < loops; i++) for (const c of mana) you.manaPool[c] += 1;
					return;
				}
				if (step.params?.manaChoice) {
					const allowed = manaChoiceColors(s, you, step.params.manaChoice);
					if (allowed.length === 0 || times <= 0) return;
					const defaultColor =
						this.ctx.preferredColor && allowed.includes(this.ctx.preferredColor)
							? this.ctx.preferredColor
							: allowed[0];
					let chosen = defaultColor;
					if (!you.isBot && !this.ctx.preferredColor && allowed.length > 1 && this.canPause) {
						const ans = this.answers[you.playerId];
						if (!ans || ans.length === 0) {
							const item = this.saveFrame(this.stepIndex, this.answers);
							const defaultIdx = Math.max(0, allowed.indexOf(defaultColor));
							enqueueChoicePrompt(s, {
								id: p.uid('prompt', s),
								kind: 'chooseMode',
								playerId: you.playerId,
								title: `${title} — Choose Mana Color`,
								description: `Choose a color of mana to add (${allowed.join(', ')}).`,
								continuation: {
									kind: 'effect_choice',
									stackItemId: item.id,
									stepIndex: this.stepIndex
								},
								choice: {
									kind: 'chooseMode',
									modes: allowed,
									min: 1,
									max: 1,
									defaultIndices: [defaultIdx]
								}
							});
							this.result.paused = true;
							return;
						}
						const picked = ans[0] as ManaColor;
						if (allowed.includes(picked)) chosen = picked;
					}
					you.manaPool[chosen] += times;
				}
				return;
			}
			case 'attach': {
				const equipment = p.findPermanent(s, this.ctx.sourceId);
				const target = this.objects(step.subject)[0];
				const found = target ? p.findPermanent(s, target.instanceId) : null;
				if (!equipment || !found) return;
				if (found.controller.playerId !== you.playerId || !evaluatePermanent(s, found.inst).typeLine.includes('Creature')) return;
				// CR 701.3b: Attaching an Aura, Equipment, or Fortification to an object it's already attached to does nothing.
				if (equipment.inst.attachedToId === found.inst.instanceId) return;
				const wasAttached = Boolean(equipment.inst.attachedToId);
				equipment.inst.attachedToId = found.inst.instanceId;
				// CR 613.7e: Receives a new timestamp when it becomes attached to a different object.
				if (wasAttached) {
					const ts = allocateTimestamp(s);
					equipment.inst.enteredTimestamp = ts;
					(equipment.inst as CardInstance & { timestamp?: number }).timestamp = ts;
				}
				p.addLog(s, 'cast', `${you.username} attached ${equipment.inst.card.name} to ${found.inst.card.name}.`, you.playerId);
				p.triggerOnAttach(s, you, equipment.inst, found.inst);
				return;
			}
			case 'phaseOut': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield' && !o.phasedOut);
				for (const o of objs) p.phaseOut(s, o);
				if (objs.length > 0) p.addLog(s, 'rule', `${title} phased out ${objs.length} permanent(s) (CR 702.26).`, you.playerId);
				return;
			}
			case 'switchPT': {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				for (const o of objs) {
					o.switchedPTCount = (o.switchedPTCount || 0) + 1;
					p.addLog(s, 'cast', `${title} switched ${o.card.name}'s power and toughness until end of turn (Layer 7d).`, you.playerId);
				}
				return;
			}
			case 'extraTurn':
				for (const pl of this.players(step.subject)) {
					if (!s.extraTurnQueue) s.extraTurnQueue = [];
					// CR 500.7: the most recently created extra turn is taken first.
					s.extraTurnQueue.push(pl.playerId);
					p.addLog(s, 'rule', `${pl.username} will take an extra turn after this one (CR 500.7)!`, you.playerId);
				}
				return;
			case 'endTurn':
				if (step.params?.activePlayerMay) {
					p.activePlayerMayEndTurn(s, you, this.ctx.sourceCard.name);
					return;
				}
				p.endTurn(s, you.playerId);
				this.result.turnEnded = true;
				return;
			case 'win':
			case 'lose': {
				if (step.params?.condition && !this.condition(step.params.condition)) return;
				for (const pl of this.players(step.subject)) {
					if (step.verb === 'win') p.win(s, pl, `${title} win condition`);
					else p.lose(s, pl, `${title} ("you lose the game")`);
				}
				return;
			}
			case 'sacrifice':
				return this.sacrifice(step);
			case 'discard':
				return this.discard(step);
			case 'tap':
			case 'untap':
			case 'tapOrUntap' as Verb: {
				const objs = this.objects(step.subject).filter((o) => o.zone === 'battlefield');
				this.bind(step, objs);
				const shouldTap =
					step.verb === 'tap'
						? true
						: step.verb === 'untap'
							? false
							: Boolean((step.params as { tap?: boolean } | undefined)?.tap);
				for (const o of objs) {
					if (shouldTap) {
						o.tapped = true;
					} else if (o.tapped) {
						// CR 122.1d: If a permanent with a stun counter on it would become untapped,
						// instead remove a stun counter from it.
						if ((o.counters.stun || 0) > 0) {
							o.counters.stun = Math.max(0, (o.counters.stun || 0) - 1);
							p.addLog(
								s,
								'rule',
								`A stun counter was removed from ${o.card.name} instead of untapping it (CR 122.1d).`,
								you.playerId
							);
						} else {
							o.tapped = false;
						}
					}
				}
				return;
			}
			case 'mill':
				for (const pl of this.players(step.subject)) {
					const n = Math.min(this.amount(step.amount), pl.library.length);
					for (let i = 0; i < n; i++) {
						moveObject(s, pl.library[0], 'graveyard', {
							from: { player: pl, zone: 'library' },
							toPlayer: pl,
							graveyardReplacement: true,
							bumpVersion: true,
							newTimestamp: true
						});
					}
					if (n > 0) p.addLog(s, 'rule', `${pl.username} milled ${n} card(s).`, you.playerId);
				}
				return;
			case 'scry':
			case 'lookAndReorder': {
				const n = this.amount(step.amount);
				for (const pl of this.players(step.subject)) {
					p.scry(s, pl, this.ctx.item, n, step.verb === 'scry' ? 'scry' : 'rearrange', Boolean(step.params?.mayShuffle));
				}
				return;
			}
			case 'search': {
				const actor = step.actor ? this.playerRef(step.actor) : you;
				if (!actor || actor.lost) return;
				const search = step.params?.search;
				if (!search) return;
				p.search(s, actor, legacySearchSpec(search), this.ctx.item);
				return;
			}
			case 'delayedTrigger':
				return this.delayed(step);
			case 'dig':
				return this.dig(step);
			default:
				// Not reachable: staticallyInterpretable rejects every other verb.
				p.addLog(s, 'rule', `${title}: the "${step.verb}" step isn't supported yet and did nothing.`, you.playerId);
		}
	}

	sourceDamageInfo(
		sourcePerm: CardInstance | null,
		sourceCard: ScryfallCard
	): SourceDamageInfo {
		return sourceDamageInfo(this.state, sourcePerm, sourceCard);
	}

	permanentProtectedFromSource(
		target: CardInstance,
		srcInfo: SourceDamageInfo
	): boolean {
		return permanentProtectedFromSource(this.state, target, srcInfo);
	}

	dealDamageToPermanent(
		target: CardInstance,
		rawAmount: number,
		sourceId: string,
		srcInfo: SourceDamageInfo
	): number {
		return dealDamageToPermanent(this.state, target, rawAmount, sourceId, srcInfo, {
			combat: false,
			actorId: this.you.playerId
		});
	}

	dealDamageToPlayer(
		pl: PlayerGameState,
		rawAmount: number,
		sourceId: string,
		srcInfo: SourceDamageInfo
	): number {
		return dealDamageToPlayer(this.state, pl, rawAmount, sourceId, srcInfo, {
			combat: false,
			vfxSourceId: this.you.playerId
		});
	}

	applyLifelinkGain(controller: PlayerGameState, totalDealt: number): void {
		applyLifelinkGain(this.state, controller, totalDealt);
	}

	damage(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const n = this.amount(step.amount);
		if (n <= 0) return;
		const sel = step.subject;
		const srcPerm = this.locate(this.ctx.sourceId)?.inst ?? null;
		const srcInfo = this.sourceDamageInfo(srcPerm, this.ctx.sourceCard);
		const srcController =
			srcPerm && srcPerm.zone === 'battlefield'
				? (this.player(srcPerm.controllerId) ?? you)
				: you;
		let totalDealt = 0;

		if (sel.k === 'target' && !this.ctx.overload) {
			const targetRefs =
				this.ctx.targetSpecs.length > 1
					? this.ctx.targets.length === this.ctx.targetSpecs.length
						? [this.ctx.targets[sel.index]].filter(Boolean)
						: this.ctx.targets.filter((t) => targetRefMatchesSpec(t, this.ctx.targetSpecs[sel.index]))
					: this.ctx.targets;
			for (const t of targetRefs) {
				if (t.kind === 'player') {
					const pl = this.player(t.id);
					if (pl) totalDealt += this.dealDamageToPlayer(pl, n, this.ctx.sourceId, srcInfo);
				} else if (t.kind === 'permanent') {
					const perm = this.locate(t.id)?.inst;
					if (perm && perm.zone === 'battlefield') {
						totalDealt += this.dealDamageToPermanent(perm, n, this.ctx.sourceId, srcInfo);
					}
				}
			}
			if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
			return;
		}
		if (sel.k === 'player' || sel.k === 'playerRef') {
			for (const pl of this.players(sel)) {
				totalDealt += this.dealDamageToPlayer(pl, n, this.ctx.sourceId, srcInfo);
			}
			if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
			return;
		}
		const objs = this.objects(sel).filter((o) => o.zone === 'battlefield');
		for (const o of objs) {
			totalDealt += this.dealDamageToPermanent(o, n, this.ctx.sourceId, srcInfo);
		}
		if (srcInfo.hasLifelink) this.applyLifelinkGain(srcController, totalDealt);
		if (sel.k === 'all') {
			p.addLog(s, 'combat', `${this.ctx.title} dealt ${n} damage to ${objs.length} permanent(s)!`, you.playerId);
		}
	}

	resolveSingleFighter(sel: Selector): CardInstance | null {
		if (sel.k === 'target') {
			const t = this.ctx.targets[sel.index];
			if (!t || t.kind === 'player' || t.kind === 'stack') return null;
			const inst = this.locate(t.id)?.inst ?? null;
			return inst && !inst.phasedOut ? inst : null;
		}
		return this.objects(sel)[0] ?? null;
	}

	fight(step: EffectStep): void {
		const s = this.state;
		const withSel = step.params?.with;
		let fighterA: CardInstance | null = null;
		let fighterB: CardInstance | null = null;
		if (withSel) {
			fighterA = this.resolveSingleFighter(step.subject);
			fighterB = this.resolveSingleFighter(withSel);
		} else if (step.subject.k === 'target' && this.ctx.targets.length >= 2) {
			fighterA = this.resolveSingleFighter({ k: 'target', index: 0 });
			fighterB = this.resolveSingleFighter({ k: 'target', index: 1 });
		}
		// CR 701.12b: If one or both creatures are no longer on the battlefield or no longer creatures,
		// neither of them deals or is dealt damage.
		if (!fighterA || !fighterB) return;
		if (fighterA.zone !== 'battlefield' || fighterB.zone !== 'battlefield') return;
		if (fighterA.phasedOut || fighterB.phasedOut) return;
		const evA = evaluatePermanent(s, fighterA);
		const evB = evaluatePermanent(s, fighterB);
		if (!evA.isCreature || !evB.isCreature) return;

		const powerA = Math.max(0, evA.breakdown.effectivePower ?? 0);
		const powerB = Math.max(0, evB.breakdown.effectivePower ?? 0);
		const infoA = this.sourceDamageInfo(fighterA, fighterA.copiableCard ?? fighterA.card);
		const infoB = this.sourceDamageInfo(fighterB, fighterB.copiableCard ?? fighterB.card);
		const ctrlA = this.player(fighterA.controllerId) ?? this.you;
		const ctrlB = this.player(fighterB.controllerId) ?? this.you;

		// CR 701.12c: If a creature fights itself, it deals damage to itself equal to twice its power.
		if (fighterA.instanceId === fighterB.instanceId) {
			const dealt = this.dealDamageToPermanent(fighterA, powerA * 2, fighterA.instanceId, infoA);
			if (infoA.hasLifelink) this.applyLifelinkGain(ctrlA, dealt);
			return;
		}

		// Simultaneous fight damage (power and source keywords snapshotted before either deals damage)
		const dealtByA = this.dealDamageToPermanent(fighterB, powerA, fighterA.instanceId, infoA);
		const dealtByB = this.dealDamageToPermanent(fighterA, powerB, fighterB.instanceId, infoB);
		if (infoA.hasLifelink) this.applyLifelinkGain(ctrlA, dealtByA);
		if (infoB.hasLifelink) this.applyLifelinkGain(ctrlB, dealtByB);
	}

	sacrifice(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;

		// Specific object(s) (e.g. "sacrifice ~" or "sacrifice it")
		if (sel.k === 'self' || sel.k === 'binding' || sel.k === 'target') {
			const actor = step.actor ? (this.playerRef(step.actor) ?? you) : you;
			const objs = this.objects(sel).filter(
				(o) => o.zone === 'battlefield' && o.controllerId === actor.playerId
			);
			this.bind(step, objs);
			for (const o of objs) {
				p.moveFromBattlefield(s, o, 'graveyard');
				p.addLog(s, 'rule', `${actor.username} sacrificed ${o.card.name}.`, actor.playerId);
			}
			return;
		}

		// Player-driven or filter-driven sacrifice ("Sacrifice a creature", "Each opponent sacrifices a creature")
		const actors = step.actor
			? this.players({ k: 'playerRef', ref: step.actor })
			: sel.k === 'player' || sel.k === 'playerRef'
				? this.players(sel)
				: sel.k === 'all' && sel.filter.controller === 'opponent'
					? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
					: [you];

		const filter: ObjectFilter =
			sel.k === 'all' ? { ...sel.filter, controller: undefined } : {};

		// CR 701.21a / 101.4: each player chooses (in turn order), then all are sacrificed at once. A
		// human with a real choice gets a prompt; resolution pauses until every such human answered.
		const choices: Array<{ actor: PlayerGameState; candidates: CardInstance[]; count: number }> = [];
		for (const actor of actors) {
			const candidates = actor.battlefield.filter(
				(c) => !c.phasedOut && c.controllerId === actor.playerId && this.matches(c, filter, 'battlefield')
			);
			if (candidates.length === 0) continue;
			const count =
				sel.k === 'all' && !step.amount
					? candidates.length
					: Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
			if (count <= 0) continue;
			choices.push({ actor, candidates, count });
		}
		const atRandom = Boolean((step.params as { atRandom?: boolean } | undefined)?.atRandom);
		if (!atRandom && this.canPause) {
			for (const { actor, candidates, count } of choices) {
				if (actor.isBot || candidates.length <= count || this.answers[actor.playerId]) continue;
				const title = `${this.ctx.title} — Sacrifice ${count} permanent(s)`;
				this.pauseForChoice(actor, title, `Choose ${count} permanent(s) to sacrifice.`, candidates.map((c) => c.instanceId), count, count, 'battlefield');
				return;
			}
		}
		const sacrificed: Array<{ actor: PlayerGameState; objs: CardInstance[] }> = [];
		for (const { actor, candidates, count } of choices) {
			let chosen: CardInstance[];
			if (atRandom) {
				const pool = [...candidates];
				chosen = [];
				for (let i = 0; i < count && pool.length > 0; i++) {
					const idx = Math.floor(nextRandom(s) * pool.length);
					chosen.push(pool.splice(idx, 1)[0]);
				}
			} else {
				chosen = this.answered(actor, candidates, count) ?? candidates.slice(0, count);
			}
			sacrificed.push({ actor, objs: chosen });
		}
		this.bind(step, sacrificed.flatMap((x) => x.objs));
		for (const { actor, objs } of sacrificed) {
			for (const o of objs) {
				p.moveFromBattlefield(s, o, 'graveyard');
				p.addLog(s, 'rule', `${actor.username} sacrificed ${o.card.name}.`, actor.playerId);
			}
		}
	}

	discard(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;

		const discardCard = (pl: PlayerGameState, cardInst: CardInstance) => {
			if (!pl.hand.includes(cardInst)) return;
			moveObject(s, cardInst, 'graveyard', {
				from: { player: pl, zone: 'hand' },
				toPlayer: pl,
				graveyardReplacement: true,
				bumpVersion: true,
				newTimestamp: true
			});
		};

		if (sel.k === 'self' || sel.k === 'binding') {
			const objs = this.objects(sel).filter((o) => o.zone === 'hand');
			this.bind(step, objs);
			for (const o of objs) {
				const holder = this.locate(o.instanceId)?.holder;
				if (holder) {
					discardCard(holder, o);
					p.addLog(s, 'rule', `${holder.username} discarded ${o.card.name}.`, holder.playerId);
				}
			}
			return;
		}

		const actors = step.actor
			? this.players({ k: 'playerRef', ref: step.actor })
			: sel.k === 'player' || sel.k === 'playerRef' || sel.k === 'target'
				? this.players(sel)
				: sel.k === 'all' && sel.filter.controller === 'opponent'
					? this.players({ k: 'player', filter: { relation: 'each_opponent' } })
					: [you];

		const filter: ObjectFilter | null =
			sel.k === 'all' ? { ...sel.filter, controller: undefined, owner: undefined } : null;

		// CR 701.8: each player chooses (in turn order), then all discard at once. A human with a real
		// choice gets a prompt; resolution pauses until every such human answered.
		const choices: Array<{ pl: PlayerGameState; candidates: CardInstance[]; count: number }> = [];
		for (const pl of actors) {
			const candidates = filter
				? pl.hand.filter((c) => this.matches(c, filter, 'hand'))
				: [...pl.hand];
			if (candidates.length === 0) continue;
			const count =
				sel.k === 'all' && !step.amount
					? candidates.length
					: Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
			if (count <= 0) continue;
			choices.push({ pl, candidates, count });
		}
		const atRandom = Boolean(step.params?.atRandom);
		if (!atRandom && this.canPause) {
			for (const { pl, candidates, count } of choices) {
				if (pl.isBot || candidates.length <= count || this.answers[pl.playerId]) continue;
				const title = `${this.ctx.title} — Discard ${count} card(s)`;
				this.pauseForChoice(pl, title, `Choose ${count} card(s) to discard.`, candidates.map((c) => c.instanceId), count, count, 'hand');
				return;
			}
		}
		const discarded: Array<{ pl: PlayerGameState; cards: CardInstance[] }> = [];
		for (const { pl, candidates, count } of choices) {
			let chosen: CardInstance[];
			if (atRandom) {
				const pool = [...candidates];
				chosen = [];
				for (let i = 0; i < count && pool.length > 0; i++) {
					const idx = Math.floor(nextRandom(s) * pool.length);
					chosen.push(pool.splice(idx, 1)[0]);
				}
			} else {
				chosen = this.answered(pl, candidates, count) ?? candidates.slice(0, count);
			}
			discarded.push({ pl, cards: chosen });
		}
		this.bind(step, discarded.flatMap((x) => x.cards));
		for (const { pl, cards } of discarded) {
			for (const c of cards) discardCard(pl, c);
			p.addLog(s, 'rule', `${pl.username} discarded ${cards.length} card(s)${atRandom ? ' at random' : ''}.`, pl.playerId);
		}
	}

	exile(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const sel = step.subject;
		if (sel.k === 'self' && this.ctx.item.kind === 'spell') {
			// The spell itself, as it finishes resolving (CR 608.2n).
			this.result.exileSelf = true;
			return;
		}
		if (sel.k === 'all' && sel.filter.zone === 'graveyard') {
			let total = 0;
			for (const pl of s.players) {
				// Top card first, so exile receives the graveyard in reverse order (legacy behaviour).
				while (pl.graveyard.length > 0) {
					moveObject(s, pl.graveyard[pl.graveyard.length - 1], 'exile', { from: { player: pl, zone: 'graveyard' }, toPlayer: pl, bumpVersion: true });
					total++;
				}
			}
			p.addLog(s, 'trigger', `${this.ctx.title} exiled all ${total} card(s) from all graveyards!`, you.playerId);
			return;
		}
		const objs = this.objects(sel);
		this.bind(step, objs);
		for (const o of objs) {
			if (o.zone === 'battlefield') {
				p.emitVfx(s, { kind: 'exile', targetId: o.instanceId, label: o.card.name });
				p.moveFromBattlefield(s, o, 'exile');
			} else if (o.zone === 'graveyard') {
				const holder = this.locate(o.instanceId)!.holder;
				moveObject(s, o, 'exile', { from: { player: holder, zone: 'graveyard' }, toPlayer: holder, bumpVersion: true, newTimestamp: true });
			} else {
				continue;
			}
			p.addLog(s, 'cast', `${this.ctx.title} exiled ${o.card.name}.`, you.playerId);
		}
	}

	move(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const you = this.you;
		const params = step.params ?? {};
		if (params.from === 'hand') {
			const filter: ObjectFilter = step.subject.k === 'all' ? step.subject.filter : {};
			const candidates = you.hand.filter((c) => this.matches(c, filter, 'hand'));
			const max = Math.min(candidates.length, Math.max(0, this.amount(step.amount, 1)));
			const min = params.upTo ? 0 : max;
			if (max <= 0) return;
			if (
				!you.isBot &&
				this.canPause &&
				!this.answers[you.playerId] &&
				(min < max || candidates.length > max || (params.to === 'library' && max > 1))
			) {
				const title = `${this.ctx.title} — Choose card(s) from hand`;
				this.pauseForChoice(
					you,
					title,
					`Choose ${min === max ? max : `up to ${max}`} card(s) from your hand.`,
					candidates.map((c) => c.instanceId),
					min,
					max,
					'hand'
				);
				return;
			}
			let chosen: CardInstance[];
			if (this.answers[you.playerId]) {
				chosen = this.answered(you, candidates, min, max) ?? [];
			} else if (params.to === 'battlefield') {
				chosen = [...candidates].sort((a, b) => b.card.cmc - a.card.cmc).slice(0, max);
			} else {
				chosen = candidates.slice(0, max);
			}
			this.bind(step, chosen);
			if (params.to === 'library') {
				const top = params.position !== 'bottom';
				// Put onto top in reverse so chosen[0] ends up at library[0].
				const ordered = top ? [...chosen].reverse() : chosen;
				for (const c of ordered) {
					moveObject(s, c, 'library', {
						from: { player: you, zone: 'hand' },
						toPlayer: you,
						insert: top ? 'start' : 'end',
						commanderRedirect: true,
						bumpVersion: true,
						newTimestamp: true
					});
				}
				if (chosen.length > 0) {
					p.addLog(
						s,
						'rule',
						`${you.username} put ${chosen.length} card(s) from hand on ${top ? 'top' : 'the bottom'} of their library (${this.ctx.title}).`,
						you.playerId
					);
				}
				return;
			}
			if (this.canPause && !you.isBot) {
				for (const o of chosen) {
					if (!(o.copiableCard ?? o.card).typeLine.includes('Aura')) continue;
					const attachCands = p.legalAuraAttachCandidates(s, o, you);
					const auraKey = `aura:${o.instanceId}`;
					if (attachCands.length > 0 && !this.answers[auraKey]) {
						this.pauseForChoice(
							you,
							`${this.ctx.title} — Choose what Aura will enchant`,
							`Choose a legal object or player for ${o.card.name} to enchant as it enters the battlefield (CR 303.4f).`,
							attachCands,
							1,
							1,
							'battlefield',
							[attachCands[0]],
							auraKey
						);
						return;
					}
				}
			}
			for (const o of chosen) {
				const isAura = (o.copiableCard ?? o.card).typeLine.includes('Aura');
				if (isAura) {
					const attachCands = p.legalAuraAttachCandidates(s, o, you);
					if (attachCands.length === 0) {
						p.addLog(
							s,
							'rule',
							`${o.card.name} remained in ${you.username}'s hand because there is no legal object or player for it to enchant (CR 303.4g).`,
							you.playerId
						);
						continue;
					}
					const pickedId = (this.answers[`aura:${o.instanceId}`] ?? [])[0];
					o.attachedToId = pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0];
				}
				o.summoningSick = o.card.typeLine.includes('Creature');
				o.tapped = Boolean(params.tapped);
				o.defaultControllerId = you.playerId;
				moveObject(s, o, 'battlefield', {
					from: { player: you, zone: 'hand' },
					toPlayer: you,
					controllerId: you.playerId,
					newTimestamp: true,
					bumpVersion: true
				});
				p.addLog(s, 'cast', `${you.username} put ${o.card.name} from their hand onto the battlefield (${this.ctx.title}).`, you.playerId);
				if (isAura && o.attachedToId) {
					const host = p.findPermanent(s, o.attachedToId);
					if (host) p.triggerOnAttach(s, you, o, host.inst);
				}
				p.triggerOnEtb(s, you, o);
			}
			return;
		}
		let objs = this.objects(step.subject).filter((o) => o.zone === 'graveyard');
		if (params.topmostOnly) {
			// CR 404.2: the graveyard's order matters; the top card is the last one in the array.
			objs = objs.length > 0 ? [objs[objs.length - 1]] : [];
		}
		if (params.to !== 'hand' && this.canPause) {
			for (const o of objs) {
				const holder = this.locate(o.instanceId)?.holder;
				if (!holder) continue;
				const controller = params.underYourControl ? you : (this.player(o.ownerId) ?? holder);
				if (!(o.copiableCard ?? o.card).typeLine.includes('Aura')) continue;
				const attachCands = p.legalAuraAttachCandidates(s, o, controller);
				const auraKey = `aura:${o.instanceId}`;
				if (attachCands.length > 0 && !controller.isBot && !this.answers[auraKey]) {
					this.pauseForChoice(
						controller,
						`${this.ctx.title} — Choose what ${o.card.name} will enchant`,
						`Choose a legal object or player for ${o.card.name} to enchant as it enters the battlefield (CR 303.4f).`,
						attachCands,
						1,
						1,
						'battlefield',
						[attachCands[0]],
						auraKey
					);
					return;
				}
			}
		}
		this.bind(step, objs);
		for (const o of objs) {
			const holder = this.locate(o.instanceId)!.holder;
			if (params.to === 'hand') {
				moveObject(s, o, 'hand', { from: { player: holder, zone: 'graveyard' }, toPlayer: holder, commanderRedirect: true, bumpVersion: true, newTimestamp: true });
				p.addLog(s, 'cast', `${this.ctx.title} returned ${o.card.name} from ${holder.username}'s graveyard to hand.`, you.playerId);
				continue;
			}
			const controller = params.underYourControl ? you : (this.player(o.ownerId) ?? holder);
			const isAura = (o.copiableCard ?? o.card).typeLine.includes('Aura');
			if (isAura) {
				const attachCands = p.legalAuraAttachCandidates(s, o, controller);
				if (attachCands.length === 0) {
					p.addLog(
						s,
						'rule',
						`${o.card.name} remained in ${holder.username}'s graveyard because there is no legal object or player for it to enchant (CR 303.4g).`,
						controller.playerId
					);
					continue;
				}
				const pickedId = (this.answers[`aura:${o.instanceId}`] ?? [])[0];
				o.attachedToId = pickedId && attachCands.includes(pickedId) ? pickedId : attachCands[0];
			}
			o.summoningSick = o.card.typeLine.includes('Creature') && !o.card.keywords.includes('Haste');
			o.tapped = Boolean(params.tapped);
			o.defaultControllerId = controller.playerId;
			moveObject(s, o, 'battlefield', {
				from: { player: holder, zone: 'graveyard' },
				toPlayer: controller,
				controllerId: controller.playerId,
				newTimestamp: true,
				bumpVersion: true
			});
			p.addLog(s, 'cast', `${controller.username} put ${o.card.name} onto the battlefield from ${holder.username}'s graveyard (${this.ctx.title}).`, you.playerId);
			if (isAura && o.attachedToId) {
				const host = p.findPermanent(s, o.attachedToId);
				if (host) p.triggerOnAttach(s, controller, o, host.inst);
			}
			p.triggerOnEtb(s, controller, o);
		}
	}

	dig(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const dig = step.params?.dig;
		if (!dig) return;
		const pl = this.players(step.subject)[0] ?? this.you;
		const count = Math.min(Math.max(0, this.amount(step.amount)), pl.library.length);
		if (count <= 0) return;
		const topCards = pl.library.slice(0, count);
		const max = Math.min(dig.keep, count);
		const min = dig.upTo ? 0 : max;
		if (!pl.isBot && this.canPause && !this.answers[pl.playerId]) {
			const title = `${this.ctx.title} — Look at top ${count} card(s)`;
			this.pauseForChoice(
				pl,
				title,
				`Choose ${min === max ? max : `up to ${max}`} card(s) to put on top of your library; the rest go on the bottom.`,
				topCards.map((c) => c.instanceId),
				min,
				max,
				'library'
			);
			return;
		}
		const kept = this.answered(pl, topCards, min, max) ?? topCards.slice(0, max);
		const rest = topCards.filter((c) => !kept.includes(c));
		if (dig.restRandom && rest.length > 1) {
			for (let i = rest.length - 1; i > 0; i--) {
				const j = Math.floor(nextRandom(s) * (i + 1));
				[rest[i], rest[j]] = [rest[j], rest[i]];
			}
		}
		rearrangeLibrary(pl, topCards, kept, rest);
		p.addLog(
			s,
			'rule',
			`${pl.username} looked at the top ${count} card(s) of their library (${kept.length} on top, ${rest.length} on bottom).`,
			pl.playerId
		);
	}

	delayed(step: EffectStep): void {
		const s = this.state;
		const p = P();
		const d = step.delayed!;
		const e = d.effect[0];
		const thatTurn = d.trigger.scope === 'controller_turn';
		const phase = d.trigger.filter.phase ?? 'end_step';
		const waitAfter = thatTurn ? s.turnNumber : undefined;
		const base = {
			controllerId: this.you.playerId,
			sourceInstanceId: this.ctx.sourceId,
			sourceCard: this.ctx.sourceCard,
			triggerPhase: phase,
			createdAtTurn: s.turnNumber,
			// "That turn's end step" (after an extra turn): the controller's next turn, not this one.
			targetPlayerId: thatTurn ? this.you.playerId : undefined,
			waitUntilAfterTurn: waitAfter,
			// "The next turn's upkeep": not this turn's (turnNumber counts rounds, so name the turn).
			...(d.nextTurn ? { notDuringTurn: `${s.turnNumber}:${s.activePlayerIndex}` } : {})
		};
		if (!s.delayedTriggers) s.delayedTriggers = [];
		if (e.verb === 'exile' && e.subject.k === 'binding') {
			for (const b of this.bindings.get(e.subject.name) ?? []) {
				const found = this.locate(b.id);
				const label = found ? found.inst.card.name : 'it';
				const dt: DelayedTrigger = {
					id: p.uid('dtrig', s),
					...base,
					targetInstanceId: b.id,
					title: `${this.ctx.title} — Delayed Exile Trigger`,
					description: `At the beginning of the next end step, exile ${label}.`,
					// CR 400.7: "it" is the object as it is now; if it changes zones again it's a new object.
					delayedEffect: {
						kind: 'exile',
						targetInstanceId: b.id,
						...(found?.zone === 'battlefield' ? { targetObjectVersion: found.inst.objectVersion } : {})
					}
				};
				s.delayedTriggers.push(dt);
			}
			return;
		}
		if (e.verb === 'lose') {
			s.delayedTriggers.push({
				id: p.uid('dtrig', s),
				...base,
				title: `${this.ctx.title} — Delayed End Step Trigger`,
				description: 'At the beginning of the end step, you lose the game.',
				delayedEffect: { kind: 'lose' }
			});
			return;
		}
		if (e.verb === 'draw') {
			const amount = Math.max(0, this.amount(e.amount, 1));
			const upTo = Boolean(e.params?.upTo);
			for (const pl of this.players(e.subject)) {
				s.delayedTriggers.push({
					id: p.uid('dtrig', s),
					...base,
					title: `${this.ctx.title} — Delayed Upkeep Trigger`,
					description: `At the beginning of the next turn's upkeep, ${pl.username} draws ${upTo ? `up to ${amount}` : amount} card(s).`,
					delayedEffect: { kind: 'draw', playerId: pl.playerId, amount, upTo }
				});
			}
		}
	}

	condition(c: Condition): boolean {
		switch (c.k) {
			case 'compare':
				return compare(this.amount(c.left), c.op, this.amount(c.right));
			case 'and':
				return c.of.every((x) => this.condition(x));
			case 'or':
				return c.of.some((x) => this.condition(x));
			case 'not':
				return !this.condition(c.of);
			case 'isTurnOf': {
				const p = this.playerRef(c.player);
				return Boolean(p && this.state.players[this.state.activePlayerIndex]?.playerId === p.playerId);
			}
			case 'graveyardAbove':
				return false;
		}
	}
}

function compare(a: number, op: '>=' | '<=' | '=' | '>' | '<', b: number): boolean {
	switch (op) {
		case '>=':
			return a >= b;
		case '<=':
			return a <= b;
		case '=':
			return a === b;
		case '>':
			return a > b;
		case '<':
			return a < b;
	}
}

/** CR 700.5: mana symbols of the colours among the mana costs of permanents the player controls. */
export function devotion(player: PlayerGameState, colors: ManaColor[]): number {
	let total = 0;
	for (const perm of player.battlefield) {
		if (perm.phasedOut || perm.isFaceDown) continue;
		const cost = (perm.copiableCard ?? perm.card).manaCost ?? '';
		for (const sym of cost.match(/\{[^}]+\}/g) ?? []) {
			const upper = sym.toUpperCase();
			if (colors.some((c) => upper.includes(c))) total++;
		}
	}
	return total;
}

export const countDevotion = devotion;

const FIVE_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
const BASIC_LAND_COLORS: Array<[string, ManaColor]> = [
	['Plains', 'W'],
	['Island', 'U'],
	['Swamp', 'B'],
	['Mountain', 'R'],
	['Forest', 'G']
];

function commanderColors(player: PlayerGameState): ManaColor[] {
	const set = new Set<ManaColor>();
	for (const col of player.commanderColorIdentity ?? []) {
		if (col !== 'C') set.add(col);
	}
	const cards = [
		...player.command,
		...player.battlefield.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.graveyard.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.exile.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.hand.filter((c) => c.isCommander && c.ownerId === player.playerId),
		...player.library.filter((c) => c.isCommander && c.ownerId === player.playerId)
	];
	for (const c of cards) {
		for (const col of c.card.colorIdentity) {
			if (col !== 'C') set.add(col);
		}
	}
	return FIVE_COLORS.filter((c) => set.has(c));
}

function playerLandColors(
	state: GameState,
	player: PlayerGameState
): { direct: Set<ManaColor>; hasOrchard: boolean } {
	const direct = new Set<ManaColor>();
	let hasOrchard = false;
	for (const perm of player.battlefield) {
		if (perm.phasedOut) continue;
		const ev = evaluatePermanent(state, perm);
		if (!ev.typeLine.includes('Land')) continue;
		for (const [sub, col] of BASIC_LAND_COLORS) {
			if (ev.hasSubType(sub) || ev.typeLine.includes(sub)) direct.add(col);
		}
		const bd = inspectCardContinuousBreakdown(perm, state);
		if (bd.items.some((i) => !i.removed && i.canonicalKey === 'mana_any')) {
			for (const c of FIVE_COLORS) direct.add(c);
		}
		if (ev.losesAllAbilities) continue;
		for (const step of cardManaSteps(perm.card)) {
			const mana = step.params?.mana;
			if (mana) {
				for (const c of mana) if (c !== 'C') direct.add(c);
			}
			const choice = step.params?.manaChoice;
			if (!choice) continue;
			if (Array.isArray(choice)) {
				for (const c of choice) if (c !== 'C') direct.add(c);
			} else if (choice === 'any') {
				for (const c of FIVE_COLORS) direct.add(c);
			} else if (choice === 'commanderIdentity') {
				for (const c of commanderColors(player)) direct.add(c);
			} else if (choice === 'opponentLandColors') {
				hasOrchard = true;
			}
		}
	}
	return { direct, hasOrchard };
}

/**
 * CR 106.7: colours (`W | U | B | R | G`, never `C`) that any land an opponent of `controller`
 * controls could produce right now, accounting for continuous effects and opponent Exotic Orchards.
 */
export function opponentLandColors(state: GameState, controller: PlayerGameState): ManaColor[] {
	const active = state.players.filter((p) => !p.lost);
	const byPlayer = new Map(active.map((p) => [p.playerId, playerLandColors(state, p)]));
	const out = new Set<ManaColor>();
	for (const opp of active) {
		if (opp.playerId === controller.playerId) continue;
		const info = byPlayer.get(opp.playerId)!;
		for (const c of info.direct) out.add(c);
		if (info.hasOrchard) {
			for (const other of active) {
				if (other.playerId === opp.playerId) continue;
				for (const c of byPlayer.get(other.playerId)!.direct) out.add(c);
			}
		}
	}
	return FIVE_COLORS.filter((c) => out.has(c));
}

export function manaChoiceColors(
	state: GameState,
	controller: PlayerGameState,
	choice: NonNullable<NonNullable<EffectStep['params']>['manaChoice']>
): ManaColor[] {
	if (Array.isArray(choice)) return choice;
	if (choice === 'any') return [...FIVE_COLORS];
	if (choice === 'commanderIdentity') {
		return commanderColors(controller);
	}
	return opponentLandColors(state, controller);
}

/**
 * Runs `steps` in order against `state`. With `resume` (a stack item's `effectResume`), continues a
 * paused resolution at the step that asked for a choice, with the stored bindings and answers.
 */
export function executeEffectSteps(state: GameState, ctx: EffectContext, steps: EffectStep[], resume?: EffectResumeFrame): EffectResult {
	const run = new Run(state, ctx, resume);
	run.run(steps);
	return run.result;
}
