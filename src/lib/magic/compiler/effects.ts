/**
 * Effect grammar (ENGINE_ARCHITECTURE_PLAN.md sections 2.1 and 2.2, Phase 3).
 *
 * Parses the effect text of a spell, an activated ability or a triggered ability into an ORDERED
 * list of EffectSteps (verb x selector), with Amount expressions, `actor`, `optional`, bindings
 * ("it", "that creature", "its controller", "that many") and delayed effects bound to bindings.
 * Input is normalised text (self-references are `~`, reminder text stripped). Every sentence is
 * either consumed by a production or reported as an unparsed span; nothing is skipped silently.
 *
 * Bindings: a step whose result a later clause refers to gets `bindAs`. At runtime a binding holds
 * the objects the step acted on plus a last-known-information snapshot taken just before the step
 * ran (CR 608.2h), so "its controller" and "its power" after an exile read the LKI.
 *
 * Runs alongside the Phase 1 adapter; scripts/magic-effects-diff.ts compares the two. The runtime
 * (runtime/effects.ts) uses `compiledStackItemEffects` to get the steps of a resolving spell or
 * activated ability.
 */
import type {
	Amount,
	Condition,
	CostDef,
	Duration,
	EffectParams,
	EffectStep,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	Span,
	TargetSpec,
	TokenSpec,
	TriggerDef,
	Verb
} from '../ir.ts';
import { GRANTABLE_KEYWORDS } from '../keywords.ts';
import type { CounterType, LibrarySearchSpec, ManaColor, ScryfallCard, StackItem, ZoneType } from '../types.ts';
import { buildTokenSpec, parseLibrarySearchSpec, PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { parseAdditionalCostSentence, parseCost, parseObjectPhrase, singularSubtype } from './costs.ts';
import { parseActivatedIfConditionSentence, parseCondition } from './triggers.ts';
import {
	hashText,
	normalizeFace,
	replaceSelfReferences,
	splitSentences,
	stripReminderText,
	type NormalizedFace,
	type NormalizedLine
} from './normalize.ts';

export interface EffectParse {
	steps: EffectStep[];
	targets: TargetSpec[];
	modal?: ModalDef;
	/** Sentences no production consumed, as offsets into the caller's text. */
	unparsed: Span[];
}

export type EffectContext = 'spell' | 'activated' | 'triggered';

// ---- Words ----------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
	a: 1,
	an: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20
};

const n = (value: number): Amount => ({ k: 'const', n: value });

function count(word: string): Amount | null {
	const low = word.toLowerCase();
	if (low === 'x') return { k: 'x' };
	if (/^\d+$/.test(low)) return n(parseInt(low, 10));
	const v = NUMBER_WORDS[low];
	return v === undefined ? null : n(v);
}

const COUNTER_WORDS: Record<string, CounterType> = {
	'+1/+1': '+1/+1',
	'-1/-1': '-1/-1',
	'−1/−1': '-1/-1',
	charge: 'charge',
	shield: 'shield',
	stun: 'stun',
	lore: 'lore',
	time: 'time',
	loyalty: 'loyalty',
	level: 'level',
	fade: 'fade'
};

/** Sentences that carry no effect of their own. */
const NEUTRAL_SENTENCES: RegExp[] = [
	/^then shuffle\.?$/i,
	/^you may play the exiled cards? this turn\.?$/i
];

/** Activation and cast restrictions; enforced by the cast/activation legality checks, not effects. */
const RESTRICTION_SENTENCES: RegExp[] = [
	/^activate only as a sorcery\.?$/i,
	/^activate only during your turn\.?$/i,
	/^activate only once each turn\.?$/i,
	/^activate only during your upkeep\.?$/i,
	/^activate only during combat\.?$/i,
	/^activate only if ~ is in your (?:hand|graveyard)(?: and only (?:as a sorcery|once each turn|during your turn|during your upkeep|during combat))?\.?$/i,
	/^activate only (?:as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if ~ is in your (?:hand|graveyard)\.?$/i,
	/^equip only as a sorcery\.?$/i,
	/^cast (?:~|this spell) only during combat\.?$/i,
	/^cast (?:~|this spell) only during your turn\.?$/i,
	/^cast (?:~|this spell) only before attackers are declared\.?$/i,
	/^~ can't be countered\.?$/i,
	/^this spell can't be countered\.?$/i,
	// Cost reductions of the spell itself are statics, applied when the cost is determined.
	/^~ costs .+ less to cast\b.*$/i,
	/^this spell costs .+ less to cast\b.*$/i,
	/^if you control (?:a|your) commander, you may cast (?:~|this spell) without paying its mana cost\.?$/i,
	/^if ~ would be put into a graveyard from anywhere, (?:exile it|shuffle it into its owner's library|return it to its owner's hand|put it into its owner's hand) instead\.?$/i
];

// ---- Parse context --------------------------------------------------------------------------

interface ObjectRes {
	selector: Selector;
	/** Ref to the same object(s), for "it"/"its" in later clauses. */
	ref?: Ref;
	/** The step that acts on this object should bind its result under this name. */
	plural?: boolean;
	topmostOnly?: boolean;
	fromZone?: 'graveyard' | 'exile';
}

interface PendingDigState {
	stepIndex: number;
	hasKeep: boolean;
	hasRest: boolean;
	draft: NonNullable<EffectParams['dig']>;
}

interface PendingCoerciveState {
	stepIndex: number;
	phase: 'awaitChoose' | 'awaitAction';
	optionalChoice?: boolean;
	filter?: ObjectFilter;
	spans: Span[];
}

class Parser {
	readonly steps: EffectStep[] = [];
	readonly targets: TargetSpec[] = [];
	readonly unparsed: Span[] = [];
	readonly context: EffectContext;
	readonly trigger?: TriggerDef;
	/** What "it", "that creature", "its controller" refer to. */
	lastObject?: { ref: Ref; stepIndex: number };
	/** Implicit subject of a continued predicate ("Target player draws two cards and loses 2 life"). */
	lastPlayer?: Selector;
	/** Most recent optional step index for "If you do / If that player does / If they do". */
	lastOptionalStep?: number;
	/** "where X is ..." defined in an earlier sentence of the same ability (Thassa's Oracle). */
	definedX?: Amount;
	/** Multi-clause / multi-sentence dig builder; committed to step.params.dig only once both keep and rest are parsed. */
	pendingDig?: PendingDigState;
	/** Multi-sentence coercive hand reveal + choose + discard/exile builder (CR 701.9, 701.20). */
	pendingCoercive?: PendingCoerciveState;

	constructor(context: EffectContext, trigger?: TriggerDef) {
		this.context = context;
		this.trigger = trigger;
	}

	/** Records that `stepIndex` acted on objects later clauses may call "it". */
	setLastObject(stepIndex: number): void {
		this.lastObject = { ref: { k: 'binding', name: `b${stepIndex}` }, stepIndex };
	}

	/** Records a standalone target sentence ("You may target two cards in a graveyard.") for later "them"/"it". */
	setLastTarget(ref: Ref): void {
		this.lastObject = { ref, stepIndex: -1 };
	}

	/** "it" / "that creature": the last object acted on, or the trigger's object. */
	itRef(): Ref | null {
		if (this.lastObject) {
			if (this.lastObject.stepIndex >= 0) {
				const step = this.steps[this.lastObject.stepIndex];
				if (step) step.bindAs = (this.lastObject.ref as { name: string }).name;
			}
			return this.lastObject.ref;
		}
		if (this.context === 'triggered') return { k: 'eventObject' };
		return null;
	}

	/** "that many": the number of objects the last step acted on, or the trigger's amount. */
	thatMany(): Amount | null {
		if (this.lastObject) {
			const step = this.steps[this.lastObject.stepIndex];
			const name = (this.lastObject.ref as { name: string }).name;
			if (step) step.bindAs = name;
			return { k: 'resultCount', of: name };
		}
		if (this.context === 'triggered') return { k: 'eventAmount' };
		return null;
	}

	mark(): {
		steps: number;
		targets: number;
		lastPlayer?: Selector;
		lastObject?: { ref: Ref; stepIndex: number };
		lastOptionalStep?: number;
		definedX?: Amount;
		pendingDig?: PendingDigState;
		pendingCoercive?: PendingCoerciveState;
		binds: Array<string | undefined>;
	} {
		return {
			steps: this.steps.length,
			targets: this.targets.length,
			lastPlayer: this.lastPlayer,
			lastObject: this.lastObject,
			lastOptionalStep: this.lastOptionalStep,
			definedX: this.definedX,
			pendingDig: this.pendingDig
				? { ...this.pendingDig, draft: { ...this.pendingDig.draft } }
				: undefined,
			pendingCoercive: this.pendingCoercive
				? { ...this.pendingCoercive, spans: [...this.pendingCoercive.spans] }
				: undefined,
			binds: this.steps.map((s) => s.bindAs)
		};
	}

	rollback(m: ReturnType<Parser['mark']>): void {
		this.steps.length = m.steps;
		this.targets.length = m.targets;
		this.lastPlayer = m.lastPlayer;
		this.lastObject = m.lastObject;
		this.lastOptionalStep = m.lastOptionalStep;
		this.definedX = m.definedX;
		this.pendingDig = m.pendingDig;
		this.pendingCoercive = m.pendingCoercive;
		this.steps.forEach((s, i) => {
			if (m.binds[i] === undefined) delete s.bindAs;
			else s.bindAs = m.binds[i];
		});
	}

	flushIncompleteCoercive(): void {
		if (!this.pendingCoercive) return;
		for (const sp of this.pendingCoercive.spans) {
			this.unparsed.push(sp);
		}
		this.pendingCoercive = undefined;
	}

	addTarget(spec: TargetSpec): number {
		this.targets.push(spec);
		return this.targets.length - 1;
	}

	push(step: EffectStep, actsOnObjects: boolean): number {
		this.steps.push(step);
		const idx = this.steps.length - 1;
		// A step acting on an existing binding keeps that binding as "it" (Corpse Dance: the
		// creature that gained haste is still the returned creature).
		if (actsOnObjects && step.subject.k !== 'binding') this.setLastObject(idx);
		if (step.optional) this.lastOptionalStep = idx;
		return idx;
	}

	/**
	 * Resolves a player phrase against steps starting at `startStepIdx` before those steps have run
	 * (for trailing "unless its controller pays ..." where bindings aren't populated yet).
	 */
	resolvePlayerAgainstStep(startStepIdx: number, fn: () => Selector | null): Selector | null {
		const savedLastObj = this.lastObject;
		const savedBindAs =
			savedLastObj && savedLastObj.stepIndex >= startStepIdx
				? this.steps[savedLastObj.stepIndex]?.bindAs
				: undefined;
		if (savedLastObj && savedLastObj.stepIndex >= startStepIdx) {
			const subj = this.steps[savedLastObj.stepIndex]?.subject;
			let directRef: Ref | null = null;
			if (subj?.k === 'target') directRef = { k: 'target', index: subj.index };
			else if (subj?.k === 'self') directRef = { k: 'self' };
			else if (subj?.k === 'eventObject') directRef = { k: 'eventObject' };
			else if (subj?.k === 'attachedTo') directRef = { k: 'attachedTo' };
			else if (subj?.k === 'binding') directRef = { k: 'binding', name: subj.name };
			if (!directRef) return null;
			this.lastObject = { ref: directRef, stepIndex: -1 };
		}
		const res = fn();
		this.lastObject = savedLastObj;
		if (savedLastObj && savedLastObj.stepIndex >= startStepIdx && this.steps[savedLastObj.stepIndex]) {
			if (savedBindAs === undefined) delete this.steps[savedLastObj.stepIndex].bindAs;
			else this.steps[savedLastObj.stepIndex].bindAs = savedBindAs;
		}
		return res;
	}

	/** Shifts `lastObject` step index/binding name after inserting a preceding step at `insertedIdx`. */
	shiftLastObjectFrom(insertedIdx: number): void {
		if (!this.lastObject || this.lastObject.stepIndex < insertedIdx) return;
		const oldIdx = this.lastObject.stepIndex;
		const newIdx = oldIdx + 1;
		const oldName = `b${oldIdx}`;
		const newName = `b${newIdx}`;
		if (this.steps[newIdx]?.bindAs === oldName) this.steps[newIdx].bindAs = newName;
		this.lastObject = { ref: { k: 'binding', name: newName }, stepIndex: newIdx };
	}
}

function refSelector(ref: Ref): Selector {
	switch (ref.k) {
		case 'self':
		case 'affected':
			return { k: 'self' };
		case 'target':
			return { k: 'target', index: ref.index };
		case 'binding':
			return { k: 'binding', name: ref.name };
		case 'eventObject':
			return { k: 'eventObject' };
		case 'attachedTo':
			return { k: 'attachedTo' };
	}
}

// ---- Object phrases -------------------------------------------------------------------------

const IT_WORDS = /^(?:it|them|that creature|that permanent|that land|that card|that spell|that ability|that token|those tokens|the token|the creature|the land|the card|the spell|the ability|those cards|those creatures|those permanents|the amassed army|the army you amassed|the chosen creature|the manifested creature|the cloaked creature)$/i;

/** Controller qualifiers at the end of an object phrase. */
function splitController(phrase: string): { phrase: string; controller?: ObjectFilter['controller'] } {
	const m = phrase.match(/^(.+?) (you control|you don't control|an opponent controls|your opponents control|opponents control)$/);
	if (!m) return { phrase };
	return { phrase: m[1], controller: m[2] === 'you control' ? 'you' : 'opponent' };
}

/** "creature", "nonland permanent", "creature or enchantment", "creature card", "instant or sorcery spell". */
function objectFilter(phrase: string): ObjectFilter | null {
	const p = phrase.trim();
	if (/^(?:permanents?|cards?)$/i.test(p)) return {};
	if (/^permanent cards?$/i.test(p)) return { notTypes: ['Instant', 'Sorcery'] };
	return parseObjectPhrase(p);
}

/**
 * The phrase after "target": "creature", "nonland permanent you don't control", "creature card from a
 * graveyard", "noncreature spell", "activated or triggered ability", "player", "opponent".
 * Returns a TargetSpec without counts.
 */
function targetPhrase(text: string): Omit<TargetSpec, 'min' | 'max'> | null {
	let phrase = text.trim();
	if (/^(?:player|players)$/.test(phrase)) return { kind: 'player', filter: {}, player: { relation: 'any' } };
	if (/^(?:opponent|opponents)$/.test(phrase)) return { kind: 'player', filter: {}, player: { relation: 'opponent' } };

	let zone: ObjectFilter['zone'] = 'battlefield';
	let owner: ObjectFilter['owner'];
	let sameOwner: boolean | undefined;
	const gy = phrase.match(/^(.+?) (?:from|in) (?:(a|a single|the same|your|an opponent's|any number of|opponents') )?(graveyards?)$/);
	if (gy) {
		phrase = gy[1];
		zone = 'graveyard';
		const qual = gy[2];
		const plural = gy[3] === 'graveyards';
		owner = qual === 'your' ? 'you' : qual === "an opponent's" || qual === "opponents'" ? 'opponent' : undefined;
		if (!plural) sameOwner = true;
	}
	const ctl = splitController(phrase);
	phrase = ctl.phrase;
	if (zone === 'battlefield') {
		const withCtl = (base: ObjectFilter): ObjectFilter =>
			ctl.controller ? { ...base, controller: ctl.controller } : base;
		if (/^(?:activated or triggered abilit(?:y|ies)|abilit(?:y|ies))$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'ability' }) };
		}
		if (/^activated abilit(?:y|ies)$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'activatedAbility' }) };
		}
		if (/^triggered abilit(?:y|ies)$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'triggeredAbility' }) };
		}
		if (
			/^(?:spells? or abilit(?:y|ies)|spells?, activated abilit(?:y|ies), or triggered abilit(?:y|ies))$/.test(
				phrase
			)
		) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'spellOrAbility' }) };
		}
		const spell = phrase.match(/^(?:(.+) )?spells?$/);
		if (spell) {
			const filter = spell[1] ? objectFilter(`${spell[1]} card`) : {};
			if (!filter) return null;
			return { kind: 'object', filter: withCtl({ ...filter, zone: 'stack' }) };
		}
	}
	if (/^creature or player$/.test(phrase) && !ctl.controller) {
		return { kind: 'objectOrPlayer', filter: { zone: 'battlefield', types: ['Creature'] }, player: { relation: 'any' } };
	}
	if (/^(?:player or planeswalker|planeswalker or player)$/.test(phrase) && !ctl.controller) {
		return {
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Planeswalker'] },
			player: { relation: 'any' }
		};
	}
	if (/^(?:opponent or planeswalker|planeswalker or opponent)$/.test(phrase)) {
		const pwFilter: ObjectFilter = { zone: 'battlefield', types: ['Planeswalker'] };
		if (ctl.controller) pwFilter.controller = ctl.controller;
		return {
			kind: 'objectOrPlayer',
			filter: pwFilter,
			player: { relation: 'opponent' }
		};
	}
	const filter = objectFilter(phrase);
	if (!filter) return null;
	const resolvedZone = filter.zone ?? zone;
	if (resolvedZone === 'graveyard' && !/\bcards?$/.test(phrase)) return null;
	if (resolvedZone === 'battlefield' && /\bcards?$/.test(phrase)) return null;
	const out: ObjectFilter = { ...filter, zone: resolvedZone };
	if (ctl.controller) out.controller = ctl.controller;
	if (owner) out.owner = owner;
	return { kind: 'object', filter: out, ...(sameOwner ? { sameOwner: true } : {}) };
}

/**
 * An object noun phrase: "target creature", "up to two target creatures", "all creatures",
 * "each creature you control", "creatures you control", "~", "it", "the top creature card of your
 * graveyard".
 */
function objectPhrase(p: Parser, text: string): ObjectRes | null {
	const t = text.trim();
	if (t === '~') return { selector: { k: 'self' }, ref: { k: 'self' } };
	if (t === '~ from your graveyard' || t === "~ from its owner's graveyard") {
		return { selector: { k: 'self' }, ref: { k: 'self' }, fromZone: 'graveyard' };
	}
	if (/^(?:equipped creature|enchanted (?:creature|permanent|land|artifact|enchantment|planeswalker))$/.test(t)) {
		return { selector: { k: 'attachedTo' }, ref: { k: 'attachedTo' } };
	}
	if (IT_WORDS.test(t)) {
		if (!p.lastObject && p.context === 'triggered' && p.trigger?.filter.targetsSelf) {
			const heroRef: Ref = /^(?:that|the) spell$/i.test(t) ? { k: 'eventObject' } : { k: 'self' };
			return { selector: refSelector(heroRef), ref: heroRef };
		}
		const ref = p.itRef();
		return ref ? { selector: refSelector(ref), ref } : null;
	}
	if (t === 'any target') {
		const index = p.addTarget({
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
			player: { relation: 'any' },
			min: 1,
			max: 1
		});
		return { selector: { k: 'target', index }, ref: { k: 'target', index } };
	}
	const tgt = t.match(/^(?:(up to) )?(?:(\S+) )?target (?:(one|two|three|four|five|six|\d+) )?(.+)$/);
	if (tgt) {
		const countWord = tgt[2] ?? tgt[3];
		const c = countWord ? count(countWord) : n(1);
		if (!c || c.k !== 'const') return null;
		const spec = targetPhrase(tgt[4]);
		if (!spec) return null;
		const { sameOwner, ...restSpec } = spec;
		const index = p.addTarget({
			...restSpec,
			min: tgt[1] ? 0 : c.n,
			max: c.n,
			...(sameOwner && c.n > 1 ? { sameOwner: true } : {})
		});
		return { selector: { k: 'target', index }, ref: { k: 'target', index }, plural: c.n > 1 };
	}
	const top = t.match(/^the top (.+) card of your graveyard$/);
	if (top) {
		const filter = objectFilter(`${top[1]} card`);
		if (!filter) return null;
		return {
			selector: { k: 'all', filter: { ...filter, zone: 'graveyard', owner: 'you' } },
			topmostOnly: true,
			fromZone: 'graveyard'
		};
	}
	if (/^all (?:cards from all )?graveyards$/.test(t) || t === 'all cards from all graveyards') {
		return { selector: { k: 'all', filter: { zone: 'graveyard' } }, plural: true };
	}
	const all = t.match(/^(?:all|each) (.+)$/);
	const bare =
		!all &&
		/\b(?:you control|your opponents control|you don't control|target player controls|target opponent controls|that player controls)$/.test(
			t
		) &&
		!/^(?:a|an|another|target)\b/.test(t);
	if (all || bare) {
		const inner = all ? all[1] : t;
		const parseUnionObjectFilter = (raw: string): ObjectFilter | null =>
			objectFilter(raw) ??
			(/\band\b/.test(raw) ? objectFilter(raw.replace(/,?\s+and\s+/gi, ' or ')) : null);
		const refCtl = inner.match(/^(.+?) (target player|target opponent|that player) controls$/);
		if (refCtl) {
			const filter = parseUnionObjectFilter(refCtl[1]);
			const playerSel = playerPhrase(p, refCtl[2]);
			const ref = playerSel ? singlePlayer(playerSel) : null;
			if (!filter || !ref) return null;
			const out: ObjectFilter = { zone: 'battlefield', ...filter, controllerRef: ref };
			if (/^other\b/.test(refCtl[1])) out.other = true;
			return { selector: { k: 'all', filter: out }, plural: true };
		}
		const ctl = splitController(inner);
		const filter = parseUnionObjectFilter(ctl.phrase);
		if (!filter) return null;
		const out: ObjectFilter = { zone: 'battlefield', ...filter };
		if (ctl.controller) out.controller = ctl.controller;
		if (/^other\b/.test(ctl.phrase)) out.other = true;
		return { selector: { k: 'all', filter: out }, plural: true };
	}
	return null;
}

// ---- Player phrases -------------------------------------------------------------------------

/** A player subject: "you", "target player", "each opponent", "its controller", "that player". */
function playerPhrase(p: Parser, text: string): Selector | null {
	const t = text.trim().toLowerCase();
	if (t === 'you') return { k: 'player', filter: { relation: 'you' } };
	if (t === 'each opponent') return { k: 'player', filter: { relation: 'each_opponent' } };
	if (t === 'each player') return { k: 'player', filter: { relation: 'each_player' } };
	if (t === 'target player' || t === 'target opponent') {
		const index = p.addTarget({
			kind: 'player',
			filter: {},
			player: { relation: t === 'target player' ? 'any' : 'opponent' },
			min: 1,
			max: 1
		});
		return { k: 'playerRef', ref: { k: 'target', index } };
	}
	const of = t.match(
		/^(?:its|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the exiled permanent's|their) (controller|owner)$/
	);
	if (of) {
		const ref = p.itRef();
		if (!ref) return null;
		return { k: 'playerRef', ref: of[1] === 'controller' ? { k: 'controllerOf', of: ref } : { k: 'ownerOf', of: ref } };
	}
	const ownerOfTarget = t.match(/^(?:the )?owner of target (.+)$/);
	if (ownerOfTarget) {
		const filter = objectFilter(ownerOfTarget[1]);
		if (!filter) return null;
		const index = p.addTarget({ kind: 'object', filter: { ...filter, zone: 'battlefield' }, min: 1, max: 1 });
		p.setLastTarget({ k: 'target', index });
		return { k: 'playerRef', ref: { k: 'ownerOf', of: { k: 'target', index } } };
	}
	if (t === 'the player whose turn it is') return { k: 'playerRef', ref: { k: 'activePlayer' } };
	if ((t === 'that player' || t === 'the player' || t === 'that opponent') && p.context === 'triggered') {
		// In a triggered ability "that player" is the player the event was about ("Whenever an
		// opponent casts a spell, that player ..."), unless an earlier clause chose a target player.
		const last = p.lastPlayer;
		if (last && last.k === 'playerRef' && last.ref.k === 'target') return last;
		return { k: 'playerRef', ref: { k: 'eventPlayer' } };
	}
	if ((t === 'that player' || t === 'the player' || t === 'that opponent' || t === 'they') && p.lastPlayer) return p.lastPlayer;
	return null;
}

/** The PlayerRef of a single-player selector (for `actor`), or null for "each opponent" etc. */
function singlePlayer(sel: Selector): PlayerRef | null {
	if (sel.k === 'playerRef') return sel.ref;
	if (sel.k === 'player' && sel.filter.relation === 'you') return { k: 'you' };
	return null;
}

// ---- Amounts --------------------------------------------------------------------------------

/** "equal to its power", "equal to that card's mana value", "equal to the number of Elves you control". */
function equalTo(p: Parser, text: string): Amount | null {
	const t = text.trim();
	const stat = t.match(
		/^(?:(its)|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the amassed army's) (power|toughness|mana value)$/i
	);
	if (stat) {
		const it = p.itRef();
		const ref = it ?? (stat[1] ? { k: 'self' as const } : null);
		if (!ref) return null;
		const lowStat = stat[2].toLowerCase();
		const which = lowStat === 'mana value' ? 'manaValue' : (lowStat as 'power' | 'toughness');
		return it ? { k: 'stat', of: ref, stat: which, lki: true } : { k: 'stat', of: ref, stat: which };
	}
	// "the entering creature's power" (CR 603.6a: the object that entered, as it is now).
	const entering = t.match(/^the entering (?:creature|permanent)'s (power|toughness)$/);
	if (entering && p.context === 'triggered') return { k: 'stat', of: { k: 'eventObject' }, stat: entering[1] as 'power' | 'toughness' };
	if (t === "~'s power") return { k: 'stat', of: { k: 'self' }, stat: 'power' };
	if (t === "~'s toughness") return { k: 'stat', of: { k: 'self' }, stat: 'toughness' };
	if (t === "~'s mana value") return { k: 'stat', of: { k: 'self' }, stat: 'manaValue' };
	if (/^the amount of \{E\} you have$/i.test(t)) return { k: 'energyCount', player: { k: 'you' } };
	const num = t.match(/^the number of (.+)$/);
	if (num) return numberOf(num[1]);
	return null;
}

/** "creatures you control", "Elves you control", "cards in your hand". */
function numberOf(text: string): Amount | null {
	const hand = text.match(/^cards in (your|target opponent's) hand$/);
	if (hand && hand[1] === 'your') return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	if (/^(?:energy counters|\{E\}) you have$/i.test(text.trim())) {
		return { k: 'energyCount', player: { k: 'you' } };
	}
	if (/^times? you've cast (?:your|a) commander from the command zone this game$/i.test(text.trim())) {
		return { k: 'commanderCastCount' };
	}
	const ctl = splitController(text.trim());
	const filter = objectFilter(ctl.phrase);
	if (!filter) return null;
	const of: ObjectFilter = { zone: 'battlefield', ...filter };
	if (ctl.controller) of.controller = ctl.controller;
	return { k: 'count', of };
}

/** A count before a noun: "two", "X", "that many". */
function amountWord(p: Parser, word: string): Amount | null {
	if (word === 'that many' || word === 'that much') return p.thatMany();
	return count(word);
}

/** Splits a trailing ", where X is ..." clause off a sentence. */
function whereX(
	p: Parser,
	text: string
): { text: string; x?: Amount; deferredStat?: string; deferredExileCount?: boolean; bad?: boolean } {
	const m = text.match(/^(.+?),? where X is (.+)$/);
	if (!m) return { text };
	const rhs = m[2].trim();
	if (
		/^the number of (?:cards|creatures|permanents|artifacts|tokens|spells) exiled this way$/i.test(
			rhs
		)
	) {
		const prev = p.lastObject ? p.steps[p.lastObject.stepIndex] : undefined;
		if (prev?.verb === 'exile') {
			const x = p.thatMany();
			if (x) return { text: m[1], x };
		}
		return { text: m[1], deferredExileCount: true };
	}
	const num = rhs.match(/^the number of (.+)$/);
	if (num) {
		const x = numberOf(num[1]);
		return x ? { text: m[1], x } : { text, bad: true };
	}
	const dev = rhs.match(/^your devotion to (white|blue|black|red|green)$/);
	if (dev) {
		const color = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[dev[1] as 'blue'];
		return { text: m[1], x: { k: 'devotion', colors: [color] } };
	}
	if (/^your life total$/i.test(rhs)) {
		return { text: m[1], x: { k: 'life', of: { k: 'you' } } };
	}
	const eq = equalTo(p, rhs);
	if (eq) return { text: m[1], x: eq };
	if (
		/^(?:its|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's) (?:power|toughness|mana value)$/i.test(
			rhs
		)
	) {
		return { text: m[1], deferredStat: rhs };
	}
	return { text, bad: true };
}

function substituteX(a: Amount, x: Amount | undefined): Amount {
	if (!x) return a;
	if (a.k === 'x') return x;
	if (a.k === 'negate') return { k: 'negate', of: substituteX(a.of, x) };
	return a;
}

// ---- Tokens ---------------------------------------------------------------------------------

/** Converts a predefined token entry into a compiler/runtime TokenSpec. */
export function predefinedTokenToSpec(
	def: (typeof PREDEFINED_TOKEN_DEFS)[keyof typeof PREDEFINED_TOKEN_DEFS],
	tapped = false
): TokenSpec {
	return {
		name: def.name,
		power: def.power,
		toughness: def.toughness,
		colors: [...def.colors],
		typeLine: def.typeLine,
		keywords: [...def.keywords],
		...(tapped ? { tapped: true } : {})
	};
}

/** "a 3/3 green Beast creature token", "two 1/1 white Soldier creature tokens with lifelink", "a Treasure token". */
function tokenPhrase(p: Parser, text: string): { amount: Amount; token: TokenSpec } | null {
	const t = text.trim();
	const pre = t.match(/^(that many|\S+) (tapped )?([a-z]+) tokens?( tapped)?$/i);
	if (pre && !(pre[2] && pre[4])) {
		const def = PREDEFINED_TOKEN_DEFS[pre[3].toLowerCase() as keyof typeof PREDEFINED_TOKEN_DEFS];
		if (def) {
			const amount = amountWord(p, pre[1]);
			if (!amount) return null;
			return { amount, token: predefinedTokenToSpec(def, Boolean(pre[2] || pre[4])) };
		}
	}
	const m = t.match(
		/^(that many|\S+) (tapped )?(\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) (?:artifact )?creature tokens?(?: with ([a-z, ]+?))?( tapped)?$/
	);
	if (!m || (m[2] && m[8])) return null;
	const amount = amountWord(p, m[1]);
	if (!amount) return null;
	const kw = m[7] ?? '';
	const parsedKws = kw
		? kw
				.split(/,? and |, /)
				.map((k) => k.trim().toLowerCase())
				.filter(Boolean)
		: [];
	if (parsedKws.some((k) => !GRANTABLE_KEYWORDS.includes(k) && k !== 'changeling')) {
		return null;
	}
	const spec = buildTokenSpec(parseInt(m[3], 10), parseInt(m[4], 10), `${m[5]}${m[6]}`.trim(), kw);
	const tokenKeywords = [...spec.keywords];
	for (const k of parsedKws) {
		const cap = k.charAt(0).toUpperCase() + k.slice(1);
		if (!tokenKeywords.some((existing) => existing.toLowerCase() === k)) {
			tokenKeywords.push(cap);
		}
	}
	return {
		amount,
		token: {
			...spec,
			colors: [...spec.colors],
			keywords: tokenKeywords,
			...(m[2] || m[8] ? { tapped: true } : {})
		}
	};
}

// ---- Searches -------------------------------------------------------------------------------

function searchFromLegacy(spec: LibrarySearchSpec): NonNullable<EffectStep['params']>['search'] {
	const filter: ObjectFilter = {};
	if (spec.allowedTypes.length) filter.types = [...spec.allowedTypes];
	if (spec.allowedSubtypes.length) filter.subtypes = [...spec.allowedSubtypes];
	const notTypes = spec.disallowedTypes.filter((t) => t !== 'Basic');
	if (notTypes.length) filter.notTypes = notTypes;
	if (spec.disallowedTypes.includes('Basic')) filter.notSupertypes = ['Basic'];
	const supertypes = [spec.requireBasic && 'Basic', spec.requireLegendary && 'Legendary'].filter(Boolean) as string[];
	if (supertypes.length) filter.supertypes = supertypes;
	if (spec.allowedColors?.length) filter.colors = [...spec.allowedColors];
	if (spec.maxCmc !== undefined) filter.manaValue = { op: '<=', value: n(spec.maxCmc) };
	if (spec.exactCmc !== undefined) filter.manaValue = { op: '=', value: n(spec.exactCmc) };
	if (spec.named) filter.named = spec.named;
	return {
		filter,
		count: spec.count,
		upTo: spec.upTo,
		statedQuality: spec.statedQuality,
		destinations: spec.destinations.map((d) => ({ ...d })),
		description: spec.rawCriteriaText
	};
}

/** The legacy-shaped spec the engine's search prompt takes, rebuilt from IR (runtime helper). */
export function legacySearchSpec(search: NonNullable<NonNullable<EffectStep['params']>['search']>): LibrarySearchSpec {
	const f = search.filter;
	const spec: LibrarySearchSpec = {
		statedQuality: search.statedQuality,
		upTo: search.upTo,
		count: search.count,
		allowedTypes: [...(f.types ?? [])],
		allowedSubtypes: [...(f.subtypes ?? [])],
		disallowedTypes: [...(f.notTypes ?? []), ...(f.notSupertypes?.includes('Basic') ? ['Basic'] : [])],
		destinations: search.destinations.map((d) => ({ ...d })),
		rawCriteriaText: search.description ?? 'a card'
	};
	if (f.supertypes?.includes('Basic')) spec.requireBasic = true;
	if (f.supertypes?.includes('Legendary')) spec.requireLegendary = true;
	if (search.reveal) spec.reveal = true;
	if (f.colors?.length) spec.allowedColors = [...f.colors];
	if (f.named) spec.named = f.named;
	if (f.manaValue?.value.k === 'const') {
		if (f.manaValue.op === '<=') spec.maxCmc = f.manaValue.value.n;
		if (f.manaValue.op === '=') spec.exactCmc = f.manaValue.value.n;
	}
	return spec;
}

/**
 * "search your library for X, put it onto the battlefield tapped, then shuffle" (the whole rest of
 * the sentence). The structured search-spec parser (oracle.ts) does the clause; this production only
 * accepts sentences whose every part it understands.
 */
function searchClause(rest: string): NonNullable<EffectStep['params']>['search'] | null {
	const t = rest.replace(/\.$/, '');
	// Every part after the criteria must be a known search sub-clause.
	const m = t.match(/^search (?:your|their) library for (.+?)((?:,\s*|\s+and\s+)(?:reveal|put|then|shuffle|exile)\b.*)$/);
	if (!m) return null;
	const parts = [m[1], ...m[2].replace(/^(?:,\s*|\s+and\s+)/, '').split(/,\s*(?:then\s+)?|\s+and\s+(?=put|reveal|shuffle|exile)|,?\s+then\s+/)];
	const okPart = (s: string) =>
		/^(?:reveal (?:it|them|that card|those cards)|shuffle|then shuffle|put (?:it|that card|them|those cards|one|the other|one of them|the rest)\b.*|exile (?:it|that card|them))$/.test(
			s.trim()
		);
	if (!parts.slice(1).every(okPart)) return null;
	if (!parts.some((s) => /^(?:then )?shuffle$/.test(s.trim()))) return null;
	const spec = parseLibrarySearchSpec(t);
	if (!spec || spec.destinations.length === 0) return null;
	// "put that card into your hand", "onto the battlefield", "on top" must all have been understood.
	const puts = parts.filter((s) => /^put\b/.test(s.trim())).join(' ');
	if (!/(?:into your hand|onto the battlefield|on top|into their hand|into that player's hand)/.test(puts)) return null;
	return searchFromLegacy(spec);
}

// ---- Clause productions ---------------------------------------------------------------------

type ClauseResult = boolean;

interface Clause {
	text: string;
	span: Span;
}

/** "until end of turn" at either end of a clause. */
function stripDuration(text: string): { text: string; eot: boolean } {
	let m = text.match(/^(.+?) until end of turn$/);
	if (m) return { text: m[1], eot: true };
	m = text.match(/^until end of turn, (.+)$/);
	if (m) return { text: m[1], eot: true };
	return { text, eot: false };
}

/** "+2/+2", "-X/-X", "+1/+0". */
function ptChange(text: string): { power: Amount; toughness: Amount } | null {
	const m = text.match(/^([+\-−])(\d+|X)\/([+\-−])(\d+|X)$/);
	if (!m) return null;
	const part = (sign: string, v: string): Amount => {
		const base = v === 'X' ? ({ k: 'x' } as Amount) : n(parseInt(v, 10));
		return sign === '+' ? base : base.k === 'const' ? n(-base.n) : { k: 'negate', of: base };
	};
	return { power: part(m[1], m[2]), toughness: part(m[3], m[4]) };
}

const COLOR_WORDS: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};

function isParameterizedGrantKeyword(k: string): boolean {
	return (
		/^protection from (?:[a-z]+|everything)$/.test(k) ||
		/^hexproof from [a-z]+$/.test(k) ||
		/^ward (?:\{[^}]+\})+$/.test(k) ||
		/^ward—pay \d+ life$/.test(k)
	);
}

function keywordList(text: string, allowOr = false): string[] | null {
	const parts = text
		.split(allowOr ? /,? (?:and|or) |, / : /,? and |, /)
		.map((s) => s.trim().toLowerCase());
	if (!parts.every((k) => GRANTABLE_KEYWORDS.includes(k) || k === 'changeling' || isParameterizedGrantKeyword(k))) {
		return null;
	}
	return parts.map((k) =>
		(k.charAt(0).toUpperCase() + k.slice(1)).replace(/\{([^}]+)\}/g, (_, sym: string) => `{${sym.toUpperCase()}}`)
	);
}

function parseBasePT(raw: string): { power: Amount; toughness: Amount } | null {
	const m = raw.match(/^(\d+|X)\/(\d+|X)$/i);
	if (!m) return null;
	const parseSide = (v: string): Amount => (v.toUpperCase() === 'X' ? { k: 'x' } : n(parseInt(v, 10)));
	return { power: parseSide(m[1]), toughness: parseSide(m[2]) };
}

/**
 * Parses `"becomes a/an [P/T] [color(s)] [subtype(s)] [artifact ]creature [with ...] [that's still a land | in addition to its other types]"`.
 */
function parseAnimatePredicate(
	subject: ObjectRes,
	bodyAfterDuration: string,
	eotFromPrefix: boolean,
	span: Span
): EffectStep | null {
	if (subject.fromZone) return null;
	const m = bodyAfterDuration.match(/^becomes? (?:a|an) (.+)$/);
	if (!m) return null;
	let rest = m[1].trim();
	let eot = eotFromPrefix;
	let keepExistingTypes = false;
	let additiveColors = false;
	let basePT: { power: Amount; toughness: Amount } | null = null;
	let addKeywords: string[] | undefined;

	// Strip trailing qualifiers from right to left so order variations ("... with haste until end of turn"
	// vs "... that's still a land" vs "... in addition to its other types until end of turn") all parse.
	for (;;) {
		const durMatch = rest.match(/^(.+?) until end of turn$/);
		if (durMatch) {
			eot = true;
			rest = durMatch[1].trim();
			continue;
		}
		const stillMatch = rest.match(
			/^(.+?)(?:,)? (?:that's |and it's )?still (?:a |an )?(?:lands?|artifacts?|enchantments?|planeswalkers?)$/i
		);
		if (stillMatch) {
			keepExistingTypes = true;
			rest = stillMatch[1].trim();
			continue;
		}
		const inAddColorsMatch = rest.match(/^(.+?) in addition to (?:its|their) other colors and types$/i);
		if (inAddColorsMatch) {
			keepExistingTypes = true;
			additiveColors = true;
			rest = inAddColorsMatch[1].trim();
			continue;
		}
		const inAddMatch = rest.match(/^(.+?) in addition to (?:its|their) other types$/i);
		if (inAddMatch) {
			keepExistingTypes = true;
			rest = inAddMatch[1].trim();
			continue;
		}
		const basePtMatch = rest.match(/^(.+?) with base power and toughness (\d+|X)\/(\d+|X)$/i);
		if (basePtMatch) {
			const pt = parseBasePT(`${basePtMatch[2]}/${basePtMatch[3]}`);
			if (!pt || basePT) return null;
			basePT = pt;
			rest = basePtMatch[1].trim();
			continue;
		}
		const withIdx = rest.indexOf(' with ');
		if (withIdx > 0) {
			const kwRaw = rest.slice(withIdx + ' with '.length).trim();
			// Reject quoted granted abilities (e.g. with "Whenever ~ attacks...") so unmodeled text stays unparsed.
			if (/["“”']/.test(kwRaw)) return null;
			const kws = keywordList(kwRaw);
			if (!kws) return null;
			addKeywords = addKeywords ? [...kws, ...addKeywords] : kws;
			rest = rest.slice(0, withIdx).trim();
			continue;
		}
		break;
	}

	// Core noun phrase: "[P/T] [colorless | <colors>] [Subtypes...] [artifact ]creatures?"
	let isArtifactCreature = false;
	if (/\bartifact creatures?$/.test(rest)) {
		isArtifactCreature = true;
		rest = rest.replace(/\s*artifact creatures?$/, '').trim();
	} else if (/(?:^|\s)creatures?$/.test(rest)) {
		rest = rest.replace(/\s*creatures?$/, '').trim();
	} else {
		return null;
	}

	const tokens = rest
		.replace(/,/g, ' , ')
		.split(/\s+/)
		.filter(Boolean);

	if (tokens[0] && /^(?:\d+|X)\/(?:\d+|X)$/i.test(tokens[0])) {
		if (basePT) return null;
		basePT = parseBasePT(tokens.shift()!);
		if (!basePT) return null;
	}
	// Non-Vehicle animations must specify P/T; "becomes an artifact creature" can rely on printed Vehicle P/T (CR 205.1b).
	if (!basePT && !isArtifactCreature) return null;

	let colors: ManaColor[] | undefined;
	if (tokens[0] === 'colorless') {
		colors = [];
		tokens.shift();
	} else if (tokens[0] && COLOR_WORDS[tokens[0]]) {
		colors = [COLOR_WORDS[tokens.shift()!]];
		while (tokens.length >= 2) {
			if (tokens[0] === ',' && tokens[1] === 'and' && tokens[2] && COLOR_WORDS[tokens[2]]) {
				tokens.shift();
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!]);
			} else if (tokens[0] === ',' && tokens[1] && COLOR_WORDS[tokens[1]]) {
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!]);
			} else if (tokens[0] === 'and' && tokens[1] && COLOR_WORDS[tokens[1]]) {
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!]);
			} else {
				break;
			}
		}
	}

	const subtypes: string[] = [];
	for (const tok of tokens) {
		if (/^[A-Z][A-Za-z'-]*$/.test(tok)) subtypes.push(tok);
		else return null;
	}

	const params: NonNullable<EffectStep['params']> = {
		duration: eot ? 'endOfTurn' : 'permanent'
	};
	const targetTypes = isArtifactCreature ? ['Artifact', 'Creature'] : ['Creature'];
	if (keepExistingTypes) {
		params.addTypes = targetTypes;
		if (subtypes.length > 0) params.addSubtypes = subtypes;
		params.keepExistingTypes = true;
	} else if (isArtifactCreature) {
		// CR 205.1b: "becomes an artifact creature" retains prior card types and subtypes;
		// "becomes a [subtype] artifact creature" retains prior card types while setting creature subtypes.
		params.addTypes = targetTypes;
		if (subtypes.length === 0) {
			params.keepExistingTypes = true;
		} else {
			params.setSubtypes = subtypes;
		}
	} else {
		// CR 205.1a: without "still a ..." or "in addition...", new card types and subtypes replace old ones.
		params.setTypes = targetTypes;
		params.setSubtypes = subtypes;
	}

	if (colors !== undefined) {
		if (additiveColors) params.addColors = colors;
		else params.setColors = colors;
	}
	if (addKeywords && addKeywords.length > 0) params.addKeywords = addKeywords;
	if (basePT) {
		params.setPower = basePT.power;
		params.setToughness = basePT.toughness;
	}

	return { verb: 'animate', subject: subject.selector, params, span };
}

/** Verb phrases whose subject is an object ("~ gets +1/+0 until end of turn", "it phases out"). */
function objectPredicate(p: Parser, subject: ObjectRes, vp: string, span: Span): ClauseResult {
	const { text, eot } = stripDuration(vp);
	const params = eot ? { duration: 'endOfTurn' as const } : {};

	if (/^becomes? (?:a|an) /.test(text)) {
		const anim = parseAnimatePredicate(subject, text, eot, span);
		if (!anim) return false;
		p.push(anim, true);
		return true;
	}

	// "gain trample and get +X/+X" (Overrun templating): two steps on the same subject.
	const both = text.match(/^gains? (.+?) and gets? (\S+)$/);
	if (both && eot) {
		const kws = keywordList(both[1]);
		const pt = ptChange(both[2]);
		if (!kws || !pt) return false;
		p.push({ verb: 'grant', subject: subject.selector, params: { keywords: kws, ...params }, span }, true);
		p.push({ verb: 'pump', subject: subject.selector, amount: pt.power, params: { toughness: pt.toughness, ...params }, span }, true);
		return true;
	}
	const getThenGain = text.match(/^gets? (\S+) and gains? (.+)$/);
	if (getThenGain && eot) {
		const pt = ptChange(getThenGain[1]);
		const kws = keywordList(getThenGain[2]);
		if (!pt || !kws) return false;
		p.push({ verb: 'pump', subject: subject.selector, amount: pt.power, params: { toughness: pt.toughness, ...params }, span }, true);
		p.push({ verb: 'grant', subject: subject.selector, params: { keywords: kws, ...params }, span }, true);
		return true;
	}
	const get = text.match(/^gets? (\S+)$/);
	if (get && eot) {
		const pt = ptChange(get[1]);
		if (!pt) return false;
		p.push({ verb: 'pump', subject: subject.selector, amount: pt.power, params: { toughness: pt.toughness, ...params }, span }, true);
		return true;
	}
	const gain = text.match(/^gains? (.+)$/);
	if (gain && eot) {
		const kws = keywordList(gain[1]);
		if (!kws) return false;
		p.push({ verb: 'grant', subject: subject.selector, params: { keywords: kws, ...params }, span }, true);
		return true;
	}
	const lose = text.match(/^loses? (.+?)(?: and can't (?:have or gain|have|gain) (.+))?$/);
	if (lose && eot) {
		const kws = keywordList(lose[1]);
		if (!kws) return false;
		let cantHaveOrGain = false;
		if (lose[2]) {
			const again = keywordList(lose[2], true);
			if (!again || again.join() !== kws.join()) return false;
			cantHaveOrGain = true;
		}
		p.push(
			{
				verb: 'grant',
				subject: subject.selector,
				params: {
					removeKeywords: kws,
					...(cantHaveOrGain ? { cantHaveOrGain: true } : {}),
					...params
				},
				span
			},
			true
		);
		return true;
	}
	if (/^phases? out$/.test(text) && !eot) {
		p.push({ verb: 'phaseOut', subject: subject.selector, span }, true);
		return true;
	}
	const canDealDamage =
		subject.selector.k === 'self' ||
		subject.selector.k === 'target' ||
		subject.selector.k === 'binding' ||
		subject.selector.k === 'eventObject' ||
		subject.selector.k === 'attachedTo';
	const dmg = text.match(/^deals (\S+) damage to (.+)$/);
	if (dmg && !eot && canDealDamage) {
		const amount = count(dmg[1]);
		const rec = damageRecipientSpec(p, dmg[2], subject.selector);
		if (!amount || !rec) return false;
		const params: EffectStep['params'] = {
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {}),
			...(rec.alsoDamagePlayers ? { alsoDamagePlayers: rec.alsoDamagePlayers } : {})
		};
		p.push(
			{
				verb: 'damage',
				subject: rec.subject,
				amount,
				...(Object.keys(params).length > 0 ? { params } : {}),
				span
			},
			false
		);
		return true;
	}
	const dmgThat = text.match(/^deals (that much|that many) damage to (.+)$/);
	if (dmgThat && !eot && canDealDamage) {
		const amount = amountWord(p, dmgThat[1]);
		const rec = amount ? damageRecipientSpec(p, dmgThat[2], subject.selector) : null;
		if (!amount || !rec) return false;
		const params: EffectStep['params'] = {
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {}),
			...(rec.alsoDamagePlayers ? { alsoDamagePlayers: rec.alsoDamagePlayers } : {})
		};
		p.push(
			{
				verb: 'damage',
				subject: rec.subject,
				amount,
				...(Object.keys(params).length > 0 ? { params } : {}),
				span
			},
			false
		);
		return true;
	}
	const dmgEq = text.match(/^deals damage equal to (.+?) to (.+)$/);
	if (dmgEq && !eot && canDealDamage) {
		let amount: Amount | null = null;
		const ownStat =
			subject.selector.k !== 'self' && subject.ref
				? dmgEq[1].trim().match(/^its (power|toughness|mana value)$/)
				: null;
		if (ownStat && subject.ref) {
			const stat = ownStat[1] === 'mana value' ? 'manaValue' : (ownStat[1] as 'power' | 'toughness');
			amount = { k: 'stat', of: subject.ref, stat };
		} else {
			amount = equalTo(p, dmgEq[1]);
		}
		const rec = amount ? damageRecipientSpec(p, dmgEq[2], subject.selector) : null;
		if (!amount || !rec) return false;
		const params: EffectStep['params'] = {
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {}),
			...(rec.alsoDamagePlayers ? { alsoDamagePlayers: rec.alsoDamagePlayers } : {})
		};
		p.push(
			{
				verb: 'damage',
				subject: rec.subject,
				amount,
				...(Object.keys(params).length > 0 ? { params } : {}),
				span
			},
			false
		);
		return true;
	}
	const fight = text.match(/^fights? (.+)$/);
	if (fight && !eot) {
		const other = parseFightOpponent(p, fight[1], subject.selector);
		if (!other) return false;
		p.push({ verb: 'fight', subject: subject.selector, params: { with: other }, span }, false);
		return true;
	}
	if (/^explores?$/.test(text) && !eot) {
		p.push({ verb: 'explore', subject: subject.selector, span }, true);
		return true;
	}
	const connive = text.match(/^connives?(?: (that many|\S+))?$/);
	if (connive && !eot) {
		const amount = connive[1] ? amountWord(p, connive[1]) : n(1);
		if (!amount) return false;
		p.push({ verb: 'connive', subject: subject.selector, amount, span }, true);
		return true;
	}
	const adapt = text.match(/^adapts? (that many|\S+)$/);
	if (adapt && !eot) {
		const amount = amountWord(p, adapt[1]);
		if (!amount) return false;
		p.push({ verb: 'adapt', subject: subject.selector, amount, span }, true);
		return true;
	}
	return false;
}

function parseFightOpponent(p: Parser, rawText: string, fighterASelector: Selector): Selector | null {
	const trimmed = rawText.trim();
	const isAnotherTarget = /^(?:another target|up to one other target)\b/.test(trimmed);
	const normalized = trimmed
		.replace(/^another target\b/, 'target')
		.replace(/^up to one other target\b/, 'up to one target');
	const other = objectPhrase(p, normalized);
	if (!other) return null;
	if (isAnotherTarget && other.selector.k === 'target') {
		if (fighterASelector.k === 'self') {
			p.targets[other.selector.index].filter.other = true;
		} else if (other.selector.index > 0) {
			p.targets[other.selector.index].otherTarget = true;
		}
	}
	return other.selector;
}

/** The recipient of "deals N damage to ...". */
function damageRecipientSpec(
	p: Parser,
	text: string,
	sourceSelector: Selector
): { subject: Selector; alsoDamagePlayers?: EffectParams['alsoDamagePlayers'] } | null {
	const t = text.trim();
	const eachCreatureAndPlayer = t.match(/^each creature and each (player|opponent)$/);
	if (eachCreatureAndPlayer) {
		return {
			subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } },
			alsoDamagePlayers: {
				relation: eachCreatureAndPlayer[1] === 'player' ? 'each_player' : 'each_opponent'
			}
		};
	}
	if (/^each creature and (?:each )?planeswalker$/.test(t)) {
		return {
			subject: { k: 'all', filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker'] } }
		};
	}
	const isAnotherTarget = /^(?:another target|up to one other target)\b/.test(t);
	if (isAnotherTarget) {
		const normalized = t
			.replace(/^another target\b/, 'target')
			.replace(/^up to one other target\b/, 'up to one target');
		const obj = objectPhrase(p, normalized);
		if (!obj) return null;
		if (obj.selector.k === 'target') {
			if (sourceSelector.k === 'self') {
				p.targets[obj.selector.index].filter.other = true;
			} else if (obj.selector.index > 0) {
				p.targets[obj.selector.index].otherTarget = true;
			}
		}
		if (obj.ref) p.setLastTarget(obj.ref);
		return { subject: obj.selector };
	}
	const player = playerPhrase(p, t);
	if (player) return { subject: player };
	const obj = objectPhrase(p, t);
	if (!obj) return null;
	if (obj.ref) p.setLastTarget(obj.ref);
	return { subject: obj.selector };
}

function parseOptionalCostBody(costText: string): CostDef[] | null {
	const t = costText
		.trim()
		.replace(/^pays\b/i, 'pay')
		.replace(/^sacrifices\b/i, 'sacrifice')
		.replace(/^discards\b/i, 'discard')
		.replace(/^exiles\b/i, 'exile')
		.replace(/^taps\b/i, 'tap')
		.replace(/^removes\b/i, 'remove')
		.replace(/\bfrom their (graveyard|hand)\b/gi, 'from your $1')
		.replace(/\bthey control\b/gi, 'you control');
	const parsed = parseCost(t);
	if (parsed.unparsed.length > 0 || parsed.defs.length === 0) return null;
	return parsed.defs;
}

type ImpulseDuration = NonNullable<EffectParams['playFromExile']>['duration'];

function parseImpulseDurationPhrase(raw: string): ImpulseDuration | null {
	const d = raw.trim().toLowerCase();
	if (d === 'this turn' || d === 'until end of turn') return 'thisTurn';
	if (/^until (?:the )?end of your next turn$/.test(d)) return 'untilEndOfYourNextTurn';
	if (d === 'until your next end step') return 'untilYourNextEndStep';
	if (/^for as long as (?:it remains|they remain|that card remains|those cards remain) exiled$/.test(d)) {
		return 'asLongAsExiled';
	}
	return null;
}

function parsePlayFromExilePredicate(
	p: Parser,
	subject: Selector,
	rawText: string,
	span: Span,
	forcedDuration?: ImpulseDuration
): boolean {
	const head = rawText
		.trim()
		.match(
			/^may (play|cast) (that card|those cards|it|them|the exiled cards?|cards exiled this way|spells from among (?:them|those cards|the exiled cards))(?:\s+(.+))?$/i
		);
	if (!head) return false;
	const actor = singlePlayer(subject);
	if (!actor) return false;
	const verbWord = head[1].toLowerCase();
	const objPhrase = head[2].toLowerCase();
	const spellsOnly = verbWord === 'cast' || objPhrase.startsWith('spells');
	if (!spellsOnly && objPhrase.startsWith('spells')) return false;

	let tail = (head[3] ?? '').trim();
	let spendManaAsAnyColor = false;
	const anyColorMatch = tail.match(
		/^(.*?)(?:,?\s+and you may spend mana as though it were mana of any color to cast (?:it|them|that spell|those spells))$/i
	);
	if (anyColorMatch) {
		spendManaAsAnyColor = true;
		tail = anyColorMatch[1].trim();
	}

	let withoutPayingManaCost = false;
	let duration: ImpulseDuration | null = forcedDuration ?? null;
	if (forcedDuration) {
		if (/^without paying (?:its|their) mana costs?$/i.test(tail)) {
			withoutPayingManaCost = true;
		} else if (tail.length > 0) {
			return false;
		}
	} else {
		const freeBefore = tail.match(/^without paying (?:its|their) mana costs?\s+(.+)$/i);
		const freeAfter = !freeBefore ? tail.match(/^(.+?)\s+without paying (?:its|their) mana costs?$/i) : null;
		if (freeBefore) {
			withoutPayingManaCost = true;
			duration = parseImpulseDurationPhrase(freeBefore[1]);
		} else if (freeAfter) {
			withoutPayingManaCost = true;
			duration = parseImpulseDurationPhrase(freeAfter[1]);
		} else {
			duration = parseImpulseDurationPhrase(tail);
		}
	}
	if (!duration) return false;

	const ref = p.itRef();
	if (!ref) return false;
	const playFromExile: NonNullable<EffectParams['playFromExile']> = {
		duration,
		...(spellsOnly ? { spellsOnly: true } : {}),
		...(withoutPayingManaCost ? { withoutPayingManaCost: true } : {}),
		...(spendManaAsAnyColor ? { spendManaAsAnyColor: true } : {})
	};
	p.lastPlayer = subject;
	p.push(
		{
			verb: 'grantPlayFromExile',
			subject: refSelector(ref),
			...(actor.k !== 'you' ? { actor } : {}),
			params: { playFromExile },
			span
		},
		false
	);
	return true;
}

/** Verb phrases whose subject is a player ("draws two cards", "loses 2 life", "creates a token"). */
function playerPredicate(p: Parser, subject: Selector, vp: string, span: Span, fromImperative = false): ClauseResult {
	let text = vp.trim();
	if (parsePlayFromExilePredicate(p, subject, text, span)) return true;
	let optional: EffectStep['optional'];
	const may = text.match(/^may (.+)$/);
	if (may) {
		const chooser = singlePlayer(subject);
		if (!chooser) return false;
		optional = { chooser };
		text = may[1];
		if (/^pay\b/i.test(text)) {
			const costDefs = parseOptionalCostBody(text);
			if (!costDefs) return false;
			p.lastPlayer = subject;
			p.push(
				{
					verb: 'payCost',
					subject: { k: 'none' },
					optional: { chooser, cost: costDefs, mode: 'doIfPaid' },
					span
				},
				false
			);
			return true;
		}
		const haveFight = text.match(/^have (.+?) fight (.+)$/);
		if (haveFight) {
			const snapshot = p.targets.length;
			const fighterA = objectPhrase(p, haveFight[1]);
			const fighterB = fighterA ? parseFightOpponent(p, haveFight[2], fighterA.selector) : null;
			if (!fighterA || !fighterB) {
				p.targets.length = snapshot;
				return false;
			}
			p.lastPlayer = subject;
			p.push(
				{
					verb: 'fight',
					subject: fighterA.selector,
					params: { with: fighterB },
					optional,
					span
				},
				false
			);
			return true;
		}
	}
	const opt = optional ? { optional } : {};
	p.lastPlayer = subject;

	const moveC = text.match(/^moves? (any number of|\S+) (\S+) counters from (~|it|this creature) onto (.+)$/i);
	if (moveC) {
		const counter = COUNTER_WORDS[moveC[2].toLowerCase()];
		const toFilter = objectFilter(moveC[4]);
		if (counter) {
			p.push(
				{
					verb: 'moveCounters',
					subject: { k: 'self' },
					...(optional ? { optional } : {}),
					params: { counter, ...(toFilter ? { toFilter } : {}) },
					span
				},
				false
			);
			return true;
		}
	}
	const shuffleIntoLib = text.match(/^shuffles? (.+?) into (?:their|your|its owner's) library$/i);
	if (shuffleIntoLib) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const it = p.itRef();
		if (!it) return false;
		p.push(
			{
				verb: 'move',
				subject: refSelector(it),
				...(actor.k !== 'you' ? { actor } : {}),
				params: { to: 'library', mayShuffle: true },
				span
			},
			true
		);
		return true;
	}
	const revTop = text.match(/^reveals? the top card of (?:their|your) library$/i);
	if (revTop) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		p.push(
			{
				verb: 'reveal',
				subject: { k: 'libraryTop', ...(actor.k !== 'you' ? { player: actor } : {}) },
				bindAs: 'chaosRevealed',
				span
			},
			true
		);
		return true;
	}

	let m = text.match(/^draws? (?:(up to) )?(\S+) cards?$/);
	if (m) {
		const amount = count(m[2]);
		if (!amount) return false;
		p.push({ verb: 'draw', subject, amount, ...(m[1] ? { params: { upTo: true } } : {}), ...opt, span }, false);
		return true;
	}
	m = text.match(/^draws? (that many) cards$/);
	if (m) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'draw', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^(gains?|loses?) (that much|that many) life$/);
	if (m) {
		const amount = amountWord(p, m[2]);
		if (!amount) return false;
		p.push({ verb: m[1].startsWith('gain') ? 'gainLife' : 'loseLife', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^draws? cards equal to (.+)$/);
	if (m) {
		const amount = equalTo(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'draw', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^(gains?|loses?) (\S+) life$/);
	if (m) {
		const amount = count(m[2]);
		if (!amount) return false;
		p.push({ verb: m[1].startsWith('gain') ? 'gainLife' : 'loseLife', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^(gains?|loses?) life equal to (.+)$/);
	if (m) {
		const amount = equalTo(p, m[2]);
		if (!amount) return false;
		p.push({ verb: m[1].startsWith('gain') ? 'gainLife' : 'loseLife', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^mills? (that many|\S+) cards?$/);
	if (m) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'mill', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^creates? (.+)$/);
	if (m) {
		const actor = singlePlayer(subject);
		const tok = actor && tokenPhrase(p, m[1]);
		if (!tok || !actor) return false;
		const step: EffectStep = { verb: 'createToken', subject: { k: 'none' }, amount: tok.amount, params: { token: tok.token }, ...opt, span };
		if (actor.k !== 'you') step.actor = actor;
		p.push(step, true);
		return true;
	}
	if (/^search(?:es)? (?:their|your) library\b/.test(text)) {
		const actor = singlePlayer(subject);
		const search = searchClause(text.replace(/^searches/, 'search'));
		if (!search || !actor) return false;
		const step: EffectStep = { verb: 'search', subject: { k: 'none' }, amount: n(search.count), params: { search }, ...opt, span };
		if (actor.k !== 'you') step.actor = actor;
		if (search.destinations.some((d) => d.tapped)) step.params!.tapped = true;
		p.push(step, true);
		return true;
	}
	if (/^takes? an extra turn after this one$/.test(text)) {
		p.push({ verb: 'extraTurn', subject, ...opt, span }, false);
		return true;
	}
	if (/^(?:win|wins) the game$/.test(text)) {
		p.push({ verb: 'win', subject, ...opt, span }, false);
		return true;
	}
	if (/^(?:lose|loses) the game$/.test(text)) {
		p.push({ verb: 'lose', subject, ...opt, span }, false);
		return true;
	}
	m = text.match(/^scry (\S+)$/);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const amount = count(m[1]);
		if (!amount) return false;
		p.push({ verb: 'scry', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^surveils? (\S+)$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = count(m[1]);
		if (!amount) return false;
		p.push({ verb: 'surveil', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^investigates?(?: (twice|once|(that many|\S+) times?))?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		let amount: Amount | null;
		if (!m[1] || m[1] === 'once') amount = n(1);
		else if (m[1] === 'twice') amount = n(2);
		else amount = amountWord(p, m[2]);
		if (!amount) return false;
		p.push({ verb: 'investigate', subject, amount, ...opt, span }, false);
		return true;
	}
	// --- Track P5: CR 701 keyword actions ---
	m = text.match(/^amass(?:es)? ([A-Z][A-Za-z'-]*) (that many|\S+)$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const sub = singularSubtype(m[1]);
		const amount = sub ? amountWord(p, m[2]) : null;
		if (!sub || !amount) return false;
		p.push(
			{ verb: 'amass', subject, amount, params: { amassSubtype: sub }, ...opt, span },
			true
		);
		return true;
	}
	m = text.match(/^amass(?:es)? (that many|\S+)$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push(
			{ verb: 'amass', subject, amount, params: { amassSubtype: 'Zombie' }, ...opt, span },
			true
		);
		return true;
	}
	m = text.match(/^incubates? (that many|\S+)(?: (twice|once|(that many|\S+) times?))?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		let repeat: Amount | undefined;
		if (m[2]) {
			if (m[2] === 'once') repeat = undefined;
			else if (m[2] === 'twice') repeat = n(2);
			else {
				const parsed = amountWord(p, m[3]);
				if (!parsed) return false;
				repeat = parsed;
			}
		}
		p.push(
			{
				verb: 'incubate',
				subject,
				amount,
				...(repeat ? { params: { count: repeat } } : {}),
				...opt,
				span
			},
			true
		);
		return true;
	}
	m = text.match(/^populates?(?: (twice|once|(that many|\S+) times?))?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		let amount: Amount | null;
		if (!m[1] || m[1] === 'once') amount = n(1);
		else if (m[1] === 'twice') amount = n(2);
		else amount = amountWord(p, m[2]);
		if (!amount) return false;
		p.push({ verb: 'populate', subject, amount, ...opt, span }, true);
		return true;
	}
	m = text.match(/^manifests? dread(?: (twice|once|(that many|\S+) times?))?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		let amount: Amount | null;
		if (!m[1] || m[1] === 'once') amount = n(1);
		else if (m[1] === 'twice') amount = n(2);
		else amount = amountWord(p, m[2]);
		if (!amount) return false;
		p.push({ verb: 'manifestDread', subject, amount, ...opt, span }, true);
		return true;
	}
	m = text.match(/^(manifests?|cloaks?) (.+)$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const kind: 'manifest' | 'cloak' = m[1].startsWith('cloak') ? 'cloak' : 'manifest';
		return parseManifestOrCloak(p, subject, kind, m[2], opt, span);
	}
	m = text.match(/^bolsters? (that many|\S+)$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'bolster', subject, amount, ...opt, span }, true);
		return true;
	}
	m = text.match(/^sacrifices? (.+)$/);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		if (m[1] === '~') {
			p.push({ verb: 'sacrifice', subject: { k: 'self' }, ...opt, span }, false);
			return true;
		}
		if (IT_WORDS.test(m[1])) {
			const obj = objectPhrase(p, m[1]);
			if (!obj) return false;
			p.push({ verb: 'sacrifice', subject: obj.selector, ...opt, span }, false);
			return true;
		}
	}
	// Step E2: "sacrifices a creature", "sacrifice two artifacts": the player chooses (CR 701.21a).
	m = text.match(/^sacrifices? (a|an|one|two|three|\d+) (.+)$/);
	if (m) {
		const amount = count(m[1] === 'a' || m[1] === 'an' ? 'one' : m[1]);
		const filter = amount && objectFilter(m[2]);
		if (!amount || !filter || filter.zone || filter.controller) return false;
		const step: EffectStep = { verb: 'sacrifice', subject: { k: 'all', filter: { ...filter, zone: 'battlefield' } }, amount, ...opt, span };
		const actor = singlePlayer(subject);
		if (subject.k === 'player' && subject.filter.relation === 'each_opponent') {
			(step.subject as { filter: ObjectFilter }).filter.controller = 'opponent';
		} else if (actor && actor.k !== 'you') {
			step.actor = actor;
		} else if (!actor) {
	return false;
		}
		p.push(step, true);
		return true;
	}
	// Step E2: "discards two cards", "discards four cards" (the player chooses, CR 701.8b).
	m = text.match(/^discards? (that many|\S+) cards?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'discard', subject, amount, ...opt, span }, true);
		return true;
	}
	m = text.match(
		/^gains? control of (.+?)(?: (until end of turn|for as long as (?:you control ~|~ remains on the battlefield)))?$/
	);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target' && p.targets[obj.selector.index]?.kind === 'player') {
			return false;
		}
		const duration: Duration =
			m[2] === 'until end of turn'
				? 'endOfTurn'
				: m[2]?.startsWith('for as long as')
					? 'untilSourceLeaves'
					: 'permanent';
		p.push(
			{
				verb: 'gainControl',
				subject: obj.selector,
				...(actor.k !== 'you' ? { actor } : {}),
				params: { duration },
				...opt,
				span
			},
			true
		);
		return true;
	}
	m = text.match(/^goads? (.+?)(?: (until end of turn|until your next turn))?$/);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const isAnotherTarget = /^another target\b/.test(m[1]);
		const obj = objectPhrase(p, isAnotherTarget ? m[1].replace(/^another /, '') : m[1]);
		if (!obj || obj.fromZone) return false;
		if (isAnotherTarget && obj.selector.k === 'target') {
			p.targets[obj.selector.index].filter.other = true;
		}
		const duration: Duration = m[2] === 'until end of turn' ? 'endOfTurn' : 'untilYourNextTurn';
		p.push(
			{
				verb: 'goad',
				subject: obj.selector,
				...(actor.k !== 'you' ? { actor } : {}),
				params: { duration },
				...opt,
				span
			},
			true
		);
		return true;
	}
	m = text.match(/^gets?\s+((?:\{E\}\s*)+)$/i);
	if (m) {
		const eCount = (m[1].match(/\{E\}/gi) ?? []).length;
		if (eCount <= 0) return false;
		p.push({ verb: 'gainEnergy', subject, amount: n(eCount), ...opt, span }, false);
		return true;
	}
	m = text.match(/^gets?\s+(that many|\S+)\s*\{E\}$/i);
	if (m) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'gainEnergy', subject, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^gets?\s+an amount of \{E\} equal to (.+)$/i);
	if (m) {
		const amount = equalTo(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'gainEnergy', subject, amount, ...opt, span }, false);
		return true;
	}
	if (/^becomes? the monarch$/i.test(text)) {
		if (!singlePlayer(subject)) return false;
		p.push({ verb: 'becomeMonarch', subject, ...opt, span }, false);
		return true;
	}
	m = text.match(/^adds? (.+)$/);
	if (m && !(subject.k === 'player' && subject.filter.relation === 'you' && !optional)) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const before = p.steps.length;
		if (!addMana(p, m[1], span)) return false;
		for (const s of p.steps.slice(before)) {
			if (actor.k !== 'you') s.actor = actor;
			if (optional) s.optional = optional;
		}
		return true;
	}
	if (/^may end the turn$/.test(`may ${text}`) && optional && subject.k === 'playerRef' && subject.ref.k === 'activePlayer') {
		p.push({ verb: 'endTurn', subject: { k: 'none' }, params: { activePlayerMay: true }, span }, false);
		return true;
	}
	// Imperatives with "you" as an explicit subject ("You draw a card" is handled above).
	if (fromImperative) return false;
	if (subject.k === 'player' && subject.filter.relation === 'you' && !optional) {
		return imperative(p, text, span);
	}
	if (subject.k === 'player' && subject.filter.relation === 'you' && optional) {
		const haveBecome = text.match(/^have (.+?) become ((?:a|an) .+)$/);
		if (haveBecome) {
			const obj = objectPhrase(p, haveBecome[1]);
			if (!obj || obj.fromZone) return false;
			const before = p.steps.length;
			if (!objectPredicate(p, obj, `becomes ${haveBecome[2]}`, span)) return false;
			for (const s of p.steps.slice(before)) s.optional = optional;
			return true;
		}
		const before = p.steps.length;
		if (!imperative(p, text, span)) return false;
		for (const s of p.steps.slice(before)) {
			if (s.verb === 'move' && s.params?.from === 'hand' && s.params?.to === 'battlefield') {
				s.params = { ...s.params, upTo: true };
			} else {
				s.optional = optional;
			}
		}
		return true;
	}
	return false;
}

const YOU: Selector = { k: 'player', filter: { relation: 'you' } };

/**
 * Parses `"the top [N] card(s) of <player>'s library"` after `exile`.
 * Returns `undefined` when `phrase` isn't a top-of-library phrase so callers fall back to `objectPhrase`.
 */
function parseExileTopOfLibrary(p: Parser, phrase: string, span: Span): boolean | undefined {
	const topLib = phrase.match(
		/^the top (?:(\S+) )?cards? of (your|target player's|target opponent's|that player's|their) library$/i
	);
	if (!topLib) return undefined;
	const amount = topLib[1] ? amountWord(p, topLib[1]) : n(1);
	if (!amount) return false;
	const ownerKey = topLib[2].toLowerCase();
	let player: PlayerRef | undefined;
	if (ownerKey === 'your') {
		player = undefined;
	} else if (ownerKey === "target player's" || ownerKey === "target opponent's") {
		const sel = playerPhrase(p, ownerKey === "target player's" ? 'target player' : 'target opponent');
		const pr = sel ? singlePlayer(sel) : null;
		if (!pr) return false;
		p.lastPlayer = sel!;
		player = pr;
	} else {
		const sel = playerPhrase(p, ownerKey === "that player's" ? 'that player' : 'they');
		const pr = sel ? singlePlayer(sel) : null;
		if (!pr) return false;
		player = pr;
	}
	p.push(
		{
			verb: 'exile',
			subject: { k: 'libraryTop', ...(player && player.k !== 'you' ? { player } : {}) },
			amount,
			span
		},
		true
	);
	return true;
}

/**
 * Parses `"manifest ..."` / `"cloak ..."` (top of library, from hand, or general object phrase).
 */
function parseManifestOrCloak(
	p: Parser,
	subject: Selector,
	kind: 'manifest' | 'cloak',
	rawRest: string,
	opt: { optional?: EffectStep['optional'] },
	span: Span
): boolean {
	const rest = rawRest.trim();
	const topLib = rest.match(
		/^the top (?:(that many|\S+) )?cards? of (your|their|that player's|target player's|target opponent's) library( tapped)?$/i
	);
	if (topLib) {
		const amount = topLib[1] ? amountWord(p, topLib[1]) : n(1);
		if (!amount) return false;
		const tapped = Boolean(topLib[3]);
		const ownerKey = topLib[2].toLowerCase();
		const actor = singlePlayer(subject);
		if (!actor) {
			if (ownerKey !== 'their') return false;
			p.push(
				{
					verb: kind,
					subject,
					amount,
					...(tapped ? { params: { tapped: true } } : {}),
					...opt,
					span
				},
				true
			);
			return true;
		}
		let libPlayer: PlayerRef | undefined;
		if (ownerKey === 'your') {
			libPlayer = actor.k === 'you' ? undefined : { k: 'you' };
		} else if (ownerKey === 'their') {
			libPlayer = undefined;
		} else if (ownerKey === "target player's" || ownerKey === "target opponent's") {
			const sel = playerPhrase(p, ownerKey === "target player's" ? 'target player' : 'target opponent');
			const pr = sel ? singlePlayer(sel) : null;
			if (!pr) return false;
			p.lastPlayer = sel!;
			libPlayer = pr;
		} else {
			const sel = playerPhrase(p, 'that player');
			const pr = sel ? singlePlayer(sel) : null;
			if (!pr) return false;
			libPlayer = pr;
		}
		p.push(
			{
				verb: kind,
				subject: {
					k: 'libraryTop',
					...(libPlayer && (actor.k !== 'you' || libPlayer.k !== 'you')
						? { player: libPlayer }
						: {})
				},
				...(actor.k !== 'you' ? { actor } : {}),
				amount,
				...(tapped ? { params: { tapped: true } } : {}),
				...opt,
				span
			},
			true
		);
		return true;
	}

	const fromHand = rest.match(
		/^(up to )?(a|an|one|two|three|four|five|\d+|that many|x) (.+?) from (your|their) hands?( tapped)?$/i
	);
	if (fromHand) {
		const upTo = Boolean(fromHand[1]);
		const cntWord =
			fromHand[2].toLowerCase() === 'a' || fromHand[2].toLowerCase() === 'an'
				? 'one'
				: fromHand[2];
		const amount = amountWord(p, cntWord);
		const filter = amount ? objectFilter(fromHand[3]) : null;
		if (!amount || !filter || filter.zone || filter.controller) return false;
		const tapped = Boolean(fromHand[5]);
		const actor = singlePlayer(subject);
		const handWord = fromHand[4].toLowerCase();
		let owner: ObjectFilter['owner'];
		if (handWord === 'your') {
			if (!actor || actor.k !== 'you') return false;
			owner = 'you';
		} else if (actor) {
			owner = actor.k === 'you' ? 'you' : undefined;
		} else if (subject.k === 'player' && subject.filter.relation === 'each_opponent') {
			owner = 'opponent';
		} else if (subject.k === 'player' && subject.filter.relation === 'each_player') {
			owner = 'any';
		} else {
			return false;
		}
		const params: NonNullable<EffectStep['params']> = {
			...(upTo ? { upTo: true } : {}),
			...(tapped ? { tapped: true } : {})
		};
		p.push(
			{
				verb: kind,
				subject: {
					k: 'all',
					filter: { ...filter, zone: 'hand', ...(owner ? { owner } : {}) }
				},
				...(actor && actor.k !== 'you' ? { actor } : {}),
				amount,
				...(Object.keys(params).length > 0 ? { params } : {}),
				...opt,
				span
			},
			true
		);
		return true;
	}

	const actor = singlePlayer(subject);
	if (!actor) return false;
	const tapSuffix = rest.match(/^(.+?) tapped$/);
	const expr = tapSuffix ? tapSuffix[1] : rest;
	const tapped = Boolean(tapSuffix);
	const snapshot = p.targets.length;
	const obj = objectPhrase(p, expr);
	if (
		!obj ||
		(obj.selector.k === 'target' && p.targets[obj.selector.index]?.filter.zone === 'battlefield')
	) {
		p.targets.length = snapshot;
		return false;
	}
	p.push(
		{
			verb: kind,
			subject: obj.selector,
			...(actor.k !== 'you' ? { actor } : {}),
			...(tapped ? { params: { tapped: true } } : {}),
			...opt,
			span
		},
		true
	);
	return true;
}

/** Clauses without a subject: "Destroy target creature", "Draw a card", "Create a Treasure token". */
function imperative(p: Parser, text: string, span: Span): ClauseResult {
	const t = text.trim();
	let m: RegExpMatchArray | null;

	if (
		/^(?:draw|gain|lose|mill|create|search|take|scry|surveil|sacrifice|discard|investigate|goad|amass|incubate|populate|manifest|cloak|bolster)\b/.test(
			t
		) &&
		!/^lose hexproof/.test(t) &&
		!/^create a token that's a copy\b/.test(t)
	) {
		return playerPredicate(p, YOU, t, span, true);
	}
	if (t === 'proliferate') {
		p.push({ verb: 'proliferate', subject: { k: 'none' }, span }, false);
		return true;
	}
	if (t === 'end the turn') {
		p.push({ verb: 'endTurn', subject: { k: 'none' }, span }, false);
		return true;
	}
	m = t.match(/^attach(?: ~)? to (.+)$/);
	if (m) {
		const snapshot = p.targets.length;
		const obj = objectPhrase(p, m[1]);
		if (!obj) {
			p.targets.length = snapshot;
			return false;
		}
		const validAttachTarget =
			(obj.selector.k === 'target' && /^target .+ you control$/.test(m[1])) ||
			obj.selector.k === 'binding' ||
			obj.selector.k === 'eventObject';
		if (!validAttachTarget) {
			p.targets.length = snapshot;
			return false;
		}
		p.push({ verb: 'attach', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^(destroy|exile) (.+)$/);
	if (m) {
		let expr = m[2];
		let untilSourceLeaves = false;
		if (m[1] === 'exile') {
			const untilMatch = expr.match(/^(.+?)\s+until ~ leaves the battlefield$/);
			if (untilMatch) {
				untilSourceLeaves = true;
				expr = untilMatch[1];
			}
			const top = parseExileTopOfLibrary(p, expr, span);
			if (top !== undefined) return untilSourceLeaves ? false : top;
		}
		const obj = objectPhrase(p, expr);
		if (!obj) return false;
		const verb = m[1] as 'destroy' | 'exile';
		if (verb === 'destroy' && obj.selector.k === 'self') return false;
		p.push(
			{
				verb,
				subject: obj.selector,
				...(untilSourceLeaves ? { params: { untilSourceLeaves: true } } : {}),
				span
			},
			true
		);
		return true;
	}
	m = t.match(/^(tap or untap|tap|untap) (.+)$/);
	if (m) {
		const isAnotherTarget = /^another target\b/.test(m[2]);
		const obj = objectPhrase(p, isAnotherTarget ? m[2].replace(/^another /, '') : m[2]);
		if (!obj || obj.fromZone) return false;
		if (isAnotherTarget && obj.selector.k === 'target') {
			p.targets[obj.selector.index].filter.other = true;
		}
		const verb: Verb = m[1] === 'tap' ? 'tap' : m[1] === 'untap' ? 'untap' : 'tapOrUntap';
		p.push({ verb, subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^exert (.+)$/);
	if (m) {
		const isAnotherTarget = /^another target\b/.test(m[1]);
		const obj = objectPhrase(p, isAnotherTarget ? m[1].replace(/^another /, '') : m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target' && p.targets[obj.selector.index]?.kind !== 'object') return false;
		if (
			obj.selector.k === 'target' &&
			(p.targets[obj.selector.index]?.filter.zone ?? 'battlefield') !== 'battlefield'
		) {
			return false;
		}
		if (isAnotherTarget && obj.selector.k === 'target') {
			p.targets[obj.selector.index].filter.other = true;
		}
		p.push({ verb: 'exert', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^counter (.+)$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.selector.k !== 'target' || p.targets[obj.selector.index].filter.zone !== 'stack') return false;
		p.push({ verb: 'counterSpell', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^(?:you may )?target ((?:one|two|three|four|five|six|\d+) .+)$/);
	if (m) {
		const obj = objectPhrase(p, `target ${m[1]}`);
		if (!obj || !obj.ref) return false;
		p.setLastTarget(obj.ref);
		return true;
	}
	m = t.match(/^return (.+?) to (?:its|their) owners?'s? hands?$/);
	if (m) {
		const selfTrigGy =
			m[1] === '~' &&
			p.context === 'triggered' &&
			p.trigger?.event === 'zoneChange' &&
			p.trigger.filter.from === 'battlefield' &&
			p.trigger.filter.to === 'graveyard';
		if (selfTrigGy) {
			p.push({ verb: 'move', subject: { k: 'self' }, params: { from: 'graveyard', to: 'hand' }, span }, true);
			return true;
		}
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		if (obj.fromZone === 'graveyard' || obj.fromZone === 'exile') {
			p.push({ verb: 'move', subject: obj.selector, params: { from: obj.fromZone, to: 'hand' }, span }, true);
			return true;
		}
		if (obj.fromZone) return false;
		if (
			obj.selector.k === 'eventObject' &&
			p.context === 'triggered' &&
			p.trigger?.event === 'zoneChange' &&
			p.trigger.filter.from === 'battlefield'
		) {
			const trigTo = p.trigger.filter.to;
			const alts = p.trigger.or ?? [];
			const allGyOrExile =
				(trigTo === 'graveyard' || trigTo === 'exile') &&
				alts.every(
					(alt) =>
						alt.event === 'zoneChange' &&
						alt.filter.from === 'battlefield' &&
						(alt.filter.to === 'graveyard' || alt.filter.to === 'exile')
				);
			if (allGyOrExile) {
				const mixed = alts.some((alt) => alt.filter.to !== trigTo);
				p.push(
					{
						verb: 'move',
						subject: obj.selector,
						params: { ...(mixed ? {} : { from: trigTo }), to: 'hand' },
						span
					},
					true
				);
				return true;
			}
		}
		const tgtZone = obj.selector.k === 'target' ? p.targets[obj.selector.index].filter.zone : undefined;
		if (tgtZone === 'graveyard' || tgtZone === 'exile') {
			p.push({ verb: 'move', subject: obj.selector, params: { from: tgtZone, to: 'hand' }, span }, true);
			return true;
		}
		p.push({ verb: 'bounce', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^put (a|an|one|two|three|\d+) (.+?) from your hand (?:(on top|on the bottom) of your library(?: in any order)?|onto the battlefield( tapped)?)$/);
	if (m) {
		const amount = count(m[1] === 'a' || m[1] === 'an' ? 'one' : m[1]);
		const filter = amount && objectFilter(m[2]);
		if (!amount || !filter || filter.zone || filter.controller) return false;
		const to = m[3] ? ('library' as const) : ('battlefield' as const);
		const params: NonNullable<EffectStep['params']> = { from: 'hand', to };
		if (m[3]) params.position = m[3] === 'on top' ? 'top' : 'bottom';
		if (m[4]) params.tapped = true;
		p.push(
			{
				verb: 'move',
				subject: { k: 'all', filter: { ...filter, zone: 'hand', owner: 'you' } },
				amount,
				params,
				span
			},
			true
		);
		return true;
	}
	if (tryImperativeLibraryMove(p, t, span)) {
		return true;
	}
	m = t.match(/^(?:return|put) (.+) (?:to|onto) the battlefield( tapped)?(?: (?:and )?(transformed))?( under your control| under its owner's control)?$/);
	if (m) {
		const exiledSelf = m[1] === '~' && p.steps.some((s) => s.verb === 'exile' && s.subject.k === 'self');
		const selfFromGy =
			!exiledSelf && (m[1] === '~ from your graveyard' || (m[1] === '~' && p.context === 'triggered'));
		const obj = exiledSelf
			? { selector: { k: 'self' } as Selector, fromZone: 'exile' as const }
			: selfFromGy
				? { selector: { k: 'self' } as Selector, fromZone: 'graveyard' as const }
				: objectPhrase(p, m[1]);
		if (!obj) return false;
		let eventObjFrom: 'graveyard' | 'exile' | 'either' | undefined;
		if (
			obj.selector.k === 'eventObject' &&
			p.context === 'triggered' &&
			p.trigger?.event === 'zoneChange' &&
			p.trigger.filter.from === 'battlefield'
		) {
			const trigTo = p.trigger.filter.to;
			const alts = p.trigger.or ?? [];
			const allGyOrExile =
				(trigTo === 'graveyard' || trigTo === 'exile') &&
				alts.every(
					(alt) =>
						alt.event === 'zoneChange' &&
						alt.filter.from === 'battlefield' &&
						(alt.filter.to === 'graveyard' || alt.filter.to === 'exile')
				);
			if (allGyOrExile) {
				eventObjFrom = alts.some((alt) => alt.filter.to !== trigTo) ? 'either' : trigTo;
			}
		}
		const boundFromExile =
			obj.selector.k === 'binding' &&
			p.steps.some((s) => s.bindAs === (obj.selector as { k: 'binding'; name: string }).name && s.verb === 'exile');
		const fromExile =
			eventObjFrom === 'exile' ||
			obj.fromZone === 'exile' ||
			boundFromExile ||
			(obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'exile');
		const fromGy =
			!fromExile &&
			(eventObjFrom === 'graveyard' ||
				obj.fromZone === 'graveyard' ||
				(obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'graveyard'));
		const fromEither = !fromExile && !fromGy && eventObjFrom === 'either';
		if (!fromGy && !fromExile && !fromEither) return false;
		const params: EffectStep['params'] = {
			...(fromEither ? {} : { from: fromExile ? 'exile' : 'graveyard' }),
			to: 'battlefield'
		};
		if ('topmostOnly' in obj && obj.topmostOnly) params.topmostOnly = true;
		if (m[2]) params.tapped = true;
		if (m[3]) params.enteredTransformed = true;
		if (m[4]?.trim() === 'under your control') params.underYourControl = true;
		p.push({ verb: 'move', subject: obj.selector, params, span }, true);
		return true;
	}
	m = t.match(/^return (.+) to (?:your|its owner's|their owner's|their owners') hands?$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		const boundFromExile =
			obj.selector.k === 'binding' &&
			p.steps.some((s) => s.bindAs === (obj.selector as { k: 'binding'; name: string }).name && s.verb === 'exile');
		const fromExile =
			obj.fromZone === 'exile' ||
			boundFromExile ||
			(obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'exile');
		const fromGy =
			!fromExile &&
			(obj.fromZone === 'graveyard' ||
				(obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'graveyard'));
		if (fromExile) {
			p.push({ verb: 'move', subject: obj.selector, params: { from: 'exile', to: 'hand' }, span }, true);
			return true;
		}
		if (fromGy) {
			p.push({ verb: 'move', subject: obj.selector, params: { from: 'graveyard', to: 'hand' }, span }, true);
			return true;
		}
		if (obj.fromZone) return false;
		p.push({ verb: 'bounce', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^put (that many|\S+) (\S+) counters? on (.+)$/);
	if (m) {
		const amount = m[1] === 'that many' ? p.thatMany() : count(m[1]);
		const counter = COUNTER_WORDS[m[2]];
		const obj = objectPhrase(p, m[3]);
		if (!amount || !counter || !obj) return false;
		p.push({ verb: 'putCounters', subject: obj.selector, amount, params: { counter }, span }, true);
		return true;
	}
	m = t.match(/^switch (.+?)'s power and toughness until end of turn$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		p.push({ verb: 'switchPT', subject: obj.selector, params: { duration: 'endOfTurn' }, span }, true);
		return true;
	}
	m = t.match(/^create (.+)$/);
	if (m) {
		const copy = m[1].match(/^a token that's a copy of (.+?)(?:, except the token isn't legendary)?$/);
		if (copy) {
			const notLegendary = m[1].endsWith("except the token isn't legendary");
			const obj = objectPhrase(p, copy[1]);
			if (!obj) return false;
			p.push(
				{
					verb: 'copyPermanent',
					subject: obj.selector,
					...(notLegendary ? { params: { notLegendary: true } } : {}),
					span
				},
				true
			);
			return true;
		}
	}
	m = t.match(/^copy (.+)$/);
	if (m) {
		let copyRest = m[1].trim();
		let mayChooseNewTargets = false;
		let nonLegendary = false;
		let exceptColors: ManaColor[] | undefined;
		let copyCount: Amount | undefined;

		const inlineRetarget = copyRest.match(
			/^(.+?)(?:,?\s+and)?\s+you may choose new targets for (?:the|each|any|any of the) cop(?:y|ies)$/i
		);
		if (inlineRetarget) {
			mayChooseNewTargets = true;
			copyRest = inlineRetarget[1].trim();
		}

		for (;;) {
			const nonLegMatch = copyRest.match(/^(.+?), except (?:it|the copy) isn't legendary$/i);
			if (nonLegMatch && !nonLegendary) {
				nonLegendary = true;
				copyRest = nonLegMatch[1].trim();
				continue;
			}
			const colMatch = copyRest.match(
				/^(.+?), except (?:it's|the copy is) (colorless|white|blue|black|red|green)$/i
			);
			if (colMatch && exceptColors === undefined) {
				const cw = colMatch[2].toLowerCase();
				exceptColors = cw === 'colorless' ? [] : [COLOR_WORDS[cw]];
				copyRest = colMatch[1].trim();
				continue;
			}
			break;
		}

		const forEachMatch = copyRest.match(/^(.+?) for each (.+)$/i);
		if (forEachMatch) {
			const what = forEachMatch[2].trim();
			if (/^other spell (?:that was )?cast before it this turn$/i.test(what)) {
				copyCount = { k: 'stormCount' };
			} else if (/^time (?:it|~|this spell) was kicked$/i.test(what)) {
				copyCount = { k: 'kickedCount' };
			} else {
				copyCount = numberOf(what) ?? undefined;
			}
			if (!copyCount) return false;
			copyRest = forEachMatch[1].trim();
		} else if (/\s+twice$/i.test(copyRest)) {
			copyCount = n(2);
			copyRest = copyRest.replace(/\s+twice$/i, '').trim();
		} else {
			const timesMatch = copyRest.match(/^(.+?)\s+(that many|\S+) times$/i);
			if (timesMatch) {
				const parsedAmt = amountWord(p, timesMatch[2]);
				if (!parsedAmt) return false;
				copyCount = parsedAmt;
				copyRest = timesMatch[1].trim();
			}
		}

		const obj = objectPhrase(p, copyRest);
		if (!obj) return false;
		const sel = obj.selector;
		const validStackSubject =
			(sel.k === 'target' && p.targets[sel.index]?.filter.zone === 'stack') ||
			(sel.k === 'eventObject' && p.context === 'triggered') ||
			sel.k === 'self' ||
			(sel.k === 'binding' &&
				p.steps.some(
					(st) =>
						st.bindAs === sel.name &&
						st.subject.k === 'target' &&
						p.targets[st.subject.index]?.filter.zone === 'stack'
				));
		if (!validStackSubject) return false;
		const params: NonNullable<EffectStep['params']> = {
			...(copyCount ? { count: copyCount } : {}),
			...(mayChooseNewTargets ? { mayChooseNewTargets: true } : {}),
			...(nonLegendary ? { nonLegendary: true } : {}),
			...(exceptColors !== undefined ? { exceptColors } : {})
		};
		p.push(
			{
				verb: 'copySpell',
				subject: sel,
				...(Object.keys(params).length > 0 ? { params } : {}),
				span
			},
			true
		);
		return true;
	}
	m = t.match(/^add (.+)$/);
	if (m) return addMana(p, m[1], span);
	m = t.match(/^look at the top (\S+) cards of your library, then put them back in any order$/);
	if (m) {
		const amount = count(m[1]);
		if (!amount) return false;
		p.push({ verb: 'lookAndReorder', subject: YOU, amount, span }, false);
		return true;
	}
	m = t.match(/^(look at|reveal) the top (\S+) cards? of your library$/);
	if (m) {
		const amount = count(m[2]);
		if (!amount) return false;
		const stepIndex = p.push({ verb: 'dig', subject: YOU, amount, span }, false);
		p.pendingDig = {
			stepIndex,
			hasKeep: false,
			hasRest: false,
			draft: {
				keep: 0,
				upTo: false,
				keepTo: 'hand',
				rest: 'libraryBottom',
				...(m[1] === 'reveal' ? { revealAll: true } : {})
			}
		};
		return true;
	}
	m = t.match(/^(transform|convert|flip) (.+)$/);
	if (m) {
		const verb: 'transform' | 'flip' = m[1] === 'flip' ? 'flip' : 'transform';
		const obj = objectPhrase(p, m[2]);
		if (!obj) return false;
		p.push({ verb, subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^monstrosity (that many|\S+)$/);
	if (m) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'monstrosity', subject: { k: 'self' }, amount, span }, false);
		return true;
	}
	m = t.match(/^support (\S+)$/);
	if (m) {
		const c = count(m[1]);
		if (!c || c.k !== 'const' || c.n < 1) return false;
		const index = p.addTarget({
			kind: 'object',
			min: 0,
			max: c.n,
			filter: {
				zone: 'battlefield',
				types: ['Creature'],
				...(p.context !== 'spell' ? { other: true } : {})
			}
		});
		p.push(
			{
				verb: 'putCounters',
				subject: { k: 'target', index },
				amount: n(1),
				params: { counter: '+1/+1' },
				span
			},
			true
		);
		return true;
	}
	m = t.match(/^adapt (that many|\S+)$/);
	if (m) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'adapt', subject: { k: 'self' }, amount, span }, false);
		return true;
	}
	m = t.match(/^regenerate (.+)$/);
	if (m) {
		const isAnotherTarget = /^another target\b/.test(m[1]);
		const obj = objectPhrase(p, isAnotherTarget ? m[1].replace(/^another /, '') : m[1]);
		if (!obj || obj.fromZone) return false;
		if (isAnotherTarget && obj.selector.k === 'target') {
			p.targets[obj.selector.index].filter.other = true;
		}
		p.push({ verb: 'regenerate', subject: obj.selector, span }, true);
		return true;
	}
	if (/^(?:after this phase, )?there is an additional combat phase$/i.test(t)) {
		p.push({ verb: 'extraCombatPhase', subject: { k: 'none' }, span }, false);
		return true;
	}
	if (/^take an extra turn after this one$/.test(t)) return playerPredicate(p, YOU, t, span, true);
	return false;
}

const LIBRARY_ORDINAL_FROM_TOP: Readonly<Record<string, number>> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6,
	seventh: 7,
	eighth: 8,
	ninth: 9,
	tenth: 10
};

function parseLibraryOrdinalFromTop(raw: string): number | null {
	const low = raw.trim().toLowerCase();
	if (LIBRARY_ORDINAL_FROM_TOP[low] !== undefined) return LIBRARY_ORDINAL_FROM_TOP[low];
	const num = low.match(/^(\d+)(?:st|nd|rd|th)$/);
	if (!num) return null;
	const val = parseInt(num[1], 10);
	return val >= 1 ? val : null;
}

function resolveLibraryMoveSourceZone(p: Parser, obj: ObjectRes): ZoneType | 'any' | null {
	const normZone = (z: ZoneType | ZoneType[] | undefined): ZoneType | 'any' =>
		Array.isArray(z) ? 'any' : (z ?? 'battlefield');
	if (obj.fromZone) return obj.fromZone;
	const sel = obj.selector;
	if (sel.k === 'target') {
		const spec = p.targets[sel.index];
		if (!spec || spec.kind !== 'object') return null;
		return normZone(spec.filter.zone);
	}
	if (sel.k === 'self') {
		if (p.context === 'spell') return 'stack';
		if (
			p.context === 'triggered' &&
			p.trigger?.event === 'zoneChange' &&
			p.trigger.filter.from === 'battlefield' &&
			(p.trigger.filter.to === 'graveyard' || p.trigger.filter.to === 'exile')
		) {
			return p.trigger.filter.to;
		}
		return 'battlefield';
	}
	if (sel.k === 'binding') {
		const bound = p.steps.find((s) => s.bindAs === sel.name);
		if (bound?.verb === 'exile') return 'exile';
		if (bound?.subject.k === 'target') {
			const spec = p.targets[bound.subject.index];
			return spec && spec.kind === 'object' ? normZone(spec.filter.zone) : 'battlefield';
		}
		return 'any';
	}
	if (sel.k === 'eventObject' && p.context === 'triggered') {
		if (p.trigger?.event === 'cast') return 'stack';
		if (
			p.trigger?.event === 'zoneChange' &&
			(p.trigger.filter.to === 'graveyard' || p.trigger.filter.to === 'exile')
		) {
			return p.trigger.filter.to;
		}
		return 'battlefield';
	}
	if (sel.k === 'all') {
		return normZone(sel.filter.zone);
	}
	if (sel.k === 'attachedTo') {
		return 'battlefield';
	}
	return null;
}

function pushLibraryMoveStep(
	p: Parser,
	obj: ObjectRes,
	extraParams: Partial<EffectParams>,
	span: Span
): boolean {
	const srcZone = resolveLibraryMoveSourceZone(p, obj);
	if (!srcZone) return false;
	const params: EffectParams = {
		...(srcZone !== 'any' ? { from: srcZone } : {}),
		to: 'library',
		...extraParams
	};
	if (obj.topmostOnly) params.topmostOnly = true;
	p.push({ verb: 'move', subject: obj.selector, params, span }, true);
	return true;
}

function tryImperativeLibraryMove(p: Parser, t: string, span: Span): boolean {
	// "put <subj> on [your choice of] [the] top or bottom of its/their owner's library"
	let m = t.match(
		/^put (.+?) on (?:your choice of )?(?:the )?top or bottom of (?:its|their|your) (?:owner's |owners' )?librar(?:y|ies)$/i
	);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		return obj
			? pushLibraryMoveStep(p, obj, { position: 'topOrBottom', libraryChoiceBy: 'controller' }, span)
			: false;
	}
	// "put <subj> into its owner's library second from the top or on the bottom"
	m = t.match(
		/^put (.+?) into (?:its|their|your) (?:owner's )?library second from the top or on the bottom$/i
	);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		return obj
			? pushLibraryMoveStep(p, obj, { position: 'secondOrBottom', libraryChoiceBy: 'controller' }, span)
			: false;
	}
	// "put <subj> into its owner's library <Nth> from the top"
	m = t.match(
		/^put (.+?) into (?:its|their|your) (?:owner's )?library ([a-z0-9]+) from the top$/i
	);
	if (m) {
		const fromTop = parseLibraryOrdinalFromTop(m[2]);
		if (fromTop === null) return false;
		const obj = objectPhrase(p, m[1]);
		return obj ? pushLibraryMoveStep(p, obj, { position: 'top', fromTop }, span) : false;
	}
	// "put <subj> on (the) top / on (the) bottom of its/their owner's library[s]" (or "your library")
	m = t.match(
		/^put (.+?) on ((?:the )?top|(?:the )?bottom) of (its owner's|their owner's|their owners'|your) librar(?:y|ies)(?: in any order)?$/i
	);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		if (m[3].toLowerCase() === 'your') {
			const sel = obj.selector;
			const okYour =
				sel.k === 'self' ||
				sel.k === 'binding' ||
				(sel.k === 'target' && p.targets[sel.index]?.filter.owner === 'you') ||
				(sel.k === 'target' && p.targets[sel.index]?.filter.controller === 'you') ||
				(sel.k === 'all' && (sel.filter.owner === 'you' || sel.filter.controller === 'you'));
			if (!okYour) return false;
		}
		const position = m[2].toLowerCase().includes('top') ? 'top' : 'bottom';
		return pushLibraryMoveStep(p, obj, { position }, span);
	}
	return false;
}

function tryOwnerLibraryMoveClause(p: Parser, t: string, span: Span): boolean {
	let subjPhrase: string | null = null;
	let tail: string | null = null;

	const ofForm = t.match(/^the owner of (.+?) puts (?:it|them|that [a-z]+|those [a-z]+) (.+)$/i);
	if (ofForm) {
		subjPhrase = ofForm[1].trim();
		tail = ofForm[2].trim();
	} else {
		const possForm = t.match(/^(.+?)'s owner puts (?:it|them|that [a-z]+|those [a-z]+) (.+)$/i);
		if (possForm) {
			subjPhrase = possForm[1].trim();
			tail = possForm[2].trim();
		} else {
			const itsForm = t.match(/^(?:its|their) owners? puts? (?:it|them|that [a-z]+|those [a-z]+) (.+)$/i);
			if (itsForm) {
				subjPhrase = 'it';
				tail = itsForm[1].trim();
			}
		}
	}
	if (!subjPhrase || !tail) return false;

	const snapshot = p.mark();
	const obj = objectPhrase(p, subjPhrase);
	if (!obj) {
		p.rollback(snapshot);
		return false;
	}

	if (/^on (?:their choice of )?(?:the )?top or bottom of their librar(?:y|ies)$/i.test(tail)) {
		if (pushLibraryMoveStep(p, obj, { position: 'topOrBottom', libraryChoiceBy: 'owner' }, span)) {
			return true;
		}
		p.rollback(snapshot);
		return false;
	}
	if (/^into their library second from the top or on the bottom$/i.test(tail)) {
		if (pushLibraryMoveStep(p, obj, { position: 'secondOrBottom', libraryChoiceBy: 'owner' }, span)) {
			return true;
		}
		p.rollback(snapshot);
		return false;
	}
	const nthMatch = tail.match(/^into their library ([a-z0-9]+) from the top$/i);
	if (nthMatch) {
		const fromTop = parseLibraryOrdinalFromTop(nthMatch[1]);
		if (fromTop !== null && pushLibraryMoveStep(p, obj, { position: 'top', fromTop }, span)) {
			return true;
		}
		p.rollback(snapshot);
		return false;
	}
	const detMatch = tail.match(/^on ((?:the )?top|(?:the )?bottom) of their librar(?:y|ies)(?: in any order)?$/i);
	if (detMatch) {
		const position = detMatch[1].toLowerCase().includes('top') ? 'top' : 'bottom';
		if (pushLibraryMoveStep(p, obj, { position }, span)) {
			return true;
		}
		p.rollback(snapshot);
		return false;
	}

	p.rollback(snapshot);
	return false;
}

/** "Add {R}{R}{R}", "Add one mana of any color", "Add {G} for each Elf you control". */
function addMana(p: Parser, text: string, span: Span): ClauseResult {
	const t = text.trim().replace(/^an additional\s+/i, '');
	const symbols = (s: string) =>
		(s.match(/\{([WUBRGC])\}/gi) ?? []).map((x) => x[1].toUpperCase() as ManaColor);
	if (/^(?:\{[WUBRGC]\})+$/i.test(t)) {
		const mana = symbols(t);
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(mana.length), params: { mana }, span }, false);
		return true;
	}
	if (/^\{[WUBRGC]\}(?:, \{[WUBRGC]\})*,? or \{[WUBRGC]\}$/i.test(t)) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(1), params: { manaChoice: symbols(t) }, span }, false);
		return true;
	}
	if (/^(?:\{[WUBRGC]\})+(?:,\s*(?:\{[WUBRGC]\})+)*,?\s+or\s+(?:\{[WUBRGC]\})+$/i.test(t)) {
		const parts = t
			.split(/,\s*or\s+|\s+or\s+|,\s*/i)
			.map((s) => s.trim())
			.filter(Boolean);
		if (parts.length >= 2 && parts.every((pt) => /^(?:\{[WUBRGC]\})+$/i.test(pt))) {
			const manaBundles = parts.map((pt) => symbols(pt));
			p.push(
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount: n(manaBundles[0].length),
					params: { manaBundles },
					span
				},
				false
			);
			return true;
		}
	}
	let m = t.match(/^(\S+) mana of the chosen color$/i);
	if (m && count(m[1])) {
		p.push(
			{ verb: 'addMana', subject: { k: 'none' }, amount: count(m[1])!, params: { manaChoice: 'chosenColor' }, span },
			false
		);
		return true;
	}
	m = t.match(
		/^((?:\{[WUBRGC]\}(?:,?\s*\{[WUBRGC]\})*))(?:,\s*|\s+)and (?:one|1) mana of the chosen color$/i
	);
	if (m) {
		const cols = symbols(m[1]);
		if (cols.length > 0) {
			p.push(
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount: n(1),
					params: { manaWithChosenColor: cols },
					span
				},
				false
			);
			return true;
		}
	}
	m = t.match(/^(that much|that many|\S+) mana in any combination of colors$/i);
	if (m) {
		const amount = amountWord(p, m[1].toLowerCase());
		if (amount) {
			p.push(
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount,
					params: { manaCombinationColors: 'any' },
					span
				},
				false
			);
			return true;
		}
	}
	m = t.match(
		/^(that much|that many|\S+) mana in any combination of ((?:\{[WUBRGC]\}(?:,\s*and\/or\s+|,\s*or\s+|,\s*and\s+|\s+and\/or\s+|\s+or\s+|\s+and\s+|,\s*)?)+)$/i
	);
	if (m) {
		const amount = amountWord(p, m[1].toLowerCase());
		const cols = symbols(m[2]);
		if (amount && cols.length >= 2) {
			p.push(
				{
					verb: 'addMana',
					subject: { k: 'none' },
					amount,
					params: { manaCombinationColors: cols },
					span
				},
				false
			);
			return true;
		}
	}
	m = t.match(/^(\S+) mana of any (?:one )?color$/);
	if (m && count(m[1])) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: count(m[1])!, params: { manaChoice: 'any' }, span }, false);
		return true;
	}
	m = t.match(/^(\S+) mana of any (?:one )?color in your commander's color identity$/);
	if (m && count(m[1])) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: count(m[1])!, params: { manaChoice: 'commanderIdentity' }, span }, false);
		return true;
	}
	if (/^one mana of any color that a land an opponent controls could produce$/.test(t)) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(1), params: { manaChoice: 'opponentLandColors' }, span }, false);
		return true;
	}
	m = t.match(/^\{([WUBRGC])\} for each (.+)$/);
	if (m) {
		if (/^cards? in target opponent's hand$/i.test(m[2])) {
			const targetIdx = p.addTarget({ kind: 'player', player: { relation: 'opponent' }, filter: {}, min: 1, max: 1 });
			const of: Amount = { k: 'cardsIn', zone: 'hand', of: { k: 'target', index: targetIdx } };
			p.push({ verb: 'addMana', subject: { k: 'none' }, amount: of, params: { mana: [m[1] as ManaColor] }, span }, false);
			return true;
		}
		const amount = numberOf(m[2].replace(/^(\S+)/, (w) => w));
		const each = m[2].match(/^(\S+) (you control|on the battlefield)$/);
		let of: Amount | null = amount;
		if (each) {
			const filter = objectFilter(each[1]);
			of = filter ? { k: 'count', of: { ...filter, zone: 'battlefield', ...(each[2] === 'you control' ? { controller: 'you' as const } : {}) } } : null;
		}
		if (!of) return false;
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: of, params: { mana: [m[1] as ManaColor] }, span }, false);
		return true;
	}
	m = t.match(/^an amount of \{([WUBRGC])\} equal to (.+)$/);
	if (m) {
		const amount = equalTo(p, m[2]);
		if (!amount) return false;
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount, params: { mana: [m[1] as ManaColor] }, span }, false);
		return true;
	}
	return false;
}

// Words that start a new clause after " and " / ", then ".
const CLAUSE_START =
	/^(?:you|each opponent|each player|target player|target opponent|its controller|its owner|(?:that|the exiled) (?:card|creature|permanent|spell)'s (?:controller|owner)|that player|they|it (?=deals|fights?|gets?|gains?|loses?|explores?|connives?|adapts?|phases?|becomes?|doesn't|does not)|that creature |those creatures |that permanent |those permanents |the amassed [Aa]rmy |enchanted |equipped |until (?:end of turn|(?:the )?end of your next turn|your next end step), |for as long as |draw|draws|lose|loses|gain|gains|get|gets|become|becomes|put|exile|exert|exerts|destroy|return|create|creates|search|scry|surveil|surveils|investigate|investigates|mill|mills|sacrifice|deal|deals|add|take|takes|phase|phases|attach|counter|proliferate|switch|look|reveal|reveals|shuffle|shuffles|tap|untap|fight|fights|transform|transforms|convert|converts|flip|flips|discard|discards|connive|connives|explore|explores|goad|goads|regenerate|regenerates|amass|amasses|incubate|incubates|populate|populates|manifest|manifests|cloak|cloaks|bolster|bolsters|monstrosity|support|adapt|adapts|after|there)\b/;

/** Splits a sentence into clauses at ", then " and at " and " before a new verb or subject. */
function splitClauses(text: string, offset: number): Clause[] {
	const out: Clause[] = [];
	const re = /,? then |,? and /g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		const after = text.slice(m.index + m[0].length);
		if (!CLAUSE_START.test(after)) continue;
		// "gain trample and get +X/+X" stays one clause (handled by objectPredicate).
		if (/^gets? /.test(after) && /gains? [a-z ]+$/.test(text.slice(last, m.index))) continue;
		out.push({ text: text.slice(last, m.index), span: { start: offset + last, end: offset + m.index } });
		last = m.index + m[0].length;
	}
	out.push({ text: text.slice(last), span: { start: offset + last, end: offset + text.length } });
	return out;
}

function markTrailingDestroyCantRegen(p: Parser): boolean {
	let marked = false;
	for (let i = p.steps.length - 1; i >= 0 && p.steps[i].verb === 'destroy'; i--) {
		p.steps[i].params = { ...p.steps[i].params, cantBeRegenerated: true };
		marked = true;
	}
	return marked;
}

function tryUnlessClause(p: Parser, text: string, span: Span): boolean {
	const unlessMatch = text.match(/^(.+?)(?:,)?\s+unless\s+(.+)$/i);
	if (!unlessMatch) return false;
	const baseText = unlessMatch[1].trim();
	const tail = unlessMatch[2].trim();
	if (/\bunless\b/i.test(baseText)) return false;
	if (/^(?:it|~) escaped$/i.test(tail)) {
		const normalizedBase = /^sacrifice it$/i.test(baseText) ? 'sacrifice ~' : baseText;
		const mark = p.mark();
		if (!clause(p, { text: normalizedBase, span }, false)) {
			p.rollback(mark);
			return false;
		}
		const added = p.steps.slice(mark.steps);
		if (added.length === 0) {
			p.rollback(mark);
			return false;
		}
		const notEscaped: Condition = { k: 'not', of: { k: 'escaped' } };
		for (const step of added) {
			step.condition = step.condition ? { k: 'and', of: [notEscaped, step.condition] } : notEscaped;
		}
		return true;
	}
	const pm = tail.match(
		/^(you|that player|the player whose turn it is|the player|that opponent|they|target player|target opponent|each opponent|each player|(?:its|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the exiled permanent's|their) (?:controller|owner))\s+(.+)$/i
	);
	if (!pm) return false;
	const costDefs = parseOptionalCostBody(pm[2]);
	if (!costDefs) return false;
	const mark = p.mark();
	if (!clause(p, { text: baseText, span }, false)) {
		p.rollback(mark);
		return false;
	}
	const addedCount = p.steps.length - mark.steps;
	if (addedCount === 0) {
		p.rollback(mark);
		return false;
	}
	const chooserSel = p.resolvePlayerAgainstStep(mark.steps, () => playerPhrase(p, pm[1]));
	const chooser = chooserSel ? singlePlayer(chooserSel) : null;
	if (!chooser) {
		p.rollback(mark);
		return false;
	}
	const added = p.steps.slice(mark.steps);
	if (added.length === 1 && !added[0].optional) {
		added[0].optional = { chooser, cost: costDefs, mode: 'doUnlessPaid' };
		p.lastOptionalStep = mark.steps;
		return true;
	}
	const payIdx = mark.steps;
	p.steps.splice(payIdx, 0, {
		verb: 'payCost',
		subject: { k: 'none' },
		optional: { chooser, cost: costDefs, mode: 'doIfPaid' },
		span
	});
	for (let i = payIdx + 1; i < p.steps.length; i++) {
		const st = p.steps[i];
		if (st.ifPrecedingAccepted !== undefined && st.ifPrecedingAccepted >= payIdx) st.ifPrecedingAccepted += 1;
		if (st.ifPrecedingDeclined !== undefined && st.ifPrecedingDeclined >= payIdx) st.ifPrecedingDeclined += 1;
		if (st.ifPrecedingDeclined === undefined) st.ifPrecedingDeclined = payIdx;
	}
	p.lastOptionalStep = payIdx;
	p.shiftLastObjectFrom(payIdx);
	return true;
}

/** One clause: an imperative, or a subject followed by a predicate. */
function clause(p: Parser, c: Clause, allowUnless = true): ClauseResult {
	const t = c.text.trim();
	if (!t) return false;
	if (allowUnless && /\bunless\b/i.test(t) && tryUnlessClause(p, t, c.span)) return true;
	if (imperative(p, t, c.span)) return true;

	// "It/They can't be regenerated" / "<object> can't be regenerated this turn"
	const cantRegen = t.match(/^(.+?) can't be regenerated(?: this turn)?$/i);
	if (cantRegen) {
		if (/^(?:it|they)$/i.test(cantRegen[1]) && !/this turn$/i.test(t) && markTrailingDestroyCantRegen(p)) {
			return true;
		}
		const obj = objectPhrase(p, cantRegen[1]);
		if (obj && !obj.fromZone) {
			p.push({ verb: 'cantRegenerate', subject: obj.selector, span: c.span }, true);
			return true;
		}
	}

	// CR 502.3 / 611.2b: "<subject> doesn't/don't untap during <controller>'s next untap step(s)"
	// Strictly requires `next` so static/for-as-long-as untap locks are never miscompiled.
	const freezeNextUntap = t.match(
		/^(.+?) (?:doesn't|don't|does not|do not) untap during (?:its controller's|their controller's|their controllers'|that player's|their|your) next untap steps?$/i
	);
	if (freezeNextUntap && !/^(?:for as long as|until|as long as)\b/i.test(freezeNextUntap[1])) {
		const rawSubj = freezeNextUntap[1].trim();
		if (/^they$/i.test(rawSubj)) {
			const ref = p.itRef();
			if (ref) {
				p.push({ verb: 'freezeUntap', subject: refSelector(ref), span: c.span }, true);
				return true;
			}
		} else {
			const snapshot = p.mark();
			const obj = objectPhrase(p, rawSubj);
			const validTarget =
				!obj ||
				obj.selector.k !== 'target' ||
				(p.targets[obj.selector.index]?.kind === 'object' &&
					(p.targets[obj.selector.index]?.filter.zone ?? 'battlefield') === 'battlefield');
			if (obj && !obj.fromZone && validTarget) {
				p.push({ verb: 'freezeUntap', subject: obj.selector, span: c.span }, true);
				return true;
			}
			p.rollback(snapshot);
		}
	}

	if (tryOwnerLibraryMoveClause(p, t, c.span)) return true;

	// Player subjects.
	const ownerMatch = t.match(/^((?:the )?owner of target .+?)\s+((?:shuffles?|reveals?|puts?|draws?|discards?|creates?|gains?|loses?|mills?|scrys?|surveils?|sacrifices?)\b.*)$/i);
	if (ownerMatch) {
		const subject = playerPhrase(p, ownerMatch[1]);
		if (subject && playerPredicate(p, subject, ownerMatch[2], c.span)) return true;
	}
	const ps = t.match(
		/^(you|each opponent|each player|target player|target opponent|its controller|its owner|that player|they|the player whose turn it is|(?:that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the exiled permanent's) (?:controller|owner)) (.+)$/
	);
	if (ps) {
		const subject = playerPhrase(p, ps[1]);
		if (subject && playerPredicate(p, subject, ps[2], c.span)) return true;
	}
	// A continued predicate with the previous player as subject ("... and loses 2 life").
	if (
		p.lastPlayer &&
		/^(?:draws?|loses?|gains?|gets?|becomes?|mills?|creates?|investigates?|surveils?|discards?|goads?|amass(?:es)?|incubates?|populates?|manifests?|cloaks?|bolsters?|reveals?)\b/.test(
			t
		)
	) {
		if (playerPredicate(p, p.lastPlayer, t, c.span)) return true;
	}
	// Object subjects & leading-duration impulse exile clauses ("Until the end of your next turn, you may play ...").
	const leadingImpulse = t.match(
		/^(until end of turn|until (?:the )?end of your next turn|until your next end step|for as long as (?:it remains|they remain|that card remains|those cards remain) exiled), (you|that player|they|its owner) (may (?:play|cast) .+)$/i
	);
	if (leadingImpulse) {
		const impulseDur = parseImpulseDurationPhrase(leadingImpulse[1]);
		const subj = impulseDur ? playerPhrase(p, leadingImpulse[2].toLowerCase()) : null;
		if (impulseDur && subj && parsePlayFromExilePredicate(p, subj, leadingImpulse[3], c.span, impulseDur)) {
			return true;
		}
	}
	const dur = t.match(/^until end of turn, (.+)$/);
	if (dur) {
		if (imperative(p, `${dur[1].trim()} until end of turn`, c.span)) return true;
	}
	const body = dur ? dur[1] : t;
	const words = body.split(' ');
	for (let i = words.length - 1; i >= 1; i--) {
		const subjText = words.slice(0, i).join(' ');
		const vp = words.slice(i).join(' ') + (dur ? ' until end of turn' : '');
		if (!/^(?:gets?|gains?|loses?|phases?|deals|fights?|explores?|connives?|adapts?|becomes?)\b/.test(vp)) continue;
		const snapshot = p.targets.length;
		const subject =
			subjText === 'it' && !p.lastObject && p.context === 'activated' && /^(?:deals|fights?)\b/.test(vp)
				? { selector: { k: 'self' } as Selector, ref: { k: 'self' } as Ref }
				: objectPhrase(p, subjText);
		if (!subject) continue;
		if (objectPredicate(p, subject, vp, c.span)) return true;
		p.targets.length = snapshot;
	}
	const scalePerClause = (
		baseClauseText: string,
		scaleAmount: (a: Amount | undefined) => Amount | null
	): boolean => {
		const mark = p.mark();
		if (clause(p, { text: baseClauseText, span: c.span }) && p.steps.length > mark.steps) {
			let ok = true;
			for (const step of p.steps.slice(mark.steps)) {
				const scaled = scaleAmount(step.amount);
				if (!scaled) {
					ok = false;
					break;
				}
				step.amount = scaled;
				if (step.params?.toughness) {
					const scaledT = scaleAmount(step.params.toughness);
					if (!scaledT) {
						ok = false;
						break;
					}
					step.params = { ...step.params, toughness: scaledT };
				}
			}
			if (ok) return true;
		}
		p.rollback(mark);
	return false;
	};
	const perCmdCast = t.match(
		/^(.+?) for each time you've cast (?:your|a) commander from the command zone this game( until end of turn)?$/i
	);
	if (perCmdCast) {
		const ok = scalePerClause(`${perCmdCast[1]}${perCmdCast[2] ?? ''}`, (a) => {
			if (!a || a.k !== 'const') return null;
			if (a.n === 1) return { k: 'commanderCastCount' };
			if (a.n === 0) return a;
			if (a.n === -1) return { k: 'negate', of: { k: 'commanderCastCount' } };
			return null;
		});
		if (ok) return true;
	}
	const perKicked = t.match(
		/^(.+?) for each time (?:it|~|this spell|this creature|this permanent) was kicked( until end of turn)?$/i
	);
	if (perKicked) {
		const ok = scalePerClause(`${perKicked[1]}${perKicked[2] ?? ''}`, (a) => {
			if (!a || a.k !== 'const') return null;
			if (a.n === 1) return { k: 'kickedCount' };
			if (a.n === 0) return a;
			if (a.n === -1) return { k: 'negate', of: { k: 'kickedCount' } };
			if (a.n > 1) return { k: 'kickedCount', multiplier: a.n };
			return null;
		});
		if (ok) return true;
	}
	const perEnergy = t.match(/^(.+?) for each \{E\} you have( until end of turn)?$/i);
	if (perEnergy) {
		const ok = scalePerClause(`${perEnergy[1]}${perEnergy[2] ?? ''}`, (a) => {
			if (!a || a.k !== 'const') return null;
			if (a.n === 1) return { k: 'energyCount', player: { k: 'you' } };
			if (a.n === 0) return a;
			if (a.n === -1) return { k: 'negate', of: { k: 'energyCount', player: { k: 'you' } } };
			return null;
		});
		if (ok) return true;
	}
	return false;
}

/** Sentence-initial words that are not names or subtypes, so they can be lower-cased. */
const LOWER_START = new Set([
	'a', 'adapt', 'adapts', 'add', 'all', 'amass', 'amasses', 'an', 'another', 'any', 'artifacts', 'at', 'attach', 'become', 'bolster', 'bolsters', 'cloak', 'cloaks', 'connive', 'connives', 'convert', 'converts', 'copy', 'counter', 'create', 'creatures', 'deal', 'destroy', 'discard', 'discards', 'draw',
	'each', 'enchanted', 'end', 'equipped', 'exert', 'exerts', 'exile', 'explore', 'explores', 'fight', 'flip', 'for', 'gain', 'goad', 'goads', 'if', 'incubate', 'incubates', 'investigate', 'it', 'its', 'lands', 'look', 'lose', 'mana', 'manifest', 'manifests', 'mill', 'monstrosity', 'otherwise', 'pay', 'permanents', 'populate', 'populates', 'proliferate', 'put',
	'regenerate', 'regenerates', 'return', 'reveal', 'sacrifice', 'scry', 'search', 'support', 'surveil', 'switch', 'take', 'tap', 'target', 'that', 'the', 'then', 'they', 'those',
	'transform', 'untap', 'until', 'up', 'when', 'you', 'your'
]);

// ---- Sentences ------------------------------------------------------------------------------

const NEXT_END_STEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'each_turn' };
const THAT_TURNS_END_STEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'controller_turn' };
const NEXT_TURNS_UPKEEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'upkeep' }, scope: 'each_turn' };
const END_OF_COMBAT: TriggerDef = { event: 'phaseBegin', filter: { phase: 'end_combat' }, scope: 'each_turn' };

function delayedTrigger(when: string): { trigger: TriggerDef; nextTurn?: boolean } | null {
	if (when === 'the next end step') return { trigger: NEXT_END_STEP };
	if (when === "that turn's end step") return { trigger: THAT_TURNS_END_STEP };
	if (when === "the next turn's upkeep") return { trigger: NEXT_TURNS_UPKEEP, nextTurn: true };
	if (when === 'end of combat' || when === 'the end of combat') return { trigger: END_OF_COMBAT };
	return null;
}

/** One sentence. Returns false if any part of it wasn't understood (no steps are kept then). */
function sentence(p: Parser, text: string, span: Span): boolean {
	let t = text.replace(/[.!]$/, '').trim();
	const t0 = t;
	// Lower-case the first letter so productions don't have to care, unless it's "~".
	if (/^[A-Z][a-z]*\b/.test(t) && LOWER_START.has(t.split(/[\s,']/)[0].toLowerCase())) {
		t = t.charAt(0).toLowerCase() + t.slice(1);
	}
	if (NEUTRAL_SENTENCES.some((re) => re.test(t0))) {
		p.lastOptionalStep = undefined;
		return true;
	}
	if (RESTRICTION_SENTENCES.some((re) => re.test(t0))) {
		p.lastOptionalStep = undefined;
		return true;
	}
	if (p.context === 'activated' && parseActivatedIfConditionSentence(t0)) {
		p.lastOptionalStep = undefined;
		return true;
	}

	const stepsBefore = p.steps.length;
	const targetsBefore = p.targets.length;
	const fail = () => {
		p.steps.length = stepsBefore;
		p.targets.length = targetsBefore;
	return false;
	};

	if (/^you may shuffle$/.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'lookAndReorder') return fail();
		prev.params = { ...prev.params, mayShuffle: true };
		return true;
	}

	if (/^this mana can't be spent to cast (?:a )?nonartifact spells?$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'addMana') return fail();
		prev.params = { ...prev.params, manaRestriction: 'artifactSpellOrNonSpell' };
		return true;
	}

	const ifPerm = t.match(/^if (?:it's|it is) a permanent card, (they|you|that player) puts? it onto the battlefield$/i);
	if (ifPerm) {
		const actorSel = playerPhrase(p, ifPerm[1]);
		const actor = actorSel ? singlePlayer(actorSel) : null;
		p.push(
			{
				verb: 'move',
				subject: { k: 'binding', name: 'chaosRevealed' },
				...(actor && actor.k !== 'you' ? { actor } : {}),
				params: { to: 'battlefield' },
				condition: {
					k: 'matchesFilter',
					target: { k: 'binding', name: 'chaosRevealed' },
					filter: { notTypes: ['Instant', 'Sorcery'] }
				},
				span
			},
			false
		);
		return true;
	}

	const ancScry = t.match(/^when that mana is spent to cast a creature spell that shares a creature type with your commander, scry (\S+)$/i);
	if (ancScry) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'addMana') return fail();
		const amt = count(ancScry[1]) ?? n(1);
		prev.delayed = {
			trigger: {
				event: 'cast',
				filter: {
					object: {
						types: ['Creature'],
						sharesTypeWithCommander: true
					}
				}
			},
			effect: [{ verb: 'scry', subject: { k: 'none' }, amount: amt, span }]
		};
		return true;
	}

	if (
		/^(?:it's|they're|it is|they are) still (?:a |an )?(?:lands?|artifacts?|enchantments?|planeswalkers?)$/i.test(
			t
		)
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'animate') return fail();
		const prevParams = { ...prev.params };
		const typesToAdd = prevParams.setTypes ?? prevParams.addTypes ?? ['Creature'];
		const subtypesToAdd = prevParams.setSubtypes ?? prevParams.addSubtypes;
		delete prevParams.setTypes;
		delete prevParams.setSubtypes;
		prevParams.addTypes = typesToAdd;
		if (subtypesToAdd && subtypesToAdd.length > 0) {
			prevParams.addSubtypes = subtypesToAdd;
		}
		prevParams.keepExistingTypes = true;
		prev.params = prevParams;
		return true;
	}

	if (/^you may choose new targets for (?:the|each|any|any of the) cop(?:y|ies)$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'copySpell') return fail();
		prev.params = { ...prev.params, mayChooseNewTargets: true };
		return true;
	}

	if (
		/^(?:if you cast a spell this way, )?you may spend mana as though it were mana of any color to cast (?:it|them|that spell|those spells)$/i.test(
			t
		)
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'grantPlayFromExile' || !prev.params?.playFromExile) return fail();
		prev.params = {
			...prev.params,
			playFromExile: { ...prev.params.playFromExile, spendManaAsAnyColor: true }
		};
		return true;
	}

	const ifKicked = t.match(
		/^(if (?:(?:it|~) (?:was(?:n't| not)? (?:kicked(?: with its .+? kicker| twice| \S+ times?)?|foretold|blitzed)|is(?:n't| not)? (?:saddled|monstrous)|escaped|(?:didn't|did not) escape)|(?:~|it|he|she|they) (?:was(?:n't| not)?|were(?:n't| not)?|has(?:n't| not)? been|have(?:n't| not)? been) exerted this turn|it's(?: not)? (?:saddled|monstrous)|its blitz cost was(?:n't| not)? paid)), (.+)$/i
	);
	if (ifKicked) {
		const cond = parseCondition(ifKicked[1]);
		if (!cond) return fail();
		let innerText = ifKicked[2].trim();
		// Replacement-style kicker clauses ("instead") override an earlier step and are not additive.
		if (/\binstead\b/i.test(innerText)) return fail();
		innerText = innerText.replace(/^it (?:also )?deals\b/i, '~ deals').replace(/^also\s+/i, '');
		const innerStart = Math.max(span.start, span.end - ifKicked[2].length);
		if (!sentence(p, innerText, { start: innerStart, end: span.end })) return fail();
		for (const step of p.steps.slice(stepsBefore)) {
			step.condition = step.condition ? { k: 'and', of: [cond, step.condition] } : cond;
		}
		for (const target of p.targets.slice(targetsBefore)) {
			target.condition = target.condition ? { k: 'and', of: [cond, target.condition] } : cond;
		}
		return true;
	}

	const ifMonarch = t.match(
		/^(?:then\s+)?(if (?:you(?:'re| are|'re not| aren't| are not) the monarch|an opponent is the monarch|a player is the monarch|there is no monarch)), (.+)$/i
	);
	if (ifMonarch) {
		const cond = parseCondition(ifMonarch[1]);
		if (!cond) return fail();
		const innerText = ifMonarch[2].trim();
		if (/\binstead\b/i.test(innerText)) return fail();
		const innerStart = Math.max(span.start, span.end - ifMonarch[2].length);
		if (!sentence(p, innerText, { start: innerStart, end: span.end })) return fail();
		for (const step of p.steps.slice(stepsBefore)) {
			step.condition = step.condition ? { k: 'and', of: [cond, step.condition] } : cond;
		}
		for (const target of p.targets.slice(targetsBefore)) {
			target.condition = target.condition ? { k: 'and', of: [cond, target.condition] } : cond;
		}
		return true;
	}

	if (/^(?:it|they) can't be regenerated$/i.test(t) && markTrailingDestroyCantRegen(p)) {
		p.lastOptionalStep = undefined;
		return true;
	}

	if (p.pendingCoercive) {
		if (tryCoerciveFollowUp(p, t, span)) {
			return true;
		}
		p.flushIncompleteCoercive();
	}

	const followUp = parseOptionalFollowUp(p, t, span, (innerText, innerStart) =>
		sentence(p, innerText, { start: innerStart, end: span.end })
	);
	if (followUp !== null) return followUp;
	if (p.pendingDig && tryDigFollowUp(p, t)) {
		p.lastOptionalStep = undefined;
		return true;
	}
	if (p.pendingDig) {
		p.pendingDig = undefined;
	}
	if (tryCoerciveStart(p, t, span)) {
		return true;
	}
	if (t === "until your next turn, your life total can't change and you gain protection from everything") {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['lifeTotalCantChange', 'protectionFromEverything'], duration: 'untilYourNextTurn' },
				span
			},
			false
		);
		return true;
	}
	const devotion = t.match(/^if your devotion to (white|blue|black|red|green) is greater than or equal to the number of cards in your library, you win the game$/);
	if (devotion) {
		const color = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[devotion[1] as 'blue'];
		const condition: Condition = {
			k: 'compare',
			left: { k: 'devotion', colors: [color] },
			op: '>=',
			right: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }
		};
		p.push({ verb: 'win', subject: YOU, params: { condition }, span }, false);
		return true;
	}
	if (t === 'if X is greater than or equal to the number of cards in your library, you win the game') {
		if (!p.definedX) return fail();
		const condition: Condition = {
			k: 'compare',
			left: p.definedX,
			op: '>=',
			right: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }
		};
		p.push({ verb: 'win', subject: YOU, params: { condition }, span }, false);
		return true;
	}

	// Delayed effects: "At the beginning of the next end step, exile it." / "Sacrifice it at end of combat."
	const lead = t.match(/^at (?:the beginning of (the next end step|that turn's end step|the next turn's upkeep)|(end of combat|the end of combat)), (.+)$/);
	const trail = t.match(/^(.+) at (?:the beginning of (the next end step|that turn's end step|the next turn's upkeep)|(end of combat|the end of combat))$/);
	if (lead || trail) {
		const when = lead ? (lead[1] ?? lead[2]) : (trail![2] ?? trail![3]);
		const dt = delayedTrigger(when);
		const inner = lead ? lead[3] : trail![1];
		if (!dt) return fail();
		const before = p.steps.length;
		const savedLastObj = p.lastObject;
		if (!clauses(p, inner, span.start)) {
			p.lastObject = savedLastObj;
			return fail();
		}
		const effect = p.steps.splice(before);
		effect.forEach((s) => {
			s.span = span;
			if (s.ifPrecedingAccepted !== undefined && s.ifPrecedingAccepted >= before) {
				s.ifPrecedingAccepted -= before;
			}
			if (s.ifPrecedingDeclined !== undefined && s.ifPrecedingDeclined >= before) {
				s.ifPrecedingDeclined -= before;
			}
		});
		p.push(
			{
				verb: 'delayedTrigger',
				subject: { k: 'none' },
				delayed: { trigger: dt.trigger, ...(dt.nextTurn ? { nextTurn: true } : {}), effect },
				span
			},
			false
		);
		if (!p.steps.slice(stepsBefore).some((s) => stepOptionalChooser(s) !== undefined)) {
			p.lastOptionalStep = undefined;
		}
		return true;
	}

	// X definitions at the end of the sentence.
	const wx = whereX(p, t);
	if (wx.bad) return fail();
	if (!clauses(p, wx.text, span.start)) return fail();
	let resolvedX = wx.x;
	if (!resolvedX && wx.deferredExileCount) {
		if (p.steps.length < stepsBefore + 2) return fail();
		const priorIdx = p.steps.length - 2;
		if (p.steps[priorIdx]?.verb !== 'exile') return fail();
		p.steps[priorIdx].bindAs = `b${priorIdx}`;
		resolvedX = { k: 'resultCount', of: `b${priorIdx}` };
	}
	if (!resolvedX && wx.deferredStat) {
		if (p.steps.length < stepsBefore + 2) return fail();
		const priorIdx = p.steps.length - 2;
		const savedLast = p.lastObject;
		p.lastObject = { ref: { k: 'binding', name: `b${priorIdx}` }, stepIndex: priorIdx };
		resolvedX = equalTo(p, wx.deferredStat) ?? undefined;
		p.lastObject = savedLast;
		if (!resolvedX) return fail();
	}
	if (resolvedX) {
		p.definedX = resolvedX;
		for (const s of p.steps.slice(stepsBefore)) {
			if (s.amount) s.amount = substituteX(s.amount, resolvedX);
			if (s.params?.toughness) s.params.toughness = substituteX(s.params.toughness, resolvedX);
			if (s.params?.setPower) s.params.setPower = substituteX(s.params.setPower, resolvedX);
			if (s.params?.setToughness) s.params.setToughness = substituteX(s.params.setToughness, resolvedX);
			if (s.params?.count) s.params.count = substituteX(s.params.count, resolvedX);
		}
	}
	if (!p.steps.slice(stepsBefore).some((s) => stepOptionalChooser(s) !== undefined)) {
		p.lastOptionalStep = undefined;
	}
	return true;
}

function stepOptionalChooser(step: EffectStep | undefined): PlayerRef | undefined {
	if (!step) return undefined;
	if (step.optional?.chooser) return step.optional.chooser;
	if (step.verb === 'revealAndDiscard') return step.params?.coerciveDiscard?.chooser;
	return undefined;
}

function parseOptionalFollowUp(
	p: Parser,
	text: string,
	span: Span,
	parseInner: (innerText: string, innerStart: number) => boolean
): boolean | null {
	const ifDo = text.match(/^(if|when) (you do|that player does|the player does|they do), (.+)$/i);
	const ifDont = ifDo
		? null
		: text.match(/^(?:if (you don't|that player doesn't|the player doesn't|they don't)|otherwise), (.+)$/i);
	if (!ifDo && !ifDont) return null;

	const optIdx = p.lastOptionalStep;
	const chooser = optIdx !== undefined ? stepOptionalChooser(p.steps[optIdx]) : undefined;
	if (optIdx === undefined || !chooser) return false;

	const isAccept = Boolean(ifDo);
	const isReflexiveWhen = Boolean(ifDo && ifDo[1].toLowerCase() === 'when');
	const who = (ifDo ? ifDo[2] : ifDont![1] ?? 'otherwise').toLowerCase();
	if ((who === 'you do' || who === "you don't") && chooser.k !== 'you') return false;
	if (
		(who === 'that player does' ||
			who === 'the player does' ||
			who === 'they do' ||
			who === "that player doesn't" ||
			who === "the player doesn't" ||
			who === "they don't") &&
		chooser.k === 'you'
	) {
		return false;
	}

	const innerText = (ifDo ? ifDo[3] : ifDont![2]).trim();
	const innerStart = Math.max(span.start, span.end - innerText.length);
	const mark = p.mark();
	if (!parseInner(innerText, innerStart)) {
		p.rollback(mark);
		return false;
	}
	// Reflexive "When you do" triggers that introduce new targets choose targets when triggered (CR 603.12), not on cast.
	if (isReflexiveWhen && p.targets.length > mark.targets) {
		p.rollback(mark);
		return false;
	}
	for (const s of p.steps.slice(mark.steps)) {
		if (s.ifPrecedingAccepted === undefined && s.ifPrecedingDeclined === undefined) {
			if (isAccept) s.ifPrecedingAccepted = optIdx;
			else s.ifPrecedingDeclined = optIdx;
		}
	}
	// Preserve `lastOptionalStep` across "If you do" so a following "If you don't / Otherwise" can still link to it,
	// even after recursive `sentence()` clears `lastOptionalStep` on inner non-optional steps.
	if (isAccept) {
		if (p.lastOptionalStep === undefined) p.lastOptionalStep = optIdx;
	} else if (!p.steps.slice(mark.steps).some((s) => stepOptionalChooser(s) !== undefined)) {
		p.lastOptionalStep = undefined;
	}
	return true;
}

function clauses(p: Parser, text: string, offset: number): boolean {
	const followUp = parseOptionalFollowUp(p, text, { start: offset, end: offset + text.length }, (body, bodyStart) =>
		clauses(p, body, bodyStart)
	);
	if (followUp !== null) return followUp;

	const ifDoSplit = text.match(
		/^(.+?)(?:,\s*(?:and|then)|,?\s+(?:and|then))\s+((?:(?:if|when) (?:you do|that player does|the player does|they do)|if (?:you don't|that player doesn't|the player doesn't|they don't)|otherwise), .+)$/i
	);
	if (ifDoSplit) {
		const mark = p.mark();
		const head = ifDoSplit[1].trim();
		const tail = ifDoSplit[2].trim();
		const tailOffset = offset + text.indexOf(tail);
		if (clauses(p, head, offset) && clauses(p, tail, tailOffset)) return true;
		p.rollback(mark);
		return false;
	}
	// A search clause consumes the rest of the sentence ("..., put it into your hand, then shuffle").
	const search = text.match(/^(.*?)\b((?:its controller may |its owner may |target player may |target opponent may |that player may |you may |they may )?search(?:es)? (?:your|their) library .+)$/);
	if (search) {
		const head = search[1].replace(/,?\s*(?:then|and)?\s*$/, '');
		if (head && !clauses(p, head, offset)) return false;
		const tail = search[2];
		const start = offset + text.indexOf(tail);
		return clause(p, { text: tail, span: { start, end: start + tail.length } });
	}
	// The whole text as one clause first ("look at the top three cards ..., then put them back"),
	// then split at clause boundaries.
	const mark = p.mark();
	if (clause(p, { text, span: { start: offset, end: offset + text.length } })) return true;
	p.rollback(mark);
	const parts = splitClauses(text, offset);
	if (parts.length === 1) return false;
	for (const c of parts) {
		if (p.pendingDig && tryDigFollowUp(p, c.text)) continue;
		if (!clause(p, c)) {
			p.rollback(mark);
			return false;
		}
	}
	return true;
}

type DigKeepSpec = Pick<
	NonNullable<EffectParams['dig']>,
	'keep' | 'upTo' | 'keepAllMatching' | 'keepFilter' | 'keepLabel' | 'keepTo' | 'keepTapped' | 'revealKept'
>;
type DigRestSpec = Pick<NonNullable<EffectParams['dig']>, 'rest' | 'restRandom' | 'restOrder'>;

function parseDigDestination(dest: string): { keepTo: DigKeepSpec['keepTo']; keepTapped?: true } | null {
	const d = dest.trim().toLowerCase();
	if (d === 'into your hand') return { keepTo: 'hand' };
	if (d === 'on top of your library') return { keepTo: 'libraryTop' };
	if (d === 'onto the battlefield tapped') return { keepTo: 'battlefield', keepTapped: true };
	if (d === 'onto the battlefield') return { keepTo: 'battlefield' };
	if (d === 'into your graveyard') return { keepTo: 'graveyard' };
	return null;
}

function parseDigRestDestination(dest: string): DigRestSpec | null {
	const d = dest.trim().toLowerCase();
	if (d === 'on the bottom of your library in a random order') {
		return { rest: 'libraryBottom', restRandom: true };
	}
	if (d === 'on the bottom of your library in any order' || d === 'on the bottom of your library') {
		return { rest: 'libraryBottom', restOrder: 'any' };
	}
	if (d === 'into your graveyard') {
		return { rest: 'graveyard' };
	}
	return null;
}

function parseDigKeepClause(clauseStr: string): DigKeepSpec | null {
	const s = clauseStr.trim();
	const mayPrefix = /^you may\s+/i.test(s);
	const body = s.replace(/^you may\s+/i, '');

	let whatStr: string | undefined;
	let destStr: string | undefined;
	let revealKept = false;

	let m = body.match(
		/^reveal (.+?) (?:from among (?:them|those cards)|of (?:them|those cards)|revealed this way),?\s*(?:and\s+)?put (?:it|them|that card|those cards) (.+)$/i
	);
	if (m) {
		revealKept = true;
		whatStr = m[1].trim();
		destStr = m[2].trim();
	} else {
		m = body.match(/^put (.+?) (?:from among (?:them|those cards)|of (?:them|those cards)|revealed this way) (.+)$/i);
		if (m) {
			whatStr = m[1].trim();
			destStr = m[2].trim();
		}
	}
	if (!whatStr || !destStr) return null;

	const dest = parseDigDestination(destStr);
	if (!dest) return null;

	let upTo = false;
	let keep = 0;
	let keepAllMatching = false;
	let filterStr = whatStr;

	if (/^up to\s+/i.test(filterStr)) {
		upTo = true;
		filterStr = filterStr.replace(/^up to\s+/i, '').trim();
	}

	if (/^any number(?:\s+of\b|$)/i.test(filterStr)) {
		upTo = true;
		keep = 999;
		filterStr = filterStr.replace(/^any number(?:\s+of\b)?/i, '').trim();
	} else if (/^all\b/i.test(filterStr)) {
		keepAllMatching = true;
		keep = 999;
		filterStr = filterStr.replace(/^all\b/i, '').trim();
	} else {
		const wm = filterStr.match(/^(\S+)(?:\s+(.*))?$/);
		if (!wm) return null;
		const lowWord = wm[1].toLowerCase();
		if (lowWord === 'a' || lowWord === 'an') {
			keep = 1;
			if (mayPrefix) upTo = true;
		} else {
			const c = count(lowWord);
			if (!c || c.k !== 'const' || c.n < 0) return null;
			keep = c.n;
			if (mayPrefix && keep === 1) upTo = true;
		}
		filterStr = (wm[2] ?? '').trim();
	}

	filterStr = filterStr.replace(/^of\s+/i, '').trim();
	let keepFilter: ObjectFilter | undefined;
	let keepLabel: string | undefined;
	if (filterStr !== '' && !/^cards?$/i.test(filterStr)) {
		const parsed = parseObjectPhrase(filterStr);
		if (!parsed) return null;
		keepFilter = parsed;
		keepLabel = filterStr.replace(/\s+cards?$/i, '').trim();
	}

	return {
		keep,
		upTo,
		...(keepAllMatching ? { keepAllMatching: true } : {}),
		...(keepFilter ? { keepFilter } : {}),
		...(keepLabel ? { keepLabel } : {}),
		keepTo: dest.keepTo,
		...(dest.keepTapped ? { keepTapped: true } : {}),
		...(revealKept ? { revealKept: true } : {})
	};
}

function commitPendingDig(p: Parser, pd: PendingDigState): void {
	const step = p.steps[pd.stepIndex];
	if (step?.verb === 'dig') {
		step.params = { ...step.params, dig: { ...pd.draft } };
	}
	p.pendingDig = undefined;
}

function tryDigFollowUp(p: Parser, text: string): boolean {
	const pd = p.pendingDig;
	if (!pd) return false;
	const t = text.trim();

	if (/^put one of them into your hand, put one of them on the bottom of your library, and exile one of them$/i.test(t)) {
		pd.draft = {
			...pd.draft,
			keep: 1,
			upTo: false,
			keepTo: 'hand',
			rest: 'libraryBottom',
			partitions: [
				{ count: 1, to: 'hand' },
				{ count: 1, to: 'libraryBottom' },
				{ count: 1, to: 'exile', playableThisTurn: true }
			]
		};
		pd.hasKeep = true;
		pd.hasRest = true;
		commitPendingDig(p, pd);
		return true;
	}

	if (!pd.hasKeep) {
		const combined = t.match(
			/^(.+?)(?:,\s*|\s+)(?:and|then)\s+(?:put\s+)?(?:the rest|the other(?:s| cards)?)\s+(.+)$/i
		);
		if (combined) {
			const keepSpec = parseDigKeepClause(combined[1]);
			const restSpec = parseDigRestDestination(combined[2]);
			if (!keepSpec || !restSpec) return false;
			pd.draft = { ...pd.draft, ...keepSpec, ...restSpec };
			pd.hasKeep = true;
			pd.hasRest = true;
			commitPendingDig(p, pd);
			return true;
		}
		const keepSpec = parseDigKeepClause(t);
		if (!keepSpec) return false;
		pd.draft = { ...pd.draft, ...keepSpec };
		pd.hasKeep = true;
		return true;
	}

	if (!pd.hasRest) {
		const restMatch = t.match(
			/^(?:then\s+)?(?:put\s+)?(?:the rest|the other(?:s| cards)?)\s+(.+)$/i
		);
		if (!restMatch) return false;
		const restSpec = parseDigRestDestination(restMatch[1]);
		if (!restSpec) return false;
		pd.draft = { ...pd.draft, ...restSpec };
		pd.hasRest = true;
		commitPendingDig(p, pd);
		return true;
	}

	return false;
}

function parseCoerciveCardPhrase(phrase: string): { ok: boolean; filter?: ObjectFilter } {
	const trimmed = phrase.trim();
	if (/^card$/i.test(trimmed)) return { ok: true };
	if (!/\bcards?\b/i.test(trimmed)) return { ok: false };
	const parsed = parseObjectPhrase(trimmed);
	if (!parsed) return { ok: false };
	return { ok: true, filter: Object.keys(parsed).length > 0 ? parsed : undefined };
}

function parseCoerciveActionClause(clauseText: string): 'graveyard' | 'exile' | null {
	const m = clauseText
		.trim()
		.match(
			/^(?:if you do,\s*)?(?:(?:that player|the player|that opponent|they) discards? (?:that card|it)|(?:you )?exile (?:that card|it))$/i
		);
	if (!m) return null;
	return /\bexile\b/i.test(clauseText) ? 'exile' : 'graveyard';
}

function commitPendingCoercive(
	p: Parser,
	pc: PendingCoerciveState,
	destination: 'graveyard' | 'exile',
	endSpan: Span
): void {
	const step = p.steps[pc.stepIndex];
	if (step?.verb === 'revealAndDiscard') {
		step.params = {
			...step.params,
			coerciveDiscard: {
				chooser: { k: 'you' },
				...(pc.filter ? { filter: pc.filter } : {}),
				...(pc.optionalChoice ? { optionalChoice: true } : {}),
				destination
			}
		};
		step.span = { start: pc.spans[0]?.start ?? step.span.start, end: endSpan.end };
		p.setLastObject(pc.stepIndex);
		p.lastOptionalStep = pc.stepIndex;
	}
	p.pendingCoercive = undefined;
}

function tryCoerciveFollowUp(p: Parser, text: string, span: Span): boolean {
	const pc = p.pendingCoercive;
	if (!pc) return false;
	const t = text.trim();

	if (pc.phase === 'awaitChoose') {
		const combined = t.match(
			/^you (may )?choose (?:a|an) (.+?) from it(?:,?\s+and\s+((?:if you do,\s*)?(?:(?:that player|the player|that opponent|they) discards? (?:that card|it)|(?:you )?exile (?:that card|it))))?$/i
		);
		if (!combined) return false;
		const parsed = parseCoerciveCardPhrase(combined[2]);
		if (!parsed.ok) return false;
		pc.optionalChoice = Boolean(combined[1]);
		pc.filter = parsed.filter;
		pc.spans.push(span);
		if (combined[3]) {
			const dest = parseCoerciveActionClause(combined[3]);
			if (!dest) return false;
			commitPendingCoercive(p, pc, dest, span);
			return true;
		}
		pc.phase = 'awaitAction';
		return true;
	}

	if (pc.phase === 'awaitAction') {
		const dest = parseCoerciveActionClause(t);
		if (!dest) return false;
		pc.spans.push(span);
		commitPendingCoercive(p, pc, dest, span);
		return true;
	}

	return false;
}

function tryCoerciveStart(p: Parser, text: string, span: Span): boolean {
	const m = text
		.trim()
		.match(
			/^(.+?) reveals? their hand(?:,?\s+(?:and\s+)?you (may )?choose (?:a|an) (.+?) from it(?:,?\s+and\s+((?:if you do,\s*)?(?:(?:that player|the player|that opponent|they) discards? (?:that card|it)|(?:you )?exile (?:that card|it))))?)?$/i
		);
	if (!m) return false;
	const mark = p.mark();
	const sel = playerPhrase(p, m[1].trim());
	const ref = sel ? singlePlayer(sel) : null;
	if (!sel || !ref || ref.k === 'you') {
		p.rollback(mark);
		return false;
	}

	let optionalChoice: boolean | undefined;
	let filter: ObjectFilter | undefined;
	let phase: PendingCoerciveState['phase'] = 'awaitChoose';
	if (m[3] !== undefined) {
		const parsed = parseCoerciveCardPhrase(m[3]);
		if (!parsed.ok) {
			p.rollback(mark);
			return false;
		}
		optionalChoice = Boolean(m[2]);
		filter = parsed.filter;
		phase = 'awaitAction';
	}

	const stepIndex = p.push({ verb: 'revealAndDiscard', subject: sel, span }, false);
	p.lastPlayer = sel;
	p.lastOptionalStep = undefined;
	const pc: PendingCoerciveState = {
		stepIndex,
		phase,
		...(optionalChoice ? { optionalChoice: true } : {}),
		...(filter ? { filter } : {}),
		spans: [span]
	};
	if (m[4] !== undefined) {
		const dest = parseCoerciveActionClause(m[4]);
		if (!dest) {
			p.rollback(mark);
			return false;
		}
		commitPendingCoercive(p, pc, dest, span);
		return true;
	}
	p.pendingCoercive = pc;
	return true;
}

// ---- Entry points ---------------------------------------------------------------------------

/**
 * Parses effect text (one or more sentences of normalised text). `offset` is the position of `text`
 * in the face's normalised text, so spans line up with the rest of the IR.
 */
export function parseEffects(
	text: string,
	offset = 0,
	context: EffectContext = 'spell',
	trigger?: TriggerDef
): EffectParse {
	const p = new Parser(context, trigger);
	for (const s of splitSentences(text, offset)) {
		if (!sentence(p, s.text, s.span)) {
			p.unparsed.push(s.span);
			p.lastOptionalStep = undefined;
		}
	}
	p.flushIncompleteCoercive();
	return { steps: p.steps, targets: p.targets, unparsed: p.unparsed };
}

/**
 * Modal header + bullet lines:
 * - "Choose one —", "Choose two —", "Choose three —", "Choose one or both —",
 *   "Choose one or more —", "Choose any number —", "Choose up to <N|word> —"
 * - optional "that hasn't been chosen this turn"
 * - optional "You may choose the same mode more than once." (before or after em-dash)
 */
export function parseModal(
	header: string,
	bullets: Array<{ text: string; start: number; end: number }>,
	context: EffectContext = 'spell',
	headerStart?: number,
	trigger?: TriggerDef
): EffectParse {
	let rest = header.trim();
	let allowRepeat = false;
	const repeatRe = /\s*(?:\.|—)?\s*you may choose the same mode more than once\.?\s*/i;
	if (repeatRe.test(rest)) {
		allowRepeat = true;
		rest = rest.replace(repeatRe, ' ').trim();
	}
	let conditionalChooseAll: Condition | undefined;
	const chooseBothRe = /\s*(?:\.|—)?\s*if you control a commander as you cast (?:this spell|~), you may choose both instead\.?\s*/i;
	if (chooseBothRe.test(rest)) {
		conditionalChooseAll = { k: 'controlCommander' };
		rest = rest.replace(chooseBothRe, ' ').trim();
	}
	rest = rest.replace(/[—.]+$/g, '').trim();

	let oncePerTurnUnique = false;
	const onceTurnRe = /\s+that hasn['’]t been chosen this turn$/i;
	if (onceTurnRe.test(rest)) {
		oncePerTurnUnique = true;
		rest = rest.replace(onceTurnRe, '').trim();
	}

	const lower = rest.toLowerCase();
	let min = 1;
	let max = 1;
	let upTo = false;
	let matched = true;
	const bulletCount = bullets.length;

	if (lower === 'choose one') {
		min = 1;
		max = 1;
	} else if (lower === 'choose one or both') {
		min = 1;
		max = 2;
	} else if (lower === 'choose one or more') {
		min = 1;
		max = bulletCount;
	} else if (lower === 'choose any number') {
		min = 0;
		max = bulletCount;
	} else {
		const upToMatch = lower.match(/^choose up to (\d+|[a-z]+)$/);
		const exactMatch = lower.match(/^choose (\d+|[a-z]+)$/);
		if (upToMatch) {
			const val = count(upToMatch[1]);
			if (val && val.k === 'const' && val.n >= 1) {
				min = 0;
				max = val.n;
				upTo = true;
			} else {
				matched = false;
			}
		} else if (exactMatch) {
			const val = count(exactMatch[1]);
			if (val && val.k === 'const' && val.n >= 1) {
				min = val.n;
				max = val.n;
			} else {
				matched = false;
			}
		} else {
			matched = false;
		}
	}

	if (!allowRepeat && bulletCount > 0 && max > bulletCount) {
		if (upTo) {
			max = bulletCount;
		} else {
			matched = false;
		}
	}

	const unparsed: Span[] = [];
	const modes: ModalDef['modes'] = [];
	for (const b of bullets) {
		let body = b.text.replace(/^•\s*/, '');
		let start = b.start + (b.text.length - body.length);
		const flavor = body.match(/^([A-Z][A-Za-z0-9'’ !?-]*?) — (?=[A-Z{~])/);
		if (flavor) {
			body = body.slice(flavor[0].length);
			start += flavor[0].length;
		}
		const parse = parseEffects(body, start, context, trigger);
		unparsed.push(...parse.unparsed);
		modes.push({ targets: parse.targets, effect: parse.steps, span: { start: b.start, end: b.end } });
	}
	if (!matched || bullets.length === 0 || max < min) {
		const fallbackStart = headerStart ?? bullets[0]?.start ?? 0;
		const fallbackEnd = bullets[bullets.length - 1]?.end ?? fallbackStart + header.length;
		unparsed.push({ start: fallbackStart, end: fallbackEnd });
	}
	const modal: ModalDef = {
		min,
		max,
		...(allowRepeat ? { allowRepeat: true } : {}),
		...(oncePerTurnUnique ? { oncePerTurnUnique: true } : {}),
		...(upTo ? { upTo: true } : {}),
		...(conditionalChooseAll ? { conditionalChooseAll } : {}),
		modes
	};
	return { steps: [], targets: [], modal, unparsed };
}

/** Lines of an instant or sorcery that aren't part of its effect. */
function isNonEffectLine(body: string): boolean {
	// Implemented/handled spell keyword lines ("Buyback {2}", "Overload {6}{U}", "Suspend 4—{U}", "Flash", "Convoke", "Delve", "Storm") have no period.
	if (!/[.!]$/.test(body) && /^(?:overload|suspend|flash|buyback|convoke|delve|storm)\b/i.test(body.trim())) return true;
	return false;
}

/**
 * The spell ability of an instant or sorcery: every line except keyword lines, additional costs,
 * cost reductions and timing restrictions, parsed as one effect. `include` limits it to some lines
 * (the compiler passes the lines that aren't keywords, triggers or activated abilities).
 */
export function parseSpellFace(norm: NormalizedFace, include: (line: NormalizedLine) => boolean = () => true): EffectParse {
	const steps: EffectStep[] = [];
	const targets: TargetSpec[] = [];
	const unparsed: Span[] = [];
	let modal: ModalDef | undefined;
	const effectSentences: Array<{ text: string; span: Span }> = [];
	const lines = norm.lines.filter(include);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (
			/^choose\b/i.test(line.text) &&
			(lines[i + 1]?.text.startsWith('•') || /—$/i.test(line.text))
		) {
			const bullets: Array<{ text: string; start: number; end: number }> = [];
			while (lines[i + 1]?.text.startsWith('•')) {
				const b = lines[++i];
				bullets.push({ text: b.text, start: b.span.start, end: b.span.end });
			}
			const m = parseModal(line.text, bullets, 'spell', line.span.start);
			modal = m.modal;
			unparsed.push(...m.unparsed);
			continue;
		}
		if (isNonEffectLine(line.body)) continue;
		if (
			/^(?:when|whenever|at the beginning of (?:your|each|the)|at (?:the )?end of combat)\b/i.test(line.body) &&
			!/^at (?:the beginning of (?:the next|that turn's)|(?:the )?end of combat)/i.test(line.body)
		) {
			// A triggered ability on an instant/sorcery (rare); not part of the spell's effect.
			unparsed.push(line.span);
			continue;
		}
		for (const s of line.sentences) {
			if (parseAdditionalCostSentence(s.text)) continue;
			effectSentences.push(s);
		}
	}

	// Parse all effect sentences with one parser so "it" can refer across lines.
	const p = new Parser('spell');
	for (const s of effectSentences) {
		if (!sentence(p, s.text, s.span)) {
			p.unparsed.push(s.span);
			p.lastOptionalStep = undefined;
		}
	}
	p.flushIncompleteCoercive();
	steps.push(...p.steps);
	targets.push(...p.targets);
	unparsed.push(...p.unparsed);
	if (!modal && steps.length === 0 && unparsed.length === 0) {
		unparsed.push({ start: 0, end: norm.text.length });
	}
	return { steps, targets, modal, unparsed };
}

export function parseSpellText(name: string, rulesText: string): EffectParse {
	return parseSpellFace(normalizeFace(name, rulesText));
}

/** Parses the effect part of an activated ability ("Draw a card.", raw text with the card's name). */
export function parseAbilityEffectText(name: string, effectText: string): EffectParse {
	const text = replaceSelfReferences(stripReminderText(effectText), name);
	return parseEffects(text, 0, 'activated');
}

// ---- Runtime lookup (cached) ----------------------------------------------------------------

const STACK_CACHE = new Map<string, EffectParse>();
const MANA_STEPS_CACHE = new Map<string, EffectStep[]>();

/**
 * Extracts best-effort `TargetSpec[]` from an unparsed spell or ability text so humans still get
 * the target picker before manual resolution (CR 601.2c) when the effect sentence isn't automated.
 */
export function extractUnparsedTargets(text: string): TargetSpec[] {
	const low = text.toLowerCase();
	if (/\bany target\b/.test(low)) {
		return [
			{
				kind: 'objectOrPlayer',
				filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
				player: { relation: 'any' },
				min: 1,
				max: 1
			}
		];
	}
	const m = low.match(
		/\b(?:(up to) )?(?:(one|two|three|four|five|six|\d+) )?target (?:(one|two|three|four|five|six|\d+) )?([^.,;\n]+)/
	);
	if (!m) return [];
	const countWord = m[2] ?? m[3];
	const c = countWord ? count(countWord) : n(1);
	const countNum = c && c.k === 'const' ? c.n : 1;
	const words = m[4].trim().split(/\s+/);
	for (let len = Math.min(words.length, 8); len >= 1; len--) {
		const spec = targetPhrase(words.slice(0, len).join(' '));
		if (spec) {
			const { sameOwner, ...restSpec } = spec;
			return [
				{
					...restSpec,
					min: m[1] ? 0 : countNum,
					max: countNum,
					...(sameOwner && countNum > 1 ? { sameOwner: true } : {})
				}
			];
		}
	}
	return [];
}

const SUPPORTED_MULTIFACE_LAYOUTS = new Set(['split', 'modal_dfc', 'adventure']);

/**
 * The compiled effect of a resolving spell or activated ability. Lives in the compiler because it
 * reads the stack item's rules text; the runtime only sees the result. Cached per text.
 */
export function compiledStackItemEffects(item: StackItem): EffectParse | null {
	if (item.kind !== 'spell' && item.kind !== 'activated') return null;
	const card: ScryfallCard = item.card;
	const faceIndex = item.faceIndex ?? 0;
	const layout = card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	const useFaces = Boolean(card.faces && card.faces.length >= 2 && SUPPORTED_MULTIFACE_LAYOUTS.has(layout));
	if (!useFaces && (card.backFace || card.oracleText.includes('\n//\n'))) return null;
	const face = useFaces ? card.faces![faceIndex] : undefined;
	if (useFaces && !face) return null;
	const name = face ? face.name : card.name;
	const typeLine = face ? face.typeLine : card.typeLine;
	if (item.kind === 'spell' && item.fused) return null;
	const text = item.kind === 'spell' ? (face ? face.oracleText : card.oracleText) : item.oracleText;
	if (item.kind === 'spell' && !/\b(?:Instant|Sorcery)\b/.test(typeLine)) return null;
	const key = `${item.kind}:${faceIndex}:${hashText(name)}:${hashText(text)}`;
	const cached = STACK_CACHE.get(key);
	if (cached) return cached;
	const out = item.kind === 'spell' ? parseSpellText(name, text) : parseAbilityEffectText(name, text);
	STACK_CACHE.set(key, out);
	return out;
}

/**
 * Compiled `addMana` steps of a card's activated abilities, for CR 106.7 ("any color that a land
 * an opponent controls could produce"). Lives in the compiler so the runtime never reads rules text.
 */
export function compiledCardManaSteps(card: ScryfallCard): EffectStep[] {
	const layout = card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	const useFaces = Boolean(card.faces && card.faces.length >= 2 && SUPPORTED_MULTIFACE_LAYOUTS.has(layout));
	if (!useFaces && (card.backFace || card.oracleText.includes('\n//\n'))) return [];
	const key = `${hashText(card.name)}:${useFaces ? card.faces!.map((f) => hashText(f.oracleText)).join(':') : hashText(card.oracleText)}`;
	const cached = MANA_STEPS_CACHE.get(key);
	if (cached) return cached;
	const facesToScan = useFaces ? card.faces! : [{ name: card.name, oracleText: card.oracleText }];
	const out: EffectStep[] = [];
	for (const face of facesToScan) {
		const norm = normalizeFace(face.name, face.oracleText);
		for (const line of norm.lines) {
			const quote = line.body.search(/["“]/);
			const colon = line.body.indexOf(':');
			if (colon <= 0 || (quote >= 0 && quote < colon) || /^(?:when|whenever|at|choose)\b/i.test(line.body)) continue;
			const parse = parseEffects(line.body.slice(colon + 1).trim(), 0, 'activated');
			for (const s of parse.steps) if (s.verb === 'addMana') out.push(s);
		}
	}
	MANA_STEPS_CACHE.set(key, out);
	return out;
}
