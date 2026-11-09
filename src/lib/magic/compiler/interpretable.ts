/**
 * What the IR effect interpreter (runtime/effects.ts) can run, judged from the IR alone
 * (ENGINE_ARCHITECTURE_PLAN.md Phase 10, step F).
 *
 * This is the single source of truth for "is this ability automated?": the compiler marks an
 * ability `unsupported` exactly when these checks fail (compiler/card.ts), so the deck builder and
 * inspector labels (compiler/support.ts) and the runtime decision (interpreter or manual
 * resolution, engine.ts) can't disagree. Pure IR; no game state, no rules text.
 */
import type { EffectStep, ModalDef, Selector, TargetSpec, Verb } from '../ir.ts';

/**
 * Verbs that resolve on the interpreter. An ability that uses any other verb resolves on the
 * legacy executeParsedEffect path.
 */
export const INTERPRETED_VERBS: ReadonlySet<Verb> = new Set<Verb>([
	'draw',
	'gainLife',
	'loseLife',
	'damage',
	'destroy',
	'exile',
	'bounce',
	'move',
	'counterSpell',
	'createToken',
	'copyPermanent',
	'putCounters',
	'proliferate',
	'pump',
	'grant',
	'grantPlayer',
	'addMana',
	'attach',
	'phaseOut',
	'switchPT',
	'extraTurn',
	'endTurn',
	'win',
	'lose',
	'sacrifice',
	'mill',
	'scry',
	'lookAndReorder',
	'search',
	'delayedTrigger',
	'fight',
	'discard',
	'tap',
	'untap',
	'tapOrUntap' as Verb,
	'dig'
]);

/**
 * Target specs a triggered ability can choose when it is put on the stack (the zones the engine's
 * candidate list enumerates: battlefield, graveyard, players).
 */
export function triggerTargetsSupported(specs: TargetSpec[]): boolean {
	return specs.every((sp) => {
		if (sp.kind === 'player') return true;
		const z = sp.filter.zone ?? 'battlefield';
		return z === 'battlefield' || z === 'graveyard';
	});
}

/** Verbs whose chooser may get an engine prompt (scry, search); resolution pauses after the step. */
export const PROMPTING_VERBS: ReadonlySet<Verb> = new Set<Verb>(['scry', 'lookAndReorder', 'search']);

function selectorSupported(sel: Selector): boolean {
	return ['self', 'binding', 'target', 'all', 'player', 'playerRef', 'none', 'eventObject'].includes(sel.k);
}

function stepSupported(step: EffectStep): boolean {
	if (!INTERPRETED_VERBS.has(step.verb)) return false;
	if (!selectorSupported(step.subject)) return false;
	if (step.optional && step.verb !== 'search') return false;
	if (step.verb === 'search') {
		const s = step.params?.search;
		if (!s) return false;
		// "may search" is a search whose chooser can always fail to find (CR 701.19b).
		if (step.optional && !s.statedQuality) return false;
	}
	if (step.verb === 'addMana' && !step.params?.mana && !step.params?.manaChoice) return false;
	if (step.verb === 'dig' && !step.params?.dig) return false;
	if ((step.verb === 'pump' || step.verb === 'grant' || step.verb === 'switchPT') && step.params?.duration !== 'endOfTurn') return false;
	if (step.verb === 'createToken' && !step.params?.token) return false;
	if (step.verb === 'delayedTrigger') return delayedSupported(step);
	if (step.verb === 'exile' && step.subject.k === 'all' && step.subject.filter.zone === 'graveyard') return true;
	if ((step.verb === 'destroy' || step.verb === 'exile' || step.verb === 'bounce') && step.subject.k === 'all') {
		return step.subject.filter.zone === 'battlefield';
	}
	return true;
}

function delayedSupported(step: EffectStep): boolean {
	const d = step.delayed;
	if (!d || d.effect.length !== 1) return false;
	if (d.trigger.event !== 'phaseBegin') return false;
	const phase = d.trigger.filter.phase;
	const e = d.effect[0];
	if (phase === 'end_step') {
		if (e.verb === 'exile' && e.subject.k === 'binding') return true;
		if (e.verb === 'lose' && e.subject.k === 'player' && e.subject.filter.relation === 'you') return true;
	}
	if (phase === 'upkeep' && e.verb === 'draw') {
		return selectorSupported(e.subject) && !e.optional;
	}
	return false;
}

/**
 * Whether a compiled ability can resolve on the interpreter, judged from the IR alone: the grammar
 * understood all of it, every step uses an interpreted verb, and each mode/ability has supported
 * target specs.
 */
export function staticallyInterpretable(
	parse: { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: unknown[] },
	allowOptionalPrefix = false
): boolean {
	if (parse.unparsed.length > 0) return false;
	if (parse.modal) {
		if (parse.steps.length > 0) return parse.steps.every(stepSupported);
		const m = parse.modal;
		if (m.modes.length === 0 || m.min < 0 || m.max < m.min) return false;
		return m.modes.every(
			(mode) =>
				mode.targets.length <= 1 &&
				staticallyInterpretable({ steps: mode.effect, targets: mode.targets, unparsed: [] })
		);
	}
	if (parse.steps.length === 0) return false;
	const hasFight = parse.steps.some((s) => s.verb === 'fight');
	if (parse.targets.length > (hasFight ? 2 : 1)) return false;
	if (allowOptionalPrefix) {
		const k = optionalPrefix(parse.steps);
		if (k < 0) return false;
		return withoutOptional(parse.steps, k).every(stepSupported);
	}
	return parse.steps.every(stepSupported);
}

/**
 * "You may ..." leading a triggered ability: the number of leading steps that are optional with the
 * controller as chooser (one "you may" clause), 0 if none is optional, or -1 if an optional step
 * appears later or with another chooser (not supported: the interpreter can't pause mid-ability).
 * The caller asks the controller once, on resolution, before any step runs.
 */
export function optionalPrefix(steps: EffectStep[]): number {
	let k = 0;
	while (k < steps.length && steps[k].optional && steps[k].optional!.chooser.k === 'you') k++;
	return steps.slice(k).some((s) => s.optional && s.verb !== 'search') ? -1 : k;
}

/** The steps with the first `k` steps' `optional` removed (they were accepted). */
export function withoutOptional(steps: EffectStep[], k: number): EffectStep[] {
	return steps.map((s, i) => {
		if (i >= k || !s.optional) return s;
		const { optional: _opt, ...rest } = s;
		return rest;
	});
}

