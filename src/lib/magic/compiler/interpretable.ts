/**
 * What the IR effect interpreter (runtime/effects.ts) can run, judged from the IR alone
 * (ENGINE_ARCHITECTURE_PLAN.md Phase 10, step F).
 *
 * This is the single source of truth for "is this ability automated?": the compiler marks an
 * ability `unsupported` exactly when these checks fail (compiler/card.ts), so the deck builder and
 * inspector labels (compiler/support.ts) and the runtime decision (interpreter or manual
 * resolution, engine.ts) can't disagree. Pure IR; no game state, no rules text.
 */
import type { CostDef, EffectStep, ModalDef, Selector, TargetSpec, Verb } from '../ir.ts';

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
	'copySpell',
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
	'surveil',
	'lookAndReorder',
	'investigate',
	'search',
	'delayedTrigger',
	'fight',
	'discard',
	'tap',
	'untap',
	'tapOrUntap' as Verb,
	'transform',
	'flip',
	'dig',
	'grantPlayFromExile',
	'goad',
	'explore',
	'connive',
	'regenerate',
	'cantRegenerate',
	'payCost',
	'animate',
	'gainControl',
	'revealAndDiscard',
	'saddle',
	'cumulativeUpkeep'
]);

export const SUPPORTED_OPTIONAL_COST_KINDS: ReadonlySet<CostDef['k']> = new Set<CostDef['k']>([
	'mana',
	'payLife',
	'sacrifice',
	'discard',
	'removeCounters',
	'exileFrom',
	'tapOthers',
	'tapSubsetSum'
]);

/**
 * Target specs a triggered ability can choose when it is put on the stack (the zones the engine's
 * candidate list enumerates: battlefield, graveyard, players).
 */
export function triggerTargetsSupported(specs: TargetSpec[]): boolean {
	return specs.every((sp) => {
		if (sp.kind === 'player') return true;
		const z = sp.filter.zone ?? 'battlefield';
		return z === 'battlefield' || z === 'graveyard' || z === 'stack';
	});
}

/** Verbs whose chooser may get an engine prompt (scry, surveil, search, explore, connive); resolution pauses after the step. */
export const PROMPTING_VERBS: ReadonlySet<Verb> = new Set<Verb>(['scry', 'surveil', 'lookAndReorder', 'search', 'explore', 'connive']);

function selectorSupported(sel: Selector): boolean {
	return ['self', 'binding', 'target', 'all', 'player', 'playerRef', 'libraryTop', 'none', 'eventObject'].includes(sel.k);
}

function stepSupported(step: EffectStep): boolean {
	if (!INTERPRETED_VERBS.has(step.verb)) return false;
	if (!selectorSupported(step.subject)) return false;
	if (step.verb === 'payCost' && (!step.optional?.cost || step.optional.cost.length === 0)) return false;
	if (step.verb === 'cumulativeUpkeep') {
		const cu = step.params?.cumulativeUpkeepCost;
		if (!cu || cu.length === 0 || !cu.every((c) => SUPPORTED_OPTIONAL_COST_KINDS.has(c.k))) {
			return false;
		}
	}
	if (step.optional?.cost) {
		if (
			step.optional.cost.length === 0 ||
			!step.optional.cost.every((c) => SUPPORTED_OPTIONAL_COST_KINDS.has(c.k))
		) {
			return false;
		}
	}
	if (step.verb === 'search') {
		const s = step.params?.search;
		if (!s) return false;
		// "may search" requires a stated quality (CR 701.19b) so the chooser can fail to find.
		if (step.optional && !s.statedQuality && !s.filter.named) return false;
	}
	if (step.verb === 'addMana' && !step.params?.mana && !step.params?.manaChoice) return false;
	if (step.verb === 'dig') {
		const d = step.params?.dig;
		if (!d || !d.keepTo || !d.rest) return false;
		if (!d.keepAllMatching && (typeof d.keep !== 'number' || d.keep < 0)) return false;
	}
	if (step.subject.k === 'libraryTop' && step.verb !== 'exile') return false;
	if (step.verb === 'grantPlayFromExile' && !step.params?.playFromExile) return false;
	if (step.verb === 'revealAndDiscard') {
		const cd = step.params?.coerciveDiscard;
		if (!cd || (cd.destination !== 'graveyard' && cd.destination !== 'exile')) return false;
	}
	if (step.verb === 'gainControl') {
		if (step.subject.k === 'none') return false;
		const d = step.params?.duration;
		if (d !== undefined && d !== 'endOfTurn' && d !== 'permanent' && d !== 'untilSourceLeaves') {
			return false;
		}
	}
	if (step.verb === 'animate') {
		if (step.subject.k === 'none') return false;
		const d = step.params?.duration;
		if (d !== undefined && d !== 'endOfTurn' && d !== 'permanent') return false;
	}
	if (step.verb === 'copySpell') {
		if (
			step.subject.k !== 'target' &&
			step.subject.k !== 'eventObject' &&
			step.subject.k !== 'self' &&
			step.subject.k !== 'binding'
		) {
			return false;
		}
	}
	if ((step.verb === 'pump' || step.verb === 'grant' || step.verb === 'switchPT') && step.params?.duration !== 'endOfTurn') return false;
	if (step.verb === 'grant' && !step.params?.keywords?.length && !step.params?.removeKeywords?.length) return false;
	if (step.verb === 'createToken' && !step.params?.token) return false;
	if (step.verb === 'delayedTrigger') return delayedSupported(step);
	if (step.verb === 'fight') return Boolean(step.params?.with && selectorSupported(step.params.with));
	if (step.verb === 'exile' && step.subject.k === 'all' && step.subject.filter.zone === 'graveyard') return true;
	if ((step.verb === 'destroy' || step.verb === 'exile' || step.verb === 'bounce') && step.subject.k === 'all') {
		return step.subject.filter.zone === 'battlefield';
	}
	return true;
}

const DELAYED_PHASES = new Set<string | undefined>(['end_step', 'upkeep', 'end_combat']);

function stepProducesDecision(step: EffectStep | undefined): boolean {
	if (!step) return false;
	if (step.optional) return true;
	if (step.verb === 'revealAndDiscard' && step.params?.coerciveDiscard) return true;
	return false;
}

function stepsSupported(steps: EffectStep[]): boolean {
	if (steps.length === 0) return false;
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		if (!stepSupported(s)) return false;
		if (
			s.ifPrecedingAccepted !== undefined &&
			(s.ifPrecedingAccepted < 0 || s.ifPrecedingAccepted >= i || !stepProducesDecision(steps[s.ifPrecedingAccepted]))
		) {
			return false;
		}
		if (
			s.ifPrecedingDeclined !== undefined &&
			(s.ifPrecedingDeclined < 0 || s.ifPrecedingDeclined >= i || !stepProducesDecision(steps[s.ifPrecedingDeclined]))
		) {
			return false;
		}
	}
	return true;
}

function delayedSupported(step: EffectStep): boolean {
	const d = step.delayed;
	if (!d || d.effect.length === 0) return false;
	if (d.trigger.event !== 'phaseBegin') return false;
	if (!DELAYED_PHASES.has(d.trigger.filter.phase)) return false;
	return stepsSupported(d.effect);
}

/**
 * Whether a compiled ability can resolve on the interpreter, judged from the IR alone: the grammar
 * understood all of it, every step uses an interpreted verb, and each mode/ability has supported
 * target specs.
 */
export function staticallyInterpretable(
	parse: { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: unknown[] },
	_allowOptionalPrefix = false
): boolean {
	if (parse.unparsed.length > 0) return false;
	if (parse.modal) {
		if (parse.steps.length > 0) return parse.steps.every(stepSupported);
		const m = parse.modal;
		if (m.modes.length === 0 || m.min < 0 || m.max < m.min) return false;
		return m.modes.every((mode) =>
			staticallyInterpretable(
				{ steps: mode.effect, targets: mode.targets, unparsed: [] },
				_allowOptionalPrefix
			)
		);
	}
	if (parse.steps.length === 0) return false;
	if (parse.targets.length > 1 && !parse.targets.every((t) => t.min === 1 && t.max === 1)) return false;
	return stepsSupported(parse.steps);
}

/**
 * Leading optional steps with the controller as chooser (`0` if none). Kept for loop-breaking
 * detection on triggered abilities alongside `steps.some(s => Boolean(s.optional))`.
 */
export function optionalPrefix(steps: EffectStep[]): number {
	let k = 0;
	while (k < steps.length && steps[k].optional && steps[k].optional!.chooser.k === 'you') k++;
	return k;
}

/** The steps with the first `k` steps' `optional` removed (they were accepted). */
export function withoutOptional(steps: EffectStep[], k: number): EffectStep[] {
	return steps.map((s, i) => {
		if (i >= k || !s.optional) return s;
		const { optional: _opt, ...rest } = s;
		return rest;
	});
}

