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
	'gainEnergy',
	'becomeMonarch',
	'saddle',
	'cumulativeUpkeep',
	// --- Track P4 ---
	'freezeUntap',
	'exert',
	// --- Track P5 ---
	'amass',
	'incubate',
	'populate',
	'manifest',
	'cloak',
	'manifestDread',
	'monstrosity',
	'bolster',
	'adapt',
	// --- Track P6 ---
	'removeCounters',
	'extraCombatPhase',
	'moveCounters',
	'reveal',
	// --- Track P7 ---
	'preventDamage',
	'exileInsteadOfDying',
	'combatRestriction',
	'becomeCopy',
	'discardHand',
	// --- Track P10 ---
	'discover',
	'clash',
	'detain',
	'suspect',
	'collectEvidence',
	'forage',
	'endure',
	'timeTravel',
	'blight',
	'fateseal',
	'flipCoin',
	'rollDie',
	'retainMana',
	// --- Track P13 ---
	'createEmblem',
	'createRoleToken',
	'doubleOrTriple',
	'exchange',
	'turnFace',
	'chooseDesignation',
	'grantGraveyardCast',
	'ventureIntoDungeon',
	'takeInitiative',
	'temptWithRing',
	'earthbend',
	'airbend',
	'learn',
	'villainousChoice',
	'vote',
	// --- End Track P13 ---
	// --- Track P16a ---
	'pileSplit',
	'castFree',
	'putPlayerCounters',
	'removeFromCombat',
	'harness',
	'convert',
	'empowerJace',
	'assimilate',
	'recruit',
	'heal'
	// --- End Track P16a ---
]);

export const SUPPORTED_OPTIONAL_COST_KINDS: ReadonlySet<CostDef['k']> = new Set<CostDef['k']>([
	'mana',
	'payLife',
	'payEnergy',
	'sacrifice',
	'discard',
	'removeCounters',
	'exileFrom',
	'tapOthers',
	'tapSubsetSum',
	'exertSelf'
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
	return [
		'self',
		'binding',
		'target',
		'all',
		'player',
		'playerRef',
		'libraryTop',
		'none',
		'eventObject',
		'attachedTo'
	].includes(sel.k);
}

function stepSupported(step: EffectStep): boolean {
	if (!INTERPRETED_VERBS.has(step.verb)) return false;
	if (!selectorSupported(step.subject)) return false;
	// --- Track P10 ---
	if (step.params?.reflexiveTrigger) {
		const rt = step.params.reflexiveTrigger;
		if (!triggerTargetsSupported(rt.targets)) return false;
		if (!staticallyInterpretable({ steps: rt.effect, targets: rt.targets, unparsed: [] })) {
			return false;
		}
	}
	if (step.verb === 'attach' && step.params?.attachObject && !selectorSupported(step.params.attachObject)) {
		return false;
	}
	if (step.verb === 'flipCoin') {
		if (step.params?.winFlipEffect && !stepsSupported(step.params.winFlipEffect)) return false;
		if (step.params?.loseFlipEffect && !stepsSupported(step.params.loseFlipEffect)) return false;
	}
	if (step.verb === 'rollDie') {
		if (!step.params?.dieSides || step.params.dieSides < 2) return false;
		if (
			step.params.dieRollTable &&
			(step.params.dieRollTable.length === 0 ||
				!step.params.dieRollTable.every((b) => stepsSupported(b.effect)))
		) {
			return false;
		}
	}
	if (step.verb === 'retainMana' && !step.params?.unemptiedColors?.length) {
		return false;
	}
	// --- End Track P10 ---
	if (step.verb === 'removeCounters' && !step.params?.counter) return false;
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
	if (
		step.verb === 'addMana' &&
		!step.params?.mana &&
		!step.params?.manaChoice &&
		!step.params?.manaBundles?.length &&
		!step.params?.manaWithChosenColor?.length &&
		!step.params?.manaOrChosenColor?.length &&
		!step.params?.manaCombinationColors
	) {
		return false;
	}
	if (step.verb === 'extraCombatPhase') return true;
	if (step.verb === 'moveCounters') {
		if (step.params?.moveCounterSpec) {
			return selectorSupported(step.params.moveCounterSpec.from) && step.subject.k !== 'none';
		}
		return true;
	}
	if (step.verb === 'putCounters' && step.params?.copyCountersFrom) {
		if (!selectorSupported(step.params.copyCountersFrom) || step.subject.k === 'none') return false;
	}
	if (step.verb === 'dig') {
		const d = step.params?.dig;
		if (!d) return false;
		if (d.partitions && d.partitions.length > 0) return true;
		if (!d.keepTo || (!d.rest && !d.shuffleRest)) return false;
		if (!d.untilFilter && !d.keepAllMatching && (typeof d.keep !== 'number' || d.keep < 0)) return false;
	}
	if (
		step.subject.k === 'libraryTop' &&
		step.verb !== 'exile' &&
		step.verb !== 'manifest' &&
		step.verb !== 'cloak' &&
		step.verb !== 'reveal'
	) {
		return false;
	}
	if (step.verb === 'reveal') return true;
	if (step.verb === 'amass' && !step.params?.amassSubtype) return false;
	if (step.verb === 'grantPlayFromExile' && !step.params?.playFromExile) return false;
	if (step.verb === 'revealAndDiscard') {
		const cd = step.params?.coerciveDiscard;
		if (!cd || (cd.destination !== 'graveyard' && cd.destination !== 'exile')) return false;
	}
	if (step.verb === 'gainControl') {
		if (step.subject.k === 'none') return false;
		const d = step.params?.duration;
		if (
			d !== undefined &&
			d !== 'endOfTurn' &&
			d !== 'untilEndOfCombat' &&
			d !== 'untilYourNextTurn' &&
			d !== 'untilEndOfYourNextTurn' &&
			d !== 'permanent' &&
			d !== 'untilSourceLeaves' &&
			d !== 'forAsLongAsYouControlSelf' &&
			d !== 'forAsLongAsSelfRemainsTapped'
		) {
			return false;
		}
	}
	if (step.verb === 'animate') {
		if (step.subject.k === 'none') return false;
		const d = step.params?.duration;
		if (
			d !== undefined &&
			d !== 'endOfTurn' &&
			d !== 'untilEndOfCombat' &&
			d !== 'untilYourNextTurn' &&
			d !== 'untilEndOfYourNextTurn' &&
			d !== 'permanent' &&
			d !== 'forAsLongAsYouControlSelf' &&
			d !== 'forAsLongAsSelfRemainsTapped'
		) {
			return false;
		}
	}
	// --- Track P7 ---
	if (step.verb === 'preventDamage') {
		const ps = step.params?.preventSpec;
		if (!ps) return false;
		if (ps.fromSource && !selectorSupported(ps.fromSource)) return false;
	}
	if (step.verb === 'exileInsteadOfDying' && step.subject.k === 'none') return false;
	if (step.verb === 'combatRestriction') {
		if (!step.params?.combatRestriction || step.subject.k === 'none') return false;
	}
	if (step.verb === 'becomeCopy') {
		if (!step.params?.copySource || !selectorSupported(step.params.copySource) || step.subject.k === 'none') {
			return false;
		}
		const d = step.params.duration;
		if (d !== undefined && d !== 'endOfTurn' && d !== 'permanent') return false;
	}
	if (step.verb === 'discardHand') {
		if (
			step.subject.k !== 'none' &&
			step.subject.k !== 'player' &&
			step.subject.k !== 'playerRef' &&
			step.subject.k !== 'target'
		) {
			return false;
		}
	}
	// --- End Track P7 ---
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
	if (step.verb === 'switchPT' && step.params?.duration !== 'endOfTurn') return false;
	if (step.verb === 'pump' || step.verb === 'grant') {
		const d = step.params?.duration;
		if (
			d !== 'endOfTurn' &&
			d !== 'untilEndOfCombat' &&
			d !== 'untilYourNextTurn' &&
			d !== 'untilEndOfYourNextTurn' &&
			d !== 'permanent' &&
			d !== 'forAsLongAsYouControlSelf' &&
			d !== 'forAsLongAsSelfRemainsTapped'
		) {
			return false;
		}
	}
	if (
		step.verb === 'grant' &&
		!step.params?.keywords?.length &&
		!step.params?.removeKeywords?.length &&
		!step.params?.grantedAbilityTexts?.length &&
		!step.params?.canAttackNoDefender &&
		!step.params?.chooseKeywordOptions?.length &&
		!step.params?.chooseProtectionColor &&
		!step.params?.mustAttackThisTurn &&
		!step.params?.mustBeBlockedThisTurn &&
		!step.params?.mustBlockThisTurn &&
		!step.params?.mustBlockSelfThisTurn &&
		!step.params?.cantBlockSelfThisTurn &&
		!step.params?.assignsNoCombatDamageThisTurn &&
		!step.params?.removeAllAbilities
	) {
		return false;
	}
	// --- Track P16a ---
	if (step.verb === 'pileSplit') {
		return Boolean(step.params?.pileSplit);
	}
	if (step.verb === 'castFree') {
		return step.subject.k !== 'none';
	}
	if (step.verb === 'putPlayerCounters') {
		return Boolean(step.params?.playerCounter);
	}
	if (
		step.verb === 'removeFromCombat' ||
		step.verb === 'harness' ||
		step.verb === 'convert' ||
		step.verb === 'assimilate' ||
		step.verb === 'heal'
	) {
		return step.subject.k !== 'none';
	}
	if (step.verb === 'empowerJace' || step.verb === 'recruit') {
		return true;
	}
	// --- End Track P16a ---
	// --- Track P13 ---
	if (step.verb === 'createEmblem') {
		return Boolean(step.params?.emblemAbilities && step.params.emblemAbilities.length > 0);
	}
	if (step.verb === 'createRoleToken') {
		return Boolean(step.params?.roleKind && step.subject.k !== 'none');
	}
	if (step.verb === 'doubleOrTriple') {
		const ds = step.params?.doubleSpec;
		if (!ds || (ds.factor !== 2 && ds.factor !== 3)) return false;
		if (ds.duration !== undefined) {
			const d = ds.duration;
			if (
				d !== 'endOfTurn' &&
				d !== 'untilYourNextTurn' &&
				d !== 'untilEndOfYourNextTurn' &&
				d !== 'permanent'
			) {
				return false;
			}
		}
		return step.subject.k !== 'none';
	}
	if (step.verb === 'exchange') {
		const ex = step.params?.exchangeSpec;
		if (!ex || step.subject.k === 'none') return false;
		if (ex.second && !selectorSupported(ex.second)) return false;
		return true;
	}
	if (step.verb === 'turnFace') {
		const fd = step.params?.faceDirection;
		return (fd === 'up' || fd === 'down') && step.subject.k !== 'none';
	}
	if (step.verb === 'chooseDesignation') {
		return Boolean(step.params?.chooseKind);
	}
	if (step.verb === 'grantGraveyardCast') {
		return Boolean(step.params?.graveyardCastSpec && step.subject.k !== 'none');
	}
	if (
		step.verb === 'ventureIntoDungeon' ||
		step.verb === 'takeInitiative' ||
		step.verb === 'temptWithRing' ||
		step.verb === 'learn'
	) {
		return true;
	}
	if (step.verb === 'earthbend' || step.verb === 'airbend') {
		return step.subject.k !== 'none';
	}
	if (step.verb === 'villainousChoice') {
		const opts = step.params?.villainousOptions;
		return Boolean(
			opts && opts.length === 2 && stepsSupported(opts[0]) && stepsSupported(opts[1])
		);
	}
	if (step.verb === 'vote') {
		const vs = step.params?.voteSpec;
		if (!vs || vs.options.length < 2) return false;
		if (vs.perOptionEffect && !vs.perOptionEffect.every((eff) => eff.length === 0 || stepsSupported(eff))) {
			return false;
		}
		if (vs.perWinningEffect && !vs.perWinningEffect.every((eff) => eff.length === 0 || stepsSupported(eff))) {
			return false;
		}
		return true;
	}
	// --- End Track P13 ---
	if (step.verb === 'createToken' && !step.params?.token) return false;
	if (step.verb === 'delayedTrigger') return delayedSupported(step);
	if (step.params?.damageSource && (step.verb !== 'damage' || !selectorSupported(step.params.damageSource))) {
		return false;
	}
	if (step.params?.alsoDamagePlayers && step.verb !== 'damage') return false;
	if (step.verb === 'fight') return Boolean(step.params?.with && selectorSupported(step.params.with));
	if (step.verb === 'exile' && step.subject.k === 'all' && step.subject.filter.zone === 'graveyard') return true;
	// --- Track P10 ---
	if (
		step.verb === 'exile' &&
		step.subject.k === 'all' &&
		step.subject.filter.zone === 'hand' &&
		(step.amount !== undefined || step.params?.choiceCount !== undefined)
	) {
		return true;
	}
	// --- End Track P10 ---
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
	// --- Track P10 ---
	if (
		step.verb === 'clash' ||
		step.verb === 'flipCoin' ||
		step.verb === 'collectEvidence' ||
		step.verb === 'forage' ||
		step.verb === 'blight' ||
		step.verb === 'discover' ||
		(step.verb === 'move' && step.params?.from === 'hand' && step.params?.to === 'battlefield' && step.params?.upTo)
	) {
		return true;
	}
	// --- End Track P10 ---
	// --- Track P16a ---
	if (
		step.verb === 'castFree' ||
		step.verb === 'sacrifice' ||
		step.verb === 'discard' ||
		step.verb === 'removeCounters' ||
		(step.verb === 'dig' && Boolean(step.params?.dig?.upTo)) ||
		(step.verb === 'moveCounters' && Boolean(step.params?.moveCounterSpec)) ||
		((step.verb === 'bounce' ||
			step.verb === 'exile' ||
			step.verb === 'move' ||
			step.verb === 'putCounters' ||
			step.verb === 'tap' ||
			step.verb === 'untap') &&
			Boolean(step.params?.choiceCount && step.params?.upTo))
	) {
		return true;
	}
	// --- End Track P16a ---
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
	// --- Track P16a: Backtracking multi-spec partitioner supports multiple min>=0 / max>=1 specs ---
	if (
		parse.targets.length > 1 &&
		!parse.targets.every((t) => t.min >= 0 && t.max >= t.min && t.max >= 1)
	) {
		return false;
	}
	// --- End Track P16a ---
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

