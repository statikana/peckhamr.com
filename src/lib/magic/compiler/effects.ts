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
	AbilityDef,
	Amount,
	Condition,
	CopyModificationSpec,
	CostDef,
	DamagePreventionSpec,
	DieRollBranch,
	Duration,
	EffectParams,
	EffectStep,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	Ref,
	ReflexiveTriggerSpec,
	SearchSpec,
	Selector,
	Span,
	TargetSpec,
	TimedCombatRestrictionSpec,
	TokenSpec,
	TriggerDef,
	Verb
} from '../ir.ts';
import { GRANTABLE_KEYWORDS } from '../keywords.ts';
import type {
	CounterType,
	LibrarySearchSpec,
	ManaColor,
	ManaSpendingRestrictionSpec,
	PlainManaObjectFilter,
	ScryfallCard,
	ScryfallCardFace,
	StackItem,
	ZoneType
} from '../types.ts';
import { buildTokenSpec, parseLibrarySearchSpec, PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import { compileSingleFace } from './card.ts';
import { COUNTERS, parseAdditionalCostSentence, parseCost, parseObjectPhrase, singularSubtype } from './costs.ts';
import { parseExtendedObjectPhrase, parseP13Amount, tryParseP13Sentence } from './effectsWave5.ts';
import { staticallyInterpretable } from './interpretable.ts';
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
	...COUNTERS,
	'−1/−1': '-1/-1'
};

/** Sentences that carry no effect of their own. */
const NEUTRAL_SENTENCES: RegExp[] = [
	/^then shuffle\.?$/i,
	/^if you search your library this way, shuffle\.?$/i,
	/^then if you searched your library this way, shuffle\.?$/i,
	/^you may play the exiled cards? this turn\.?$/i
];

// --- Track P10: Quote helpers & compiled quoted ability helper ---
function isInsideQuotes(text: string, pos: number): boolean {
	let inQuote = false;
	for (let i = 0; i < pos && i < text.length; i++) {
		const ch = text[i];
		if (ch === '“') inQuote = true;
		else if (ch === '”') inQuote = false;
		else if (ch === '"') inQuote = !inQuote;
	}
	return inQuote;
}

const QUOTED_ABILITY_CACHE = new Map<string, AbilityDef[]>();
const UNSUPPORTED_DIGITAL_RE = /\b(?:perpetually|conjure|seek|draft a card|spellbook|boon|specialize|intensity)\b/i;

export function compileQuotedAbilityString(abilityText: string, cardName = 'Permanent'): AbilityDef[] {
	const trimmed = abilityText.trim().replace(/^[“"]|[”"]$/g, '').trim();
	if (!trimmed || UNSUPPORTED_DIGITAL_RE.test(trimmed)) return [];
	const cacheKey = `${cardName}::${trimmed}`;
	const cached = QUOTED_ABILITY_CACHE.get(cacheKey);
	if (cached) return cached;

	const expanded = trimmed.replace(/~/g, cardName);
	const synthFace: ScryfallCardFace = {
		name: cardName,
		manaCost: '',
		typeLine: 'Creature',
		oracleText: expanded,
		colors: [],
		imageUrl: ''
	};
	const faceDef = compileSingleFace(synthFace);
	const valid =
		faceDef.abilities.length > 0 &&
		faceDef.abilities.every(
			(ab) =>
				ab.kind !== 'unsupported' &&
				ab.kind !== 'spell' &&
				((ab.kind !== 'activated' && ab.kind !== 'triggered') ||
					staticallyInterpretable({
						steps: ab.effect,
						targets: ab.targets,
						modal: ab.modal,
						unparsed: []
					}))
		);
	const out = valid ? faceDef.abilities : [];
	QUOTED_ABILITY_CACHE.set(cacheKey, out);
	return out;
}

function isSupportedEotQuotedAbility(abilityText: string): boolean {
	const defs = compileQuotedAbilityString(abilityText, 'Permanent');
	return (
		defs.length > 0 &&
		defs.every((d) => d.kind === 'activated' || d.kind === 'triggered' || d.kind === 'keyword')
	);
}

function isSupportedTokenQuotedAbility(abilityText: string): boolean {
	const defs = compileQuotedAbilityString(abilityText, 'Token');
	return defs.length > 0;
}

function isSupportedEmblemQuotedAbility(abilityText: string): boolean {
	const defs = compileQuotedAbilityString(abilityText, 'Emblem');
	return (
		defs.length > 0 &&
		defs.every(
			(d) =>
				d.kind === 'triggered' ||
				(d.kind === 'static' &&
					!(d.static.k === 'continuous' && d.static.affected === 'self'))
		)
	);
}
// --- End Track P10 ---

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
	lookOnly?: boolean;
	draft: NonNullable<EffectParams['dig']>;
}

interface PendingCoerciveState {
	stepIndex: number;
	phase: 'awaitChoose' | 'awaitAction';
	lookOnly?: boolean;
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
	/** Most recent `flipCoin` step index for multi-sentence "If you win/lose the flip, ...". */
	lastCoinFlipStep?: number;

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
		lastCoinFlipStep?: number;
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
			lastCoinFlipStep: this.lastCoinFlipStep,
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
		this.lastCoinFlipStep = m.lastCoinFlipStep;
		this.steps.forEach((s, i) => {
			if (m.binds[i] === undefined) delete s.bindAs;
			else s.bindAs = m.binds[i];
		});
	}

	flushPendingDig(): void {
		const pd = this.pendingDig;
		if (!pd) return;
		this.pendingDig = undefined;
		if (!pd.hasKeep && !pd.hasRest && !pd.draft.untilFilter) {
			const step = this.steps[pd.stepIndex];
			if (step?.verb === 'dig' && step.amount?.k === 'const' && step.amount.n === 1) {
				step.verb = 'reveal';
				step.subject = { k: 'libraryTop' };
				delete step.amount;
				if (pd.lookOnly) {
					step.params = { ...step.params, lookOnly: true };
				}
				this.setLastObject(pd.stepIndex);
			}
		}
	}

	flushIncompleteCoercive(): void {
		if (!this.pendingCoercive) return;
		const pc = this.pendingCoercive;
		if (pc.phase === 'awaitChoose') {
			const step = this.steps[pc.stepIndex];
			const ref = step ? singlePlayer(step.subject) : null;
			if (step?.verb === 'revealAndDiscard' && ref) {
				step.verb = 'reveal';
				step.subject = { k: 'all', filter: { zone: 'hand', controllerRef: ref } };
				if (pc.lookOnly) {
					step.params = { ...step.params, lookOnly: true };
				}
				this.pendingCoercive = undefined;
				return;
			}
		}
		for (const sp of pc.spans) {
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

const IT_WORDS = /^(?:it|them|they|that creature|that permanent|that creature or planeswalker|that permanent or player|that target|those targets|that land|that card|that spell|that ability|that artifact|that enchantment|that planeswalker|that token|those tokens|the token|the tokens|the creature|the creatures|the land|the card|the spell|the ability|the sacrificed creature|the sacrificed permanent|the sacrificed artifact|the discarded card|the exiled card|the detained permanent|the detained creature|the suspected creature|the discovered card|those cards|those creatures|those permanents|the amassed army|the army you amassed|the chosen creature|the chosen permanent|the chosen card|the manifested creature|the cloaked creature)$/i;

/** Controller qualifiers at the end of an object phrase. */
function splitController(phrase: string): { phrase: string; controller?: ObjectFilter['controller'] } {
	const m = phrase.match(/^(.+?) (you control|you don't control|an opponent controls|your opponents control|opponents control)$/);
	if (!m) return { phrase };
	return { phrase: m[1], controller: m[2] === 'you control' ? 'you' : 'opponent' };
}

/** "creature", "nonland permanent", "creature or enchantment", "creature card", "instant or sorcery spell". */
function objectFilter(phrase: string): ObjectFilter | null {
	let p = phrase.trim();
	let suspected: boolean | undefined;
	if (/^suspected\s+/i.test(p)) {
		suspected = true;
		p = p.replace(/^suspected\s+/i, '').trim();
	} else if (/^unsuspected\s+/i.test(p)) {
		suspected = false;
		p = p.replace(/^unsuspected\s+/i, '').trim();
	}
	const withSuspect = (f: ObjectFilter | null): ObjectFilter | null =>
		f ? (suspected !== undefined ? { ...f, suspected } : f) : null;
	if (/^(?:permanents?|cards?)$/i.test(p)) return withSuspect({});
	if (/^permanent cards?$/i.test(p)) return withSuspect({ notTypes: ['Instant', 'Sorcery'] });
	// --- Track P10 ---
	const namedCard = p.match(/^cards? named (.+)$/i);
	if (namedCard && namedCard[1].trim()) return withSuspect({ named: namedCard[1].trim() });
	// --- End Track P10 ---
	const direct = parseObjectPhrase(p);
	if (direct) return withSuspect(direct);
	if (/\band\/or\b/i.test(p)) {
		const orForm = parseObjectPhrase(p.replace(/,?\s+and\/or\s+/gi, ' or '));
		if (orForm) return withSuspect(orForm);
	}
	if (/^instant and sorcery cards?$/i.test(p)) {
		return withSuspect({ types: ['Instant', 'Sorcery'] });
	}
	const ext = parseExtendedObjectPhrase(p);
	if (ext) return withSuspect(ext);
	return null;
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

	let wasNotCast = false;
	const notCastMatch = phrase.match(/^(.+?) that wasn't cast$/i);
	if (notCastMatch) {
		wasNotCast = true;
		phrase = notCastMatch[1].trim();
	}

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
	// --- Track P10: Extract "from a <filter> source" before `splitController` so "ability you control from a colorless source" parses cleanly ---
	let abilitySourceFilter: ObjectFilter | undefined;
	const rawFromSrc = phrase.match(/^(.+?) from (?:a|an) (.+?) source$/i);
	if (rawFromSrc && /\babilit(?:y|ies)\b/i.test(rawFromSrc[1])) {
		const rawSrc = rawFromSrc[2].trim();
		const parsedSrc = objectFilter(rawSrc) ?? objectFilter(`${rawSrc} card`);
		if (!parsedSrc) return null;
		abilitySourceFilter = parsedSrc;
		phrase = rawFromSrc[1].trim();
	}
	// --- End Track P10 ---
	const ctl = splitController(phrase);
	phrase = ctl.phrase;
	if (zone === 'battlefield') {
		const withCtl = (base: ObjectFilter): ObjectFilter => ({
			...base,
			...(ctl.controller ? { controller: ctl.controller } : {}),
			...(wasNotCast ? { wasNotCast: true } : {}),
			...(abilitySourceFilter ? { abilitySourceFilter } : {})
		});
		if (/^(?:activated or triggered abilit(?:y|ies)|abilit(?:y|ies))$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'ability' }) };
		}
		if (/^activated abilit(?:y|ies)$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'activatedAbility' }) };
		}
		if (/^triggered abilit(?:y|ies)$/.test(phrase)) {
			return { kind: 'object', filter: withCtl({ zone: 'stack', stackKind: 'triggeredAbility' }) };
		}
		if (abilitySourceFilter) return null;
		if (
			/^(?:spells? or abilit(?:y|ies)|spells?, activated abilit(?:y|ies), or triggered abilit(?:y|ies)|instant or sorcery spells?, activated abilit(?:y|ies), or triggered abilit(?:y|ies))$/.test(
				phrase
			)
		) {
			const onlyInstSorc = /^instant or sorcery/i.test(phrase);
			return {
				kind: 'object',
				filter: withCtl({
					zone: 'stack',
					stackKind: 'spellOrAbility',
					...(onlyInstSorc ? { types: ['Instant', 'Sorcery'] } : {})
				})
			};
		}
		const spell = phrase.match(/^(?:(.+) )?spells?$/);
		if (spell) {
			const filter = spell[1] ? objectFilter(`${spell[1]} card`) : {};
			if (!filter) return null;
			return { kind: 'object', filter: withCtl({ ...filter, zone: 'stack' }) };
		}
	}
	if (wasNotCast) return null;
	if (/^(?:creatures? (?:or|and\/or) players?|players? (?:or|and\/or) creatures?)$/.test(phrase) && !ctl.controller) {
		return { kind: 'objectOrPlayer', filter: { zone: 'battlefield', types: ['Creature'] }, player: { relation: 'any' } };
	}
	if (/^(?:players? (?:or|and\/or) planeswalkers?|planeswalkers? (?:or|and\/or) players?)$/.test(phrase) && !ctl.controller) {
		return {
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Planeswalker'] },
			player: { relation: 'any' }
		};
	}
	if (/^(?:creatures? (?:or|and\/or) planeswalkers?|planeswalkers? (?:or|and\/or) creatures?)$/.test(phrase)) {
		const out: ObjectFilter = { zone: 'battlefield', types: ['Creature', 'Planeswalker'] };
		if (ctl.controller) out.controller = ctl.controller;
		return { kind: 'object', filter: out };
	}
	if (/^creatures?,? planeswalkers?,? (?:or|and\/or) players?$/.test(phrase) && !ctl.controller) {
		return {
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker'] },
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
	if (resolvedZone === 'graveyard' && !/\bcards?\b/.test(phrase)) return null;
	if (resolvedZone === 'battlefield' && /\bcards?$/.test(phrase)) return null;
	const out: ObjectFilter = { ...filter, zone: resolvedZone };
	if (ctl.controller) out.controller = ctl.controller;
	if (owner) out.owner = owner;
	return { kind: 'object', filter: out, ...(sameOwner ? { sameOwner: true } : {}) };
}

function parseAnyTargetQuantifier(text: string): { min: number; max: number } | null {
	if (text === 'any number of targets') return { min: 0, max: 99 };
	if (text === 'one or two targets') return { min: 1, max: 2 };
	if (text === 'one, two, or three targets') return { min: 1, max: 3 };
	if (text === 'one, two, three, or four targets') return { min: 1, max: 4 };
	if (text === 'one, two, three, four, or five targets') return { min: 1, max: 5 };
	const upTo = text.match(/^up to (\S+) targets?$/);
	if (upTo) {
		const c = count(upTo[1]);
		if (c && c.k === 'const' && c.n >= 1) return { min: 0, max: c.n };
	}
	const exact = text.match(/^(\S+) targets$/);
	if (exact && exact[1] !== 'a' && exact[1] !== 'an') {
		const c = count(exact[1]);
		if (c && c.k === 'const' && c.n >= 1) return { min: c.n, max: c.n };
	}
	return null;
}

function parseTypedMultiTargetQuantifier(text: string): { min: number; max: number; rest: string } | null {
	let m = text.match(/^any number of target (.+)$/);
	if (m) return { min: 0, max: 99, rest: m[1] };
	m = text.match(/^(?:one or two target|target one or two) (.+)$/);
	if (m) return { min: 1, max: 2, rest: m[1] };
	m = text.match(/^(?:one, two, or three target|target one, two, or three) (.+)$/);
	if (m) return { min: 1, max: 3, rest: m[1] };
	m = text.match(/^(?:one, two, three, or four target|target one, two, three, or four) (.+)$/);
	if (m) return { min: 1, max: 4, rest: m[1] };
	m = text.match(/^(?:one, two, three, four, or five target|target one, two, three, four, or five) (.+)$/);
	if (m) return { min: 1, max: 5, rest: m[1] };
	return null;
}

function parseDividedTargets(
	p: Parser,
	amongText: string,
	divideTotal: Amount,
	requireObjectOnly = false
): Selector | null {
	if (divideTotal.k === 'resultCount' || divideTotal.k === 'eventAmount') return null;
	const snapshot = p.targets.length;
	const obj = objectPhrase(p, amongText.trim());
	if (!obj || obj.selector.k !== 'target') {
		p.targets.length = snapshot;
		return null;
	}
	const spec = p.targets[obj.selector.index];
	if (!spec || (spec.filter.zone && spec.filter.zone !== 'battlefield')) {
		p.targets.length = snapshot;
		return null;
	}
	if (requireObjectOnly && spec.kind !== 'object') {
		p.targets.length = snapshot;
		return null;
	}
	spec.divideTotal = divideTotal;
	if (obj.ref) p.setLastTarget(obj.ref);
	return obj.selector;
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
		if (/^they$/i.test(t) && !p.lastObject) return null;
		if (!p.lastObject && p.context === 'triggered' && p.trigger?.filter.targetsSelf) {
			const heroRef: Ref = /^(?:that|the) spell$/i.test(t) ? { k: 'eventObject' } : { k: 'self' };
			return { selector: refSelector(heroRef), ref: heroRef };
		}
		const ref = p.itRef();
		return ref ? { selector: refSelector(ref), ref, plural: /^(?:they|them|those\b|the tokens\b|the creatures\b)/i.test(t) } : null;
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
	const multiAny = parseAnyTargetQuantifier(t);
	if (multiAny) {
		const index = p.addTarget({
			kind: 'objectOrPlayer',
			filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
			player: { relation: 'any' },
			min: multiAny.min,
			max: multiAny.max
		});
		return {
			selector: { k: 'target', index },
			ref: { k: 'target', index },
			plural: multiAny.max > 1
		};
	}
	const multiTyped = parseTypedMultiTargetQuantifier(t);
	if (multiTyped) {
		const spec = targetPhrase(multiTyped.rest);
		if (!spec) return null;
		const { sameOwner, ...restSpec } = spec;
		const index = p.addTarget({
			...restSpec,
			min: multiTyped.min,
			max: multiTyped.max,
			...(sameOwner && multiTyped.max > 1 ? { sameOwner: true } : {})
		});
		return {
			selector: { k: 'target', index },
			ref: { k: 'target', index },
			plural: multiTyped.max > 1
		};
	}
	if (/^all (?:cards from all )?graveyards$/.test(t) || t === 'all cards from all graveyards') {
		return { selector: { k: 'all', filter: { zone: 'graveyard' } }, plural: true };
	}
	// --- Track P10 / P13: "<player>'s graveyard" / "all cards from <player>'s graveyard" (must precede `tgt`) ---
	const gyOwner = t.match(
		/^(?:all cards (?:from|in) )?(your|each opponent's|opponents'|target player's|target opponent's|that player's|their) graveyards?$/i
	);
	if (gyOwner) {
		const who = gyOwner[1].toLowerCase();
		if (who === 'your') {
			return { selector: { k: 'all', filter: { zone: 'graveyard', owner: 'you' } }, plural: true };
		}
		if (who === "each opponent's" || who === "opponents'") {
			return { selector: { k: 'all', filter: { zone: 'graveyard', owner: 'opponent' } }, plural: true };
		}
		const pPhrase =
			who === "target player's"
				? 'target player'
				: who === "target opponent's"
					? 'target opponent'
					: who === "that player's"
						? 'that player'
						: 'they';
		const pSel = playerPhrase(p, pPhrase);
		const pRef = pSel ? singlePlayer(pSel) : null;
		if (!pRef) return null;
		if (who.startsWith('target ')) p.lastPlayer = pSel!;
		return {
			selector: { k: 'all', filter: { zone: 'graveyard', controllerRef: pRef } },
			plural: true
		};
	}
	// --- End Track P10 / P13 ---
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
	const all = t.match(/^(?:all|each) (.+)$/);
	const barePluralBoard =
		!all &&
		!/^(?:a|an|another|target|up to|one|two|three|four|five|six|seven|eight|nine|ten|\d+|that|the|this|those|it|they|you|your|each|all)\b/i.test(
			t
		) &&
		/\b(?:creatures|permanents|artifacts|enchantments|lands|planeswalkers|battles|tokens|vehicles|walls|elves|goblins|zombies|soldiers|spirits|vampires|wizards|warriors|knights|dragons|angels|demons|beasts|birds|cats|dogs|elementals|faeries|fungi|giants|humans|horrors|insects|merfolk|mice|pirates|plants|rats|rogues|saprolings|skeletons|slivers|snakes|spiders|squirrels|thopters|treefolk|trolls|wurms)\b/i.test(
			t
		) &&
		!/\bcards?\b/i.test(t);
	const bare =
		(!all &&
			/\b(?:you control|your opponents control|opponents control|an opponent controls|you don't control|target player controls|target opponent controls|that player controls)$/.test(
				t
			) &&
			!/^(?:a|an|another|target)\b/.test(t)) ||
		barePluralBoard;
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
	if (/^(?:the result|the number of flips you won(?: this way)?|the number of coin flips you won(?: this way)?)$/i.test(t)) {
		return { k: 'lastRollResult' };
	}
	if (/^your life total$/i.test(t)) {
		return { k: 'life', of: { k: 'you' } };
	}
	const stat = t.match(
		/^(?:(its)|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the sacrificed creature's|the sacrificed permanent's|the sacrificed artifact's|the discarded card's|the amassed army's) (power|toughness|mana value)$/i
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
	if (num) {
		if (/^(?:coin )?flips you won(?: this way)?$/i.test(num[1].trim())) {
			return { k: 'lastRollResult' };
		}
		const nRes = numberOf(num[1]);
		if (nRes) return nRes;
	}
	const p13Amt = parseP13Amount(
		t,
		(sub) => equalTo(p, sub) ?? numberOf(sub) ?? amountWord(p, sub.toLowerCase())
	);
	if (p13Amt) return p13Amt;
	return null;
}

/** "creatures you control", "Elves you control", "cards in your hand". */
function numberOf(text: string): Amount | null {
	const hand = text.match(/^cards in (your|target opponent's) hand$/);
	if (hand && hand[1] === 'your') return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	// --- Track P10: graveyard counts & card types among cards in graveyards ---
	if (/^cards in your graveyard$/i.test(text.trim())) {
		return { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } };
	}
	if (/^card types among cards in your graveyard$/i.test(text.trim())) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' };
	}
	if (/^card types among cards in all graveyards$/i.test(text.trim())) {
		return { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'all' };
	}
	const inGy = text.trim().match(/^(.+?) in (your|all) graveyards?$/i);
	if (inGy) {
		const f = objectFilter(inGy[1]);
		if (f) {
			return {
				k: 'count',
				of: {
					...f,
					zone: 'graveyard',
					...(inGy[2].toLowerCase() === 'your' ? { owner: 'you' as const } : {})
				}
			};
		}
	}
	// --- End Track P10 ---
	if (/^(?:energy counters|\{E\}) you have$/i.test(text.trim())) {
		return { k: 'energyCount', player: { k: 'you' } };
	}
	if (/^times? you've cast (?:your|a) commander from the command zone this game$/i.test(text.trim())) {
		return { k: 'commanderCastCount' };
	}
	const p13Num = parseP13Amount(`the number of ${text.trim()}`);
	if (p13Num) return p13Num;
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
	let m: RegExpMatchArray | null = null;
	const whereIdx = text.toLowerCase().lastIndexOf('where x is ');
	if (whereIdx > 0 && !isInsideQuotes(text, whereIdx)) {
		const sepStart = text[whereIdx - 2] === ',' && text[whereIdx - 1] === ' ' ? whereIdx - 2 : whereIdx - 1;
		if (text[sepStart] === ',' || text[sepStart] === ' ') {
			m = [text, text.slice(0, sepStart), text.slice(whereIdx + 'where x is '.length)];
		}
	}
	if (!m) return { text };
	const rhs = m[2].trim();
	if (/^the result$/i.test(rhs)) {
		return { text: m[1], x: { k: 'lastRollResult' } };
	}
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
		if (x) return { text: m[1], x };
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
	const p13X = parseP13Amount(
		rhs,
		(sub) => equalTo(p, sub) ?? numberOf(sub) ?? amountWord(p, sub.toLowerCase())
	);
	if (p13X) return { text: m[1], x: p13X };
	if (
		/^(?:its|that card's|that creature's|that permanent's|that spell's|the exiled card's|the exiled creature's|the sacrificed creature's|the sacrificed permanent's|the discarded card's) (?:power|toughness|mana value)$/i.test(
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
	if (a.k === 'half') return { k: 'half', of: substituteX(a.of, x), round: a.round };
	if (a.k === 'sum') return { k: 'sum', args: a.args.map((arg) => substituteX(arg, x)) };
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
	// --- Track P10: "a number of <tokens> equal to <expr>" ---
	const numEqual = t.match(/^(?:a|the) number of (.+?\btokens?(?: tapped)?) equal to (.+)$/i);
	if (numEqual) {
		const amount = equalTo(p, numEqual[2].trim());
		if (!amount) return null;
		const base = tokenPhrase(p, `two ${numEqual[1].trim()}`);
		if (!base) return null;
		return { amount, token: base.token };
	}
	// --- End Track P10 ---
	const pre = t.match(/^(that many|\S+) (tapped )?([a-z]+(?: [a-z]+)?) tokens?( tapped)?$/i);
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
	if (m && !(m[2] && m[8])) {
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

	// --- Track P10: Creature & Artifact/Enchantment tokens with quoted abilities (`with "<ability>"`) ---
	const quotedCreature = t.match(
		/^(that many|\S+) (tapped )?(\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) (artifact )?creature tokens? with (?:([a-z, ]+?)(?:,? and )?)?[“"]([^”"]+)[”"]( tapped)?$/
	);
	if (quotedCreature && !(quotedCreature[2] && quotedCreature[10])) {
		const amount = amountWord(p, quotedCreature[1]);
		const qText = quotedCreature[9].trim();
		if (!amount || !isSupportedTokenQuotedAbility(qText)) return null;
		const kw = quotedCreature[8] ?? '';
		const parsedKws = kw
			? kw
					.split(/,? and |, /)
					.map((k) => k.trim().toLowerCase())
					.filter(Boolean)
			: [];
		if (parsedKws.some((k) => !GRANTABLE_KEYWORDS.includes(k) && k !== 'changeling')) {
			return null;
		}
		const spec = buildTokenSpec(
			parseInt(quotedCreature[3], 10),
			parseInt(quotedCreature[4], 10),
			`${quotedCreature[5]}${quotedCreature[6]}${quotedCreature[7] ? ' artifact' : ''}`.trim(),
			kw
		);
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
				quotedAbilities: [qText],
				...(quotedCreature[2] || quotedCreature[10] ? { tapped: true } : {})
			}
		};
	}

	const quotedNonCreature = t.match(
		/^(that many|\S+) (tapped )?((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)?(?:([A-Z][A-Za-z'-]*) )?(artifact|enchantment) tokens?(?: named ([A-Z][A-Za-z0-9' -]+?))? with [“"]([^”"]+)[”"]( tapped)?$/
	);
	if (quotedNonCreature && !(quotedNonCreature[2] && quotedNonCreature[8])) {
		const amount = amountWord(p, quotedNonCreature[1]);
		const qText = quotedNonCreature[7].trim();
		if (!amount || !isSupportedTokenQuotedAbility(qText)) return null;
		const colWords = (quotedNonCreature[3] ?? '')
			.split(/,? and |, |\s+/)
			.map((w) => w.trim().toLowerCase())
			.filter(Boolean);
		const colors: ManaColor[] = [];
		for (const cw of colWords) {
			if (cw === 'colorless') continue;
			const mc = COLOR_WORDS[cw];
			if (!mc) return null;
			if (!colors.includes(mc)) colors.push(mc);
		}
		const sub = quotedNonCreature[4]?.trim();
		const mainType = quotedNonCreature[5].toLowerCase() === 'enchantment' ? 'Enchantment' : 'Artifact';
		const tokenName = (quotedNonCreature[6]?.trim() || sub || mainType);
		const typeLine = sub ? `Token ${mainType} — ${sub}` : `Token ${mainType}`;
		return {
			amount,
			token: {
				name: tokenName,
				power: 0,
				toughness: 0,
				colors,
				typeLine,
				keywords: [],
				quotedAbilities: [qText],
				...(quotedNonCreature[2] || quotedNonCreature[8] ? { tapped: true } : {})
			}
		};
	}
	// --- End Track P10 ---
	return null;
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
		destinations: search.destinations.map((d) => ({
			zone: d.zone === 'battlefield' || d.zone === 'library' ? d.zone : 'hand',
			...(d.tapped ? { tapped: d.tapped } : {}),
			...(d.onTop ? { onTop: d.onTop } : {})
		})),
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

// --- Track P10: Multi-zone, different-names, opponent-library, & exile/graveyard search (CR 701.23b) ---
function parseExtendedSearchZones(raw: string): Array<'library' | 'graveyard' | 'hand'> | null {
	const z = raw.trim().toLowerCase();
	if (z === 'library') return ['library'];
	if (z === 'graveyard') return ['graveyard'];
	if (z === 'library and/or graveyard' || z === 'graveyard and/or library' || z === 'library and graveyard') {
		return ['library', 'graveyard'];
	}
	if (
		z === 'library, graveyard, and/or hand' ||
		z === 'graveyard, hand, and/or library' ||
		z === 'hand, graveyard, and/or library' ||
		z === 'library, hand, and/or graveyard'
	) {
		return ['library', 'graveyard', 'hand'];
	}
	return null;
}

function extendedSearchClause(p: Parser, rest: string): SearchSpec | null {
	const t = rest.replace(/\.$/, '').trim();
	const m = t.match(
		/^search (your|their|that player's|target player's|target opponent's) (library(?:,\s*graveyard,\s*and\/or hand|(?:\s+and\/or|\s+and)\s+graveyard)?|graveyard(?:,\s*hand,\s*and\/or library|\s+and\/or\s+library)?) for (.+?)((?:,\s*|\s+and\s+)(?:reveal|put|then|shuffle|exile)\b.*)$/i
	);
	if (!m) return null;

	const whoRaw = m[1].toLowerCase();
	let searchedPlayer: PlayerRef | undefined;
	const snapshot = p.targets.length;
	if (whoRaw === "target player's" || whoRaw === "target opponent's") {
		const pSel = playerPhrase(p, whoRaw === "target player's" ? 'target player' : 'target opponent');
		const pRef = pSel ? singlePlayer(pSel) : null;
		if (!pRef) {
			p.targets.length = snapshot;
			return null;
		}
		p.lastPlayer = pSel!;
		searchedPlayer = pRef;
	} else if (whoRaw === "that player's") {
		const pSel = playerPhrase(p, 'that player');
		const pRef = pSel ? singlePlayer(pSel) : null;
		if (!pRef) return null;
		searchedPlayer = pRef;
	}

	const zones = parseExtendedSearchZones(m[2]);
	if (!zones) {
		p.targets.length = snapshot;
		return null;
	}

	let criteria = m[3].trim();
	let differentNames = false;
	if (/\s+with different names$/i.test(criteria)) {
		differentNames = true;
		criteria = criteria.replace(/\s+with different names$/i, '').trim();
	}

	let upTo = false;
	if (/^up to\s+/i.test(criteria)) {
		upTo = true;
		criteria = criteria.replace(/^up to\s+/i, '').trim();
	}

	let searchCount = 1;
	const cntMatch = criteria.match(/^(a|an|one|two|three|four|five|six|\d+)\s+(.+)$/i);
	if (!cntMatch) {
		p.targets.length = snapshot;
		return null;
	}
	const parsedCnt = count(cntMatch[1].toLowerCase() === 'a' || cntMatch[1].toLowerCase() === 'an' ? 'one' : cntMatch[1]);
	if (!parsedCnt || parsedCnt.k !== 'const' || parsedCnt.n < 1) {
		p.targets.length = snapshot;
		return null;
	}
	searchCount = parsedCnt.n;
	const filterRaw = cntMatch[2].trim();
	const statedQuality = !/^cards?$/i.test(filterRaw);
	const filter = statedQuality ? objectFilter(filterRaw) : {};
	if (!filter) {
		p.targets.length = snapshot;
		return null;
	}

	const rawSubParts = m[4]
		.replace(/^(?:,\s*|\s+and\s+)/, '')
		.split(/,\s*(?:then\s+)?|\s+and\s+(?=put|reveal|shuffle|exile|if you search)|,?\s+then\s+/i)
		.map((s) => s.trim())
		.filter(Boolean);

	let reveal = false;
	let shuffleSeen = false;
	let shuffleOnlyIfLibrary = false;
	const destinations: SearchSpec['destinations'] = [];

	for (const part of rawSubParts) {
		if (/^reveal (?:it|them|that card|those cards)$/i.test(part)) {
			reveal = true;
			continue;
		}
		if (/^(?:(?:then )?shuffle|(?:that player|they) shuffles?)$/i.test(part)) {
			shuffleSeen = true;
			continue;
		}
		if (/^if you search(?:ed)? your library this way, shuffle$/i.test(part)) {
			shuffleSeen = true;
			shuffleOnlyIfLibrary = true;
			continue;
		}
		if (/^exile (?:it|that card|them|those cards)$/i.test(part)) {
			destinations.push({ zone: 'exile' });
			continue;
		}
		if (/^put (?:it|that card|them|those cards) into (?:your|their|that player's) hand$/i.test(part)) {
			destinations.push({ zone: 'hand' });
			continue;
		}
		if (/^put (?:it|that card|them|those cards) into (?:your|their|its owner's) graveyard$/i.test(part)) {
			destinations.push({ zone: 'graveyard' });
			continue;
		}
		const bfMatch = part.match(/^put (?:it|that card|them|those cards) onto the battlefield( tapped)?$/i);
		if (bfMatch) {
			destinations.push({ zone: 'battlefield', ...(bfMatch[1] ? { tapped: true } : {}) });
			continue;
		}
		if (/^put (?:it|that card|them|those cards) on top of (?:your|their) library$/i.test(part)) {
			destinations.push({ zone: 'library', onTop: true });
			continue;
		}
		if (/^put one (?:of them )?onto the battlefield( tapped)? and the other into your hand$/i.test(part)) {
			const tapOne = /\btapped\b/i.test(part);
			destinations.push({ zone: 'battlefield', ...(tapOne ? { tapped: true } : {}) }, { zone: 'hand' });
			continue;
		}
		p.targets.length = snapshot;
		return null;
	}

	if (destinations.length === 0) {
		p.targets.length = snapshot;
		return null;
	}
	if (zones.length === 1 && zones[0] === 'library' && !shuffleSeen && !searchedPlayer) {
		p.targets.length = snapshot;
		return null;
	}
	if (zones.includes('library') && !shuffleSeen && !searchedPlayer) {
		shuffleOnlyIfLibrary = true;
	}

	return {
		filter,
		count: searchCount,
		upTo,
		statedQuality,
		...(reveal ? { reveal: true } : {}),
		destinations,
		description: filterRaw,
		...(zones.length > 1 || zones[0] !== 'library' ? { zones } : {}),
		...(differentNames ? { differentNames: true } : {}),
		...(shuffleOnlyIfLibrary ? { shuffleOnlyIfLibrary: true } : {}),
		...(searchedPlayer ? { searchedPlayer } : {})
	};
}
// --- End Track P10 ---

// ---- Clause productions ---------------------------------------------------------------------

type ClauseResult = boolean;

interface Clause {
	text: string;
	span: Span;
}

/** Duration qualifier at either end of a clause ("until end of turn", "until your next turn", "until the end of your next turn"). */
function stripDuration(text: string): { text: string; eot: boolean; duration?: Duration } {
	let m = text.match(/^(.+?) until end of turn$/);
	if (m) return { text: m[1], eot: true, duration: 'endOfTurn' };
	m = text.match(/^until end of turn, (.+)$/);
	if (m) return { text: m[1], eot: true, duration: 'endOfTurn' };
	m = text.match(/^(.+?) until your next turn$/i);
	if (m) return { text: m[1], eot: true, duration: 'untilYourNextTurn' };
	m = text.match(/^until your next turn, (.+)$/i);
	if (m) return { text: m[1], eot: true, duration: 'untilYourNextTurn' };
	m = text.match(/^(.+?) until (?:the )?end of your next turn$/i);
	if (m) return { text: m[1], eot: true, duration: 'untilEndOfYourNextTurn' };
	m = text.match(/^until (?:the )?end of your next turn, (.+)$/i);
	if (m) return { text: m[1], eot: true, duration: 'untilEndOfYourNextTurn' };
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
	durationFromPrefix: Duration | undefined,
	span: Span
): EffectStep | null {
	if (subject.fromZone) return null;
	const m = bodyAfterDuration.match(/^becomes? (?:a|an) (.+)$/);
	if (!m) return null;
	let rest = m[1].trim();
	let animDuration: Duration | undefined = durationFromPrefix;
	let keepExistingTypes = false;
	let additiveColors = false;
	let basePT: { power: Amount; toughness: Amount } | null = null;
	let addKeywords: string[] | undefined;

	// Strip trailing qualifiers from right to left so order variations ("... with haste until end of turn"
	// vs "... that's still a land" vs "... in addition to its other types until end of turn") all parse.
	for (let guard = 0; guard < 12; guard++) {
		const durMatch = rest.match(
			/^(.+?) (until end of turn|until your next turn|until (?:the )?end of your next turn)$/i
		);
		if (durMatch) {
			const dLow = durMatch[2].toLowerCase();
			animDuration =
				dLow === 'until end of turn'
					? 'endOfTurn'
					: dLow === 'until your next turn'
						? 'untilYourNextTurn'
						: 'untilEndOfYourNextTurn';
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
		duration: animDuration ?? 'permanent'
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

// --- Track P7: Copy modifications, becomeCopy, and timed combat restrictions ---

const COPY_CARD_TYPE_WORDS: Readonly<Record<string, string>> = {
	artifact: 'Artifact',
	artifacts: 'Artifact',
	creature: 'Creature',
	creatures: 'Creature',
	enchantment: 'Enchantment',
	enchantments: 'Enchantment',
	land: 'Land',
	lands: 'Land',
	planeswalker: 'Planeswalker',
	planeswalkers: 'Planeswalker'
};

function dedupeCopyList<T>(arr: readonly T[]): T[] {
	const out: T[] = [];
	for (const x of arr) {
		if (!out.includes(x)) out.push(x);
	}
	return out;
}

function parseCopyModSubclause(rawSub: string, mod: CopyModificationSpec): boolean {
	const s = rawSub.trim();
	if (!s) return false;

	if (
		/^(?:(?:the tokens?|the cop(?:y|ies)|it|they) (?:isn't|is not|aren't|are not)|it's not|they're not|is not|isn't) legendary(?: if (?:that (?:creature|permanent)|it) is legendary)?$/i.test(
			s
		)
	) {
		mod.removeSupertypes = dedupeCopyList([...(mod.removeSupertypes ?? []), 'Legendary']);
		return true;
	}

	let m = s.match(
		/^(?:its name is|their names? (?:is|are)|(?:it's|it is|the token is) named) ([A-Z][A-Za-z0-9'’ -]+)$/
	);
	if (m) {
		mod.name = m[1].trim();
		return true;
	}

	m = s.match(/^(?:(?:the tokens?|the cop(?:y|ies)|it|they) )?(?:has|have) no mana cost$/i);
	if (m) {
		mod.noManaCost = true;
		return true;
	}

	m = s.match(/^(?:(?:the tokens?|the cop(?:y|ies)|it|they) )?(?:has|have) base power and toughness (\d+)\/(\d+)$/i);
	if (m) {
		mod.power = parseInt(m[1], 10);
		mod.toughness = parseInt(m[2], 10);
		return true;
	}

	m = s.match(/^(?:(?:the tokens?|the cop(?:y|ies)|it|they) )?(?:has|have) (.+)$/i);
	if (m) {
		const kws = keywordList(m[1].trim());
		if (!kws) return false;
		mod.addKeywords = dedupeCopyList([...(mod.addKeywords ?? []), ...kws]);
		return true;
	}

	m = s.match(/^(?:(?:the tokens?|the cop(?:y|ies)) (?:is|are)|it's|they're|it is|they are|is) (.+)$/i);
	if (!m) return false;
	let rest = m[1].trim();
	let additiveColors = false;
	let additiveTypes = false;

	for (let iter = 0; iter < 8; iter++) {
		const addColTypes = rest.match(/^(.+?) in addition to (?:its|their) other colors and types$/i);
		if (addColTypes) {
			additiveColors = true;
			additiveTypes = true;
			rest = addColTypes[1].trim();
			continue;
		}
		const addTypesMatch = rest.match(/^(.+?) in addition to (?:its|their) other types$/i);
		if (addTypesMatch) {
			additiveTypes = true;
			rest = addTypesMatch[1].trim();
			continue;
		}
		const noMcMatch = rest.match(/^(.+?) with no mana cost$/i);
		if (noMcMatch) {
			mod.noManaCost = true;
			rest = noMcMatch[1].trim();
			continue;
		}
		const basePtMatch = rest.match(/^(.+?) with base power and toughness (\d+)\/(\d+)$/i);
		if (basePtMatch) {
			mod.power = parseInt(basePtMatch[2], 10);
			mod.toughness = parseInt(basePtMatch[3], 10);
			rest = basePtMatch[1].trim();
			continue;
		}
		const withIdx = rest.lastIndexOf(' with ');
		if (withIdx > 0) {
			const kwRaw = rest.slice(withIdx + ' with '.length).trim();
			const kws = keywordList(kwRaw);
			if (!kws) return false;
			mod.addKeywords = dedupeCopyList([...kws, ...(mod.addKeywords ?? [])]);
			rest = rest.slice(0, withIdx).trim();
			continue;
		}
		break;
	}

	rest = rest.replace(/^(?:a|an)\s+/i, '').trim();
	if (/^nonlegendary$/i.test(rest)) {
		mod.removeSupertypes = dedupeCopyList([...(mod.removeSupertypes ?? []), 'Legendary']);
		return true;
	}

	const tokens = rest
		.replace(/,/g, ' , ')
		.split(/\s+/)
		.filter(Boolean);
	let touched = false;

	if (tokens[0] && /^\d+\/\d+$/.test(tokens[0])) {
		const [pw, tg] = tokens.shift()!.split('/');
		mod.power = parseInt(pw, 10);
		mod.toughness = parseInt(tg, 10);
		touched = true;
	}

	let colors: ManaColor[] | undefined;
	if (tokens[0]?.toLowerCase() === 'colorless') {
		colors = [];
		tokens.shift();
		touched = true;
	} else if (tokens[0] && COLOR_WORDS[tokens[0].toLowerCase()]) {
		colors = [COLOR_WORDS[tokens.shift()!.toLowerCase()]];
		touched = true;
		while (tokens.length >= 2) {
			if (tokens[0] === ',' && tokens[1]?.toLowerCase() === 'and' && tokens[2] && COLOR_WORDS[tokens[2].toLowerCase()]) {
				tokens.shift();
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!.toLowerCase()]);
			} else if (tokens[0] === ',' && tokens[1] && COLOR_WORDS[tokens[1].toLowerCase()]) {
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!.toLowerCase()]);
			} else if (tokens[0]?.toLowerCase() === 'and' && tokens[1] && COLOR_WORDS[tokens[1].toLowerCase()]) {
				tokens.shift();
				colors.push(COLOR_WORDS[tokens.shift()!.toLowerCase()]);
			} else {
				break;
			}
		}
	}
	if (colors !== undefined) {
		if (additiveColors) mod.addColors = dedupeCopyList([...(mod.addColors ?? []), ...colors]);
		else mod.setColors = colors;
	}

	const cardTypes: string[] = [];
	const subtypes: string[] = [];
	for (const tok of tokens) {
		if (tok === ',') continue;
		const low = tok.toLowerCase();
		if (low === 'nonlegendary') {
			mod.removeSupertypes = dedupeCopyList([...(mod.removeSupertypes ?? []), 'Legendary']);
			touched = true;
			continue;
		}
		if (COPY_CARD_TYPE_WORDS[low]) {
			cardTypes.push(COPY_CARD_TYPE_WORDS[low]);
			touched = true;
			continue;
		}
		if (/^[A-Z][A-Za-z'-]*$/.test(tok)) {
			const sub = singularSubtype(tok) ?? tok;
			subtypes.push(sub);
			touched = true;
			continue;
		}
		return false;
	}

	if (!touched) return false;

	if (additiveTypes) {
		if (cardTypes.length > 0) {
			mod.addTypes = dedupeCopyList([...(mod.addTypes ?? []), ...cardTypes]);
		} else if (subtypes.length > 0) {
			mod.addTypes = dedupeCopyList([...(mod.addTypes ?? []), 'Creature']);
		}
		if (subtypes.length > 0) {
			mod.addSubtypes = dedupeCopyList([...(mod.addSubtypes ?? []), ...subtypes]);
		}
	} else {
		if (cardTypes.length > 0) mod.setTypes = dedupeCopyList(cardTypes);
		if (subtypes.length > 0) mod.setSubtypes = dedupeCopyList(subtypes);
	}
	return true;
}

function parseCopyModifications(rawExcept: string): { notLegendary?: boolean; copyMod?: CopyModificationSpec } | null {
	const trimmed = rawExcept.trim();
	if (!trimmed || /["“”]/.test(trimmed)) return null;
	if (/^(?:the tokens?|the cop(?:y|ies)|it|they) (?:isn't|aren't) legendary$/i.test(trimmed)) {
		return { notLegendary: true };
	}
	const parts = trimmed.split(
		/,\s+and\s+(?=(?:the tokens?|the cop(?:y|ies)|it's|they're|it is|they are|it|they|its name|their names?|is (?:a |an |not\b)|has\b|have\b|aren't\b|isn't\b)\b)|\s+and\s+(?=(?:the tokens?|the cop(?:y|ies)|it's|they're|it is|they are|it|they|its name|their names?|is (?:a |an |not\b)|has\b|have\b|aren't\b|isn't\b)\b)|,\s+(?=(?:the tokens?|the cop(?:y|ies)|it's|they're|it is|they are|it|they|its name|their names?|is (?:a |an |not\b)|has\b|have\b|aren't\b|isn't\b)\b)/i
	);
	const mod: CopyModificationSpec = {};
	for (const part of parts) {
		if (!parseCopyModSubclause(part, mod)) return null;
	}
	return Object.keys(mod).length > 0 ? { copyMod: mod } : null;
}

function parseBecomeCopyPredicate(
	p: Parser,
	subject: ObjectRes,
	bodyAfterDuration: string,
	eotFromPrefix: boolean,
	span: Span
): EffectStep | null {
	if (subject.fromZone) return null;
	const m = bodyAfterDuration.match(/^becomes? a copy of (.+)$/);
	if (!m) return null;
	let rest = m[1].trim();
	let eot = eotFromPrefix;
	const trailDur = rest.match(/^(.+?) until end of turn$/);
	if (trailDur) {
		eot = true;
		rest = trailDur[1].trim();
	}
	let copyMod: CopyModificationSpec | undefined;
	const excIdx = rest.indexOf(', except ');
	if (excIdx > 0) {
		let excRaw = rest.slice(excIdx + ', except '.length).trim();
		const excDur = excRaw.match(/^(.+?) until end of turn$/);
		if (excDur) {
			eot = true;
			excRaw = excDur[1].trim();
		}
		const parsedMod = parseCopyModifications(excRaw);
		if (!parsedMod) return null;
		copyMod = parsedMod.copyMod ?? (parsedMod.notLegendary ? { removeSupertypes: ['Legendary'] } : undefined);
		rest = rest.slice(0, excIdx).trim();
	}
	const restDur = rest.match(/^(.+?) until end of turn$/);
	if (restDur) {
		eot = true;
		rest = restDur[1].trim();
	}

	const snapshot = p.targets.length;
	const isAnotherTarget = /^another target\b/.test(rest);
	const srcObj = objectPhrase(p, isAnotherTarget ? rest.replace(/^another /, '') : rest);
	if (!srcObj || srcObj.fromZone || srcObj.selector.k === 'all') {
		p.targets.length = snapshot;
		return null;
	}
	if (srcObj.selector.k === 'target') {
		const spec = p.targets[srcObj.selector.index];
		if (!spec || spec.kind !== 'object' || spec.max !== 1 || (spec.filter.zone ?? 'battlefield') !== 'battlefield') {
			p.targets.length = snapshot;
			return null;
		}
		if (isAnotherTarget) {
			if (subject.selector.k === 'self') spec.filter.other = true;
			else if (srcObj.selector.index > 0) spec.otherTarget = true;
		}
	}
	return {
		verb: 'becomeCopy',
		subject: subject.selector,
		params: {
			copySource: srcObj.selector,
			duration: eot ? 'endOfTurn' : 'permanent',
			...(copyMod ? { copyMod } : {})
		},
		span
	};
}

function parseExceptByBlockers(raw: string): NonNullable<TimedCombatRestrictionSpec['exceptBy']> | null {
	const t = raw.trim();
	let m = t.match(/^(\S+) or more creatures$/);
	if (m) {
		const c = count(m[1]);
		if (c && c.k === 'const' && c.n >= 2) return { minBlockers: c.n };
		return null;
	}
	m = t.match(/^artifact creatures and\/or (white|blue|black|red|green) creatures$/);
	if (m) return { artifactOrColors: [COLOR_WORDS[m[1]]] };
	m = t.match(/^creatures with power (\d+) or less$/);
	if (m) return { maxPower: parseInt(m[1], 10) };
	m = t.match(/^creatures with (.+)$/);
	if (m) {
		const kws = keywordList(m[1], true);
		if (!kws) return null;
		return { keywords: kws.map((k) => k.toLowerCase()) };
	}
	if (t === 'artifact creatures') return { types: ['Artifact'] };
	m = t.match(/^non(white|blue|black|red|green) creatures$/);
	if (m) return { notColors: [COLOR_WORDS[m[1]]] };
	m = t.match(/^((?:(?:white|blue|black|red|green)(?:,? (?:and\/or|or) |, ))*(?:white|blue|black|red|green)) creatures$/);
	if (m) {
		const cols = m[1]
			.split(/,? (?:and\/or|or) |, /)
			.map((w) => COLOR_WORDS[w.trim()])
			.filter(Boolean);
		if (cols.length > 0) return { colors: dedupeCopyList(cols) };
	}
	m = t.match(/^([A-Z][A-Za-z'-]*)(?: creatures)?$/);
	if (m) {
		const sub = singularSubtype(m[1]);
		if (sub) return { subtypes: [sub] };
	}
	return null;
}

function parseCombatRestrictionTail(raw: string, outerEot: boolean): TimedCombatRestrictionSpec | null {
	const t = raw.trim();
	if (t === "can't block this turn" || (outerEot && t === "can't block")) {
		return { kind: 'cantBlock' };
	}
	if (t === "can't be blocked this turn" || (outerEot && t === "can't be blocked")) {
		return { kind: 'cantBeBlocked' };
	}
	let m = t.match(/^can't be blocked except by (.+?) this turn$/);
	if (!m) m = t.match(/^can't be blocked this turn except by (.+)$/);
	if (!m && outerEot) m = t.match(/^can't be blocked except by (.+)$/);
	if (m) {
		const exceptBy = parseExceptByBlockers(m[1]);
		if (!exceptBy) return null;
		return { kind: 'cantBeBlocked', exceptBy };
	}
	return null;
}
// --- End Track P7 ---

/** Verb phrases whose subject is an object ("~ gets +1/+0 until end of turn", "it phases out"). */
function objectPredicate(p: Parser, subject: ObjectRes, vp: string, span: Span): ClauseResult {
	const { text, eot, duration } = stripDuration(vp);
	const isEndOfTurn = duration === 'endOfTurn';
	const params = duration ? { duration } : {};

	// --- Track P7: becomeCopy, multi-target "each", combat restrictions, divided/multi damage ---
	if (/^becomes? a copy of /.test(text)) {
		if (duration && !isEndOfTurn) return false;
		const copyStep = parseBecomeCopyPredicate(p, subject, text, isEndOfTurn, span);
		if (!copyStep) return false;
		p.push(copyStep, true);
		return true;
	}
	// --- End Track P7 ---

	if (/^becomes? (?:a|an) /.test(text)) {
		const anim = parseAnimatePredicate(subject, text, duration, span);
		if (!anim) return false;
		p.push(anim, true);
		return true;
	}

	const predText =
		subject.plural || subject.selector.k === 'target' || subject.selector.k === 'all'
			? text.replace(/^each\s+/, '')
			: text;

	// "gain trample and get +X/+X" (Overrun templating): two steps on the same subject.
	const both = predText.match(/^gains? (.+?) and gets? (\S+)$/);
	if (both && eot) {
		const kws = keywordList(both[1]);
		const pt = ptChange(both[2]);
		if (!kws || !pt) return false;
		p.push({ verb: 'grant', subject: subject.selector, params: { keywords: kws, ...params }, span }, true);
		p.push({ verb: 'pump', subject: subject.selector, amount: pt.power, params: { toughness: pt.toughness, ...params }, span }, true);
		return true;
	}
	// --- Track P7: "gets +X/+Y and gains <keywords> until end of turn" & compound combat restrictions ---
	const ptAndGain = predText.match(/^gets? (\S+)(?:,)? and gains? (.+)$/);
	if (ptAndGain && eot) {
		const pt = ptChange(ptAndGain[1]);
		const kws = keywordList(ptAndGain[2]);
		if (!pt || !kws) return false;
		p.push(
			{
				verb: 'pump',
				subject: subject.selector,
				amount: pt.power,
				params: { toughness: pt.toughness, ...params },
				span
			},
			true
		);
		p.push(
			{ verb: 'grant', subject: subject.selector, params: { keywords: kws, ...params }, span },
			true
		);
		return true;
	}
	const validBattlefieldObjectSubject =
		!subject.fromZone &&
		(subject.selector.k !== 'target' ||
			(p.targets[subject.selector.index]?.kind === 'object' &&
				(p.targets[subject.selector.index]?.filter.zone ?? 'battlefield') === 'battlefield'));
	const modAndRestr = predText.match(
		/^(?:gets? (\S+)|gains? (.+?))( until end of turn)?(?:,)? and (can't (?:block|be blocked).*)$/
	);
	if (modAndRestr && validBattlefieldObjectSubject && (isEndOfTurn || Boolean(modAndRestr[3]))) {
		const combatRestriction = parseCombatRestrictionTail(modAndRestr[4], isEndOfTurn);
		if (!combatRestriction) return false;
		if (modAndRestr[1]) {
			const pt = ptChange(modAndRestr[1]);
			if (!pt) return false;
			p.push(
				{
					verb: 'pump',
					subject: subject.selector,
					amount: pt.power,
					params: { toughness: pt.toughness, duration: 'endOfTurn' },
					span
				},
				true
			);
		} else if (modAndRestr[2]) {
			const kws = keywordList(modAndRestr[2]);
			if (!kws) return false;
			p.push(
				{
					verb: 'grant',
					subject: subject.selector,
					params: { keywords: kws, duration: 'endOfTurn' },
					span
				},
				true
			);
		}
		p.push(
			{
				verb: 'combatRestriction',
				subject: subject.selector,
				params: { combatRestriction },
				span
			},
			true
		);
		return true;
	}
	const combatRestriction = (!duration || isEndOfTurn) ? parseCombatRestrictionTail(predText, isEndOfTurn) : null;
	if (combatRestriction) {
		if (!validBattlefieldObjectSubject) return false;
		p.push(
			{
				verb: 'combatRestriction',
				subject: subject.selector,
				params: { combatRestriction },
				span
			},
			true
		);
		return true;
	}
	// --- End Track P7 ---
	const get = predText.match(/^gets? (\S+)$/);
	if (get && eot) {
		const pt = ptChange(get[1]);
		if (!pt) return false;
		p.push({ verb: 'pump', subject: subject.selector, amount: pt.power, params: { toughness: pt.toughness, ...params }, span }, true);
		return true;
	}
	// --- Track P10: Suspect / Unsuspect, Endure N, & EOT Quoted Ability Grants ---
	if (!eot && validBattlefieldObjectSubject) {
		if (/^(?:becomes? suspected|is suspected)$/i.test(predText)) {
			p.push({ verb: 'suspect', subject: subject.selector, span }, true);
			return true;
		}
		if (/^(?:is no longer suspected|becomes? unsuspected)$/i.test(predText)) {
			p.push({ verb: 'suspect', subject: subject.selector, params: { unsuspect: true }, span }, true);
			return true;
		}
		const endureObj = predText.match(/^endures? (that many|that much|\S+)$/i);
		if (endureObj) {
			const amount = amountWord(p, endureObj[1]);
			if (!amount) return false;
			p.push({ verb: 'endure', subject: subject.selector, amount, span }, true);
			return true;
		}
	}
	const ptAndGainQuoted = predText.match(
		/^gets? (\S+)(?:,)? and (?:gains?|has|have) (?:([a-z, ]+?)(?:,? and )?)?[“"]([^”"]+)[”"]$/
	);
	if (ptAndGainQuoted && eot && validBattlefieldObjectSubject) {
		const pt = ptChange(ptAndGainQuoted[1]);
		const qText = ptAndGainQuoted[3].trim();
		const kws = ptAndGainQuoted[2] ? keywordList(ptAndGainQuoted[2].trim()) : [];
		if (!pt || !kws || !isSupportedEotQuotedAbility(qText)) return false;
		p.push(
			{
				verb: 'pump',
				subject: subject.selector,
				amount: pt.power,
				params: { toughness: pt.toughness, ...params },
				span
			},
			true
		);
		p.push(
			{
				verb: 'grant',
				subject: subject.selector,
				params: {
					...(kws.length > 0 ? { keywords: kws } : {}),
					grantedAbilityTexts: [qText],
					...params
				},
				span
			},
			true
		);
		return true;
	}
	const gainQuoted = predText.match(
		/^(?:gains?|has|have) (?:([a-z, ]+?)(?:,? and )?)?[“"]([^”"]+)[”"]$/
	);
	if (gainQuoted && eot && validBattlefieldObjectSubject) {
		const qText = gainQuoted[2].trim();
		const kws = gainQuoted[1] ? keywordList(gainQuoted[1].trim()) : [];
		if (!kws || !isSupportedEotQuotedAbility(qText)) return false;
		p.push(
			{
				verb: 'grant',
				subject: subject.selector,
				params: {
					...(kws.length > 0 ? { keywords: kws } : {}),
					grantedAbilityTexts: [qText],
					...params
				},
				span
			},
			true
		);
		return true;
	}
	// --- End Track P10 ---
	// --- Track P13: Defender bypass & permanent grant on bound objects ---
	if (
		validBattlefieldObjectSubject &&
		((!duration && /^can attack this turn as though (?:it|they) didn't have defender$/i.test(predText)) ||
			(isEndOfTurn && /^can attack as though (?:it|they) didn't have defender$/i.test(predText)))
	) {
		p.push(
			{
				verb: 'grant',
				subject: subject.selector,
				params: { canAttackNoDefender: true, duration: 'endOfTurn' },
				span
			},
			true
		);
		return true;
	}
	// --- End Track P13 ---
	const gain = predText.match(/^gains? (.+)$/);
	if (gain && (eot || subject.selector.k === 'binding')) {
		const kws = keywordList(gain[1]);
		if (!kws) return false;
		p.push(
			{
				verb: 'grant',
				subject: subject.selector,
				params: { keywords: kws, ...(duration ? { duration } : { duration: 'permanent' }) },
				span
			},
			true
		);
		return true;
	}
	const lose = predText.match(/^loses? (.+?)(?: and can't (?:have or gain|have|gain) (.+))?$/);
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
	// --- Track P7: Divided damage (CR 601.2d) & two-recipient damage (Arc Trail) ---
	const divDmg = text.match(/^deals (that much|that many|\S+) damage divided as you choose among (.+)$/);
	if (divDmg && !eot && canDealDamage) {
		const amount = amountWord(p, divDmg[1]);
		if (!amount) return false;
		const divTarget = parseDividedTargets(p, divDmg[2], amount, false);
		if (!divTarget) return false;
		const dmgParams: EffectStep['params'] = {
			divided: true,
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {})
		};
		p.push({ verb: 'damage', subject: divTarget, amount, params: dmgParams, span }, false);
		return true;
	}
	const divDmgEq = text.match(/^deals damage equal to (.+?) divided as you choose among (.+)$/);
	if (divDmgEq && !eot && canDealDamage) {
		const amount = equalTo(p, divDmgEq[1]);
		if (!amount) return false;
		const divTarget = parseDividedTargets(p, divDmgEq[2], amount, false);
		if (!divTarget) return false;
		const dmgParams: EffectStep['params'] = {
			divided: true,
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {})
		};
		p.push({ verb: 'damage', subject: divTarget, amount, params: dmgParams, span }, false);
		return true;
	}
	const twoRecDmg = text.match(
		/^deals (\S+) damage to (.+?) and (\S+) damage to ((?:another target|up to one other target).*)$/
	);
	if (twoRecDmg && !eot && canDealDamage) {
		const snapshot = p.mark();
		const amt1 = count(twoRecDmg[1]);
		const amt2 = count(twoRecDmg[3]);
		const rec1 = amt1 ? damageRecipientSpec(p, twoRecDmg[2], subject.selector) : null;
		// Pass a non-'self' marker for rec2 when rec1 is a target so "another target" sets `otherTarget: true`!
		const rec2SourceHint: Selector =
			rec1?.subject.k === 'target' ? rec1.subject : subject.selector;
		const rec2 = amt2 && rec1 ? damageRecipientSpec(p, twoRecDmg[4], rec2SourceHint) : null;
		if (!amt1 || !amt2 || !rec1 || !rec2) {
			p.rollback(snapshot);
			return false;
		}
		const params1: EffectStep['params'] = {
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {}),
			...(rec1.alsoDamagePlayers ? { alsoDamagePlayers: rec1.alsoDamagePlayers } : {})
		};
		const params2: EffectStep['params'] = {
			...(subject.selector.k !== 'self' ? { damageSource: subject.selector } : {}),
			...(rec2.alsoDamagePlayers ? { alsoDamagePlayers: rec2.alsoDamagePlayers } : {})
		};
		p.push(
			{
				verb: 'damage',
				subject: rec1.subject,
				amount: amt1,
				...(Object.keys(params1).length > 0 ? { params: params1 } : {}),
				span
			},
			false
		);
		p.push(
			{
				verb: 'damage',
				subject: rec2.subject,
				amount: amt2,
				...(Object.keys(params2).length > 0 ? { params: params2 } : {}),
				span
			},
			false
		);
		return true;
	}
	// --- End Track P7 ---
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
		const normalized =
			t === 'another target'
				? 'any target'
				: t === 'up to one other target'
					? 'up to one target'
					: t
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
	const eachOfTarget = t.match(/^each of (.+)$/);
	if (eachOfTarget) {
		const snapshot = p.targets.length;
		const obj = objectPhrase(p, eachOfTarget[1]);
		if (!obj || obj.selector.k !== 'target') {
			p.targets.length = snapshot;
			return null;
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

// --- Track P7: Token copy phrase parser (CR 707.2, 707.8a, 707.9a–d, 508.4) ---
function parseTokenCopyPhrase(
	p: Parser,
	actor: PlayerRef,
	opt: { optional?: EffectStep['optional'] },
	raw: string,
	span: Span
): boolean {
	const m = raw
		.trim()
		.match(/^(that many|\S+) (?:(tapped and attacking|tapped) )?tokens? (?:that's a copy|that are copies) of (.+)$/);
	if (!m) return false;
	const amount = amountWord(p, m[1]);
	if (!amount) return false;

	let objRaw = m[3].trim();
	let exceptRaw: string | undefined;
	const exceptIdx = objRaw.indexOf(', except ');
	if (exceptIdx >= 0) {
		exceptRaw = objRaw.slice(exceptIdx + ', except '.length).trim();
		objRaw = objRaw.slice(0, exceptIdx).trim();
	}

	let tapped = m[2] === 'tapped' || m[2] === 'tapped and attacking';
	let tappedAndAttacking = m[2] === 'tapped and attacking';
	if (!m[2]) {
		const trailTA = objRaw.match(/^(.+?)(?:,)? tapped and attacking$/);
		const trailT = !trailTA ? objRaw.match(/^(.+?)(?:,)? tapped$/) : null;
		if (trailTA) {
			objRaw = trailTA[1].trim();
			tapped = true;
			tappedAndAttacking = true;
		} else if (trailT) {
			objRaw = trailT[1].trim();
			tapped = true;
		}
	}

	let notLegendary = false;
	let copyMod: CopyModificationSpec | undefined;
	if (exceptRaw !== undefined) {
		const parsedMod = parseCopyModifications(exceptRaw);
		if (!parsedMod) return false;
		if (parsedMod.notLegendary) notLegendary = true;
		if (parsedMod.copyMod) copyMod = parsedMod.copyMod;
	}

	const snapshot = p.targets.length;
	const strippedEachOf = objRaw.replace(/^each of\s+/, '');
	const isAnotherTarget = /^another target\b/.test(strippedEachOf);
	if (isAnotherTarget && p.context === 'spell') return false;
	const obj = objectPhrase(
		p,
		isAnotherTarget ? strippedEachOf.replace(/^another /, '') : strippedEachOf
	);
	if (!obj) {
		p.targets.length = snapshot;
		return false;
	}
	if (obj.selector.k === 'target') {
		const tSpec = p.targets[obj.selector.index];
		if (!tSpec || tSpec.kind !== 'object' || tSpec.filter.zone === 'stack') {
			p.targets.length = snapshot;
			return false;
		}
		if (isAnotherTarget) tSpec.filter.other = true;
	}

	const params: NonNullable<EffectStep['params']> = {};
	if (notLegendary) params.notLegendary = true;
	if (copyMod) params.copyMod = copyMod;
	if (tappedAndAttacking) {
		params.tapped = true;
		params.tappedAndAttacking = true;
	} else if (tapped) {
		params.tapped = true;
	}

	const step: EffectStep = {
		verb: 'copyPermanent',
		subject: obj.selector,
		...(amount.k === 'const' && amount.n === 1 ? {} : { amount }),
		...(actor.k !== 'you' ? { actor } : {}),
		...(Object.keys(params).length > 0 ? { params } : {}),
		...opt,
		span
	};
	p.push(step, true);
	return true;
}
// --- End Track P7 ---

/** Verb phrases whose subject is a player ("draws two cards", "loses 2 life", "creates a token"). */
function playerPredicate(p: Parser, subject: Selector, vp: string, span: Span, fromImperative = false): ClauseResult {
	let text = vp.trim();
	if (parsePlayFromExilePredicate(p, subject, text, span)) return true;
	// --- Track P13: Extra land play & player rules ---
	const extraLand = text.match(/^may play (an|a|one|two|three|four|\d+) additional lands? this turn$/i);
	if (extraLand && subject.k === 'player' && subject.filter.relation === 'you') {
		const cWord = extraLand[1].toLowerCase();
		const cnt = cWord === 'a' || cWord === 'an' ? 1 : (count(cWord)?.k === 'const' ? (count(cWord) as { n: number }).n : 0);
		if (cnt < 1) return false;
		p.lastPlayer = subject;
		p.push(
			{
				verb: 'grantPlayer',
				subject,
				params: { playerRules: ['extraLandPlay'], extraLandPlays: cnt, duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	if (
		/^can't lose the game this turn(?: and your opponents can't win the game this turn)?$/i.test(text) &&
		subject.k === 'player' &&
		subject.filter.relation === 'you'
	) {
		p.lastPlayer = subject;
		p.push(
			{
				verb: 'grantPlayer',
				subject,
				params: { playerRules: ['cannotLoseGame'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	// --- End Track P13 ---
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
		// --- Track P10: Non-targeted optional costs ("may tap an untapped ...", "may remove ... counters", "may exert ~") ---
		if (/^(?:tap|taps|remove|removes|exert|exerts)\b/i.test(text) && !/\btarget\b/i.test(text) && !/\bor untap\b/i.test(text)) {
			const costDefs = parseOptionalCostBody(text);
			if (costDefs) {
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
		}
		if (/^shuffles?(?: (?:your|their) library)?$/i.test(text)) {
			const actor = singlePlayer(subject);
			if (!actor) return false;
			p.lastPlayer = subject;
			p.push(
				{
					verb: 'search',
					subject: { k: 'none' },
					amount: n(0),
					...(actor.k !== 'you' ? { actor } : {}),
					params: {
						search: {
							filter: { types: ['Conspiracy'] },
							count: 0,
							upTo: true,
							statedQuality: true,
							destinations: []
						}
					},
					optional,
					span
				},
				false
			);
			return true;
		}
		// --- End Track P10 ---
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
	// --- Track P13: Half life / half library rounded up/down ---
	m = text.match(/^(gains?|loses?) half (?:your|their) life,?\s*rounded (up|down)$/i);
	if (m) {
		const whoRef = singlePlayer(subject);
		if (!whoRef) return false;
		const round: 'up' | 'down' = m[2].toLowerCase() === 'up' ? 'up' : 'down';
		const amount: Amount = { k: 'half', of: { k: 'life', of: whoRef }, round };
		p.push(
			{
				verb: m[1].toLowerCase().startsWith('gain') ? 'gainLife' : 'loseLife',
				subject,
				amount,
				...opt,
				span
			},
			false
		);
		return true;
	}
	m = text.match(/^mills? half (?:your|their) library,?\s*rounded (up|down)$/i);
	if (m) {
		const whoRef = singlePlayer(subject);
		if (!whoRef) return false;
		const round: 'up' | 'down' = m[1].toLowerCase() === 'up' ? 'up' : 'down';
		const amount: Amount = { k: 'half', of: { k: 'cardsIn', zone: 'library', of: whoRef }, round };
		p.push({ verb: 'mill', subject, amount, ...opt, span }, false);
		return true;
	}
	// --- End Track P13 ---
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
		if (!actor) return false;
		if (parseTokenCopyPhrase(p, actor, opt, m[1], span)) return true;
		const tok = tokenPhrase(p, m[1]);
		if (!tok) return false;
		const step: EffectStep = { verb: 'createToken', subject: { k: 'none' }, amount: tok.amount, params: { token: tok.token }, ...opt, span };
		if (actor.k !== 'you') step.actor = actor;
		p.push(step, true);
		return true;
	}
	if (/^search(?:es)? (?:their|your|that player's|target player's|target opponent's) (?:library|graveyard)\b/i.test(text)) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const normalizedSearch = text.replace(/^searches/i, 'search');
		const search =
			(/^search (?:their|your) library\b/i.test(normalizedSearch) ? searchClause(normalizedSearch) : null) ??
			extendedSearchClause(p, normalizedSearch);
		if (!search) return false;
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
	// Step E2 / Track P7: "sacrifices a creature", "sacrifices a creature of their choice", "each player sacrifices ...": the player chooses (CR 701.21a).
	m = text.match(/^sacrifices? (that many|another|a|an|one|two|three|four|five|six|\d+) (.+?)(?:\s+of (?:their|your) choice)?$/);
	if (m) {
		const isAnother = m[1].toLowerCase() === 'another';
		const amount = isAnother ? n(1) : amountWord(p, m[1] === 'a' || m[1] === 'an' ? 'one' : m[1]);
		const rawSacPhrase = m[2].replace(/\s+you control$/i, '').trim();
		const filter = amount && objectFilter(rawSacPhrase);
		if (!amount || !filter || filter.zone || filter.controller) return false;
		const step: EffectStep = {
			verb: 'sacrifice',
			subject: {
				k: 'all',
				filter: { ...filter, ...(isAnother ? { other: true } : {}), zone: 'battlefield' }
			},
			amount,
			...opt,
			span
		};
		const actor = singlePlayer(subject);
		if (subject.k === 'player' && subject.filter.relation === 'each_opponent') {
			(step.subject as { filter: ObjectFilter }).filter.controller = 'opponent';
		} else if (subject.k === 'player' && subject.filter.relation === 'each_player') {
			(step.subject as { filter: ObjectFilter }).filter.controller = 'any';
		} else if (actor && actor.k !== 'you') {
			step.actor = actor;
		} else if (!actor) {
			return false;
		}
		p.push(step, true);
		return true;
	}
	// --- Track P7: Wheel ("discards their hand[, then draws seven/that many cards]") & random discard ---
	m = text.match(
		/^discards? (?:their|your|all the cards in (?:their|your)) hands?(?:,?\s*(?:then|and) draws? (that many|\S+) cards?)?$/
	);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		let drawAfter: Amount | 'thatMany' | undefined;
		if (m[1] !== undefined) {
			if (m[1] === 'that many') {
				drawAfter = 'thatMany';
			} else {
				const parsed = count(m[1]);
				if (!parsed) return false;
				drawAfter = parsed;
			}
		}
		p.push(
			{
				verb: 'discard',
				subject,
				...(drawAfter !== undefined ? { params: { drawAfterDiscardHand: drawAfter } } : {}),
				...opt,
				span
			},
			true
		);
		// Keep verb as 'discardHand' directly on the pushed step:
		p.steps[p.steps.length - 1].verb = 'discardHand';
		return true;
	}
	// --- End Track P7 ---
	// Step E2 / Track P7: "discards two cards", "discards a card at random" (CR 701.8b / 701.8c).
	m = text.match(/^discards? (that many|\S+) cards?( at random)?$/);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push(
			{
				verb: 'discard',
				subject,
				amount,
				...(m[2] ? { params: { atRandom: true } } : {}),
				...opt,
				span
			},
			true
		);
		return true;
	}
	// --- Track P10: Typed discard, hand/graveyard filtered exile, CR 701 keyword actions, coin flip & die roll ---
	m = text.match(/^discards? (a|an|one|two|three|four|\d+|that many) (.+? cards?)$/i);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor || actor.k !== 'you') return false;
		const cntRaw = m[1].toLowerCase() === 'a' || m[1].toLowerCase() === 'an' ? 'one' : m[1];
		const amount = amountWord(p, cntRaw);
		const filter = amount ? objectFilter(m[2]) : null;
		if (!amount || !filter || filter.zone || filter.controller) return false;
		p.push(
			{
				verb: 'discard',
				subject: { k: 'all', filter: { ...filter, zone: 'hand', owner: 'you' } },
				amount,
				...opt,
				span
			},
			true
		);
		return true;
	}
	m = text.match(/^exiles? (a|an|one|two|three|four|\d+) (.+?) from (your|their) (graveyard|hand)$/i);
	if (m && optional) {
		const actor = singlePlayer(subject);
		if (!actor || actor.k !== 'you') return false;
		const cntRaw = m[1].toLowerCase() === 'a' || m[1].toLowerCase() === 'an' ? 'one' : m[1];
		const amount = count(cntRaw);
		const zone = m[4].toLowerCase() as 'graveyard' | 'hand';
		const rawCardPhrase = /\bcards?$/i.test(m[2].trim()) ? m[2].trim() : `${m[2].trim()} card`;
		const filter = amount ? objectFilter(rawCardPhrase) : null;
		if (!amount || !filter || filter.zone || filter.controller) return false;
		if (zone === 'graveyard') {
			const costDefs = parseOptionalCostBody(`exile ${m[1]} ${rawCardPhrase} from your graveyard`);
			if (costDefs) {
				p.push(
					{
						verb: 'payCost',
						subject: { k: 'none' },
						optional: { chooser: actor, cost: costDefs, mode: 'doIfPaid' },
						span
					},
					false
				);
				return true;
			}
		}
		p.push(
			{
				verb: 'exile',
				subject: { k: 'all', filter: { ...filter, zone, owner: 'you' } },
				amount,
				...opt,
				span
			},
			true
		);
		return true;
	}
	m = text.match(/^discovers? (that much|that many|\S+)$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		const idx = p.push({ verb: 'discover', subject: { k: 'none' }, amount, ...opt, span }, true);
		p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(/^clash(?:es)? with (an opponent|target opponent)$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		let subj: Selector = { k: 'none' };
		if (m[1].toLowerCase() === 'target opponent') {
			const tSel = playerPhrase(p, 'target opponent');
			if (!tSel) return false;
			p.lastPlayer = tSel;
			subj = tSel;
		}
		const idx = p.push({ verb: 'clash', subject: subj, ...opt, span }, false);
		p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(/^detains? (.+)$/i);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor || actor.k !== 'you') return false;
		const isAnotherTarget = /^another target\b/i.test(m[1]);
		const obj = objectPhrase(p, isAnotherTarget ? m[1].replace(/^another /i, '') : m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target') {
			const tSpec = p.targets[obj.selector.index];
			if (!tSpec || tSpec.kind !== 'object' || (tSpec.filter.zone ?? 'battlefield') !== 'battlefield') return false;
			if (isAnotherTarget) tSpec.filter.other = true;
		}
		p.push({ verb: 'detain', subject: obj.selector, ...opt, span }, true);
		return true;
	}
	m = text.match(/^suspects? (.+)$/i);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor || actor.k !== 'you') return false;
		const isAnotherTarget = /^another target\b/i.test(m[1]);
		const obj = objectPhrase(p, isAnotherTarget ? m[1].replace(/^another /i, '') : m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target') {
			const tSpec = p.targets[obj.selector.index];
			if (!tSpec || tSpec.kind !== 'object' || (tSpec.filter.zone ?? 'battlefield') !== 'battlefield') return false;
			if (isAnotherTarget) tSpec.filter.other = true;
		}
		p.push({ verb: 'suspect', subject: obj.selector, ...opt, span }, true);
		return true;
	}
	m = text.match(/^collects? evidence (that much|that many|\S+)$/i);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		const actor = singlePlayer(subject);
		const idx = p.push(
			{
				verb: 'collectEvidence',
				subject,
				...(actor && actor.k !== 'you' ? { actor } : {}),
				amount,
				...opt,
				span
			},
			true
		);
		if (optional) p.lastOptionalStep = idx;
		return true;
	}
	if (/^forages?$/i.test(text) && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const actor = singlePlayer(subject);
		const idx = p.push(
			{
				verb: 'forage',
				subject,
				...(actor && actor.k !== 'you' ? { actor } : {}),
				...opt,
				span
			},
			true
		);
		if (optional) p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(/^endures? (that many|that much|\S+)$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'endure', subject: { k: 'self' }, amount, ...opt, span }, true);
		return true;
	}
	m = text.match(/^time travels?(?: (once|twice|(that many|\S+) times?))?$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		let amount: Amount | null = n(1);
		if (m[1]) {
			if (m[1].toLowerCase() === 'once') amount = n(1);
			else if (m[1].toLowerCase() === 'twice') amount = n(2);
			else amount = amountWord(p, m[2]);
		}
		if (!amount) return false;
		p.push({ verb: 'timeTravel', subject: { k: 'none' }, amount, ...opt, span }, false);
		return true;
	}
	m = text.match(/^blights? (that many|that much|\S+)$/i);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		const actor = singlePlayer(subject);
		const idx = p.push(
			{
				verb: 'blight',
				subject,
				...(actor && actor.k !== 'you' ? { actor } : {}),
				amount,
				...opt,
				span
			},
			true
		);
		if (optional) p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(/^fateseals? (that many|\S+)$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const amount = amountWord(p, m[1]);
		if (!amount) return false;
		p.push({ verb: 'fateseal', subject: { k: 'none' }, amount, ...opt, span }, false);
		return true;
	}
	if (/^flips? a coin until you lose a flip$/i.test(text) && subject.k === 'player' && subject.filter.relation === 'you') {
		const idx = p.push(
			{ verb: 'flipCoin', subject: { k: 'none' }, params: { coinFlipUntilLose: true }, ...opt, span },
			false
		);
		p.lastCoinFlipStep = idx;
		p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(/^flips? (a|one|two|three|four|five|\d+|that many) coins?$/i);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const cntWord = m[1].toLowerCase() === 'a' ? 'one' : m[1];
		const amount = amountWord(p, cntWord);
		if (!amount) return false;
		const idx = p.push({ verb: 'flipCoin', subject: { k: 'none' }, amount, ...opt, span }, false);
		p.lastCoinFlipStep = idx;
		p.lastOptionalStep = idx;
		return true;
	}
	m = text.match(
		/^rolls? a (?:d(4|6|8|10|12|20)|(four|six|eight|ten|twelve|twenty|4|6|8|10|12|20)-sided die)(?: and adds? (.+?))?$/i
	);
	if (m && subject.k === 'player' && subject.filter.relation === 'you') {
		const rawSides = (m[1] ?? m[2]).toLowerCase();
		const dieSides = /^\d+$/.test(rawSides) ? parseInt(rawSides, 10) : (NUMBER_WORDS[rawSides] ?? 0);
		if (!dieSides) return false;
		let dieBonus: Amount | undefined;
		if (m[3]) {
			const bonusRaw = m[3].trim();
			dieBonus = count(bonusRaw) ?? equalTo(p, bonusRaw) ?? numberOf(bonusRaw.replace(/^the number of\s+/i, '')) ?? undefined;
			if (!dieBonus) return false;
		}
		p.push(
			{
				verb: 'rollDie',
				subject: { k: 'none' },
				params: { dieSides, ...(dieBonus ? { dieBonus } : {}) },
				...opt,
				span
			},
			false
		);
		return true;
	}
	// --- End Track P10 ---
	// --- Track P13: Player hexproof / protection & cross-turn gainControl ---
	m = text.match(/^gains? (hexproof|protection from everything) (until end of turn|until your next turn)$/i);
	if (m && (subject.k === 'player' || singlePlayer(subject) !== null)) {
		const rule = m[1].toLowerCase() === 'hexproof' ? 'hexproof' : 'protectionFromEverything';
		const duration: Duration =
			m[2].toLowerCase() === 'until your next turn' ? 'untilYourNextTurn' : 'endOfTurn';
		p.push(
			{
				verb: 'grantPlayer',
				subject,
				params: { playerRules: [rule], duration },
				...opt,
				span
			},
			false
		);
		return true;
	}
	// --- End Track P13 ---
	m = text.match(
		/^gains? control of (.+?)(?: (until end of turn|until your next turn|until (?:the )?end of your next turn|for as long as (?:you control ~|~ remains on the battlefield)))?$/
	);
	if (m) {
		const actor = singlePlayer(subject);
		if (!actor) return false;
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target' && p.targets[obj.selector.index]?.kind === 'player') {
			return false;
		}
		const durRaw = m[2]?.toLowerCase();
		const duration: Duration =
			durRaw === 'until end of turn'
				? 'endOfTurn'
				: durRaw === 'until your next turn'
					? 'untilYourNextTurn'
					: durRaw?.startsWith('until ') && durRaw.endsWith('next turn')
						? 'untilEndOfYourNextTurn'
						: durRaw?.startsWith('for as long as')
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
			if (p.steps.length > before) p.lastOptionalStep = p.steps.length - 1;
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
		if (p.steps.length > before) p.lastOptionalStep = p.steps.length - 1;
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

// --- Track P7: Damage prevention shield parser (CR 615.1–11) ---
function parsePreventionSource(p: Parser, rawSrc: string): Selector | null {
	const s = rawSrc.trim();
	if (s === 'creatures') {
		return { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } };
	}
	if (s === 'attacking creatures') {
		return { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], attacking: true } };
	}
	const snapshot = p.targets.length;
	const obj = objectPhrase(p, s);
	if (!obj || obj.fromZone || obj.selector.k === 'all') {
		p.targets.length = snapshot;
		return null;
	}
	if (obj.selector.k === 'target') {
		const tSpec = p.targets[obj.selector.index];
		if (
			!tSpec ||
			tSpec.kind !== 'object' ||
			(tSpec.filter.zone ?? 'battlefield') !== 'battlefield' ||
			tSpec.max !== 1
		) {
			p.targets.length = snapshot;
			return null;
		}
	}
	return obj.selector;
}

function parsePreventDamageClause(p: Parser, text: string, span: Span): boolean {
	if (!/^prevent\b/.test(text)) return false;
	let core = text;
	let hasTurnDuration = false;
	const endTurn = core.match(/^(.+?) (?:this turn|until end of turn)$/);
	if (endTurn) {
		core = endTurn[1].trim();
		hasTurnDuration = true;
	} else if (/\bthat would be dealt this turn\b/.test(core)) {
		core = core.replace(/\bthat would be dealt this turn\b/, 'that would be dealt').trim();
		hasTurnDuration = true;
	}
	if (!hasTurnDuration) return false;

	const snapshot = p.mark();
	const rollbackFail = (): false => {
		p.rollback(snapshot);
		return false;
	};

	let m = core.match(/^prevent all (combat )?damage that would be dealt(?: by (.+))?$/);
	if (m) {
		const fromSource = m[2] ? parsePreventionSource(p, m[2]) : undefined;
		if (m[2] && !fromSource) return rollbackFail();
		const preventSpec: DamagePreventionSpec = {
			mode: 'all',
			combatOnly: Boolean(m[1]),
			scope: 'any',
			...(fromSource ? { fromSource } : {})
		};
		p.push({ verb: 'preventDamage', subject: { k: 'none' }, params: { preventSpec }, span }, false);
		return true;
	}

	m = core.match(/^prevent all (combat )?damage (.+?) would deal$/);
	if (m) {
		const fromSource = parsePreventionSource(p, m[2]);
		if (!fromSource) return rollbackFail();
		const preventSpec: DamagePreventionSpec = {
			mode: 'all',
			combatOnly: Boolean(m[1]),
			scope: 'any',
			fromSource
		};
		p.push({ verb: 'preventDamage', subject: { k: 'none' }, params: { preventSpec }, span }, false);
		return true;
	}

	m = core.match(
		/^prevent (all|the next (that much|that many|\S+)) (combat )?damage that would be dealt to you and creatures you control(?: by (.+))?$/
	);
	if (m) {
		const isAll = m[1] === 'all';
		const amount = isAll ? undefined : amountWord(p, m[2]) ?? undefined;
		if (!isAll && !amount) return rollbackFail();
		const fromSource = m[4] ? parsePreventionSource(p, m[4]) : undefined;
		if (m[4] && !fromSource) return rollbackFail();
		const preventSpec: DamagePreventionSpec = {
			mode: isAll ? 'all' : 'next',
			combatOnly: Boolean(m[3]),
			scope: 'youAndCreaturesYouControl',
			...(fromSource ? { fromSource } : {})
		};
		p.push(
			{
				verb: 'preventDamage',
				subject: { k: 'none' },
				...(amount ? { amount } : {}),
				params: { preventSpec },
				span
			},
			false
		);
		return true;
	}

	m = core.match(/^prevent all (combat )?damage that would be dealt to and dealt by (.+)$/);
	if (m) {
		const obj = objectPhrase(p, m[2]);
		if (!obj || obj.fromZone) return rollbackFail();
		if (obj.selector.k === 'target') {
			const tSpec = p.targets[obj.selector.index];
			if (!tSpec || tSpec.kind !== 'object' || (tSpec.filter.zone ?? 'battlefield') !== 'battlefield') {
				return rollbackFail();
			}
		}
		const preventSpec: DamagePreventionSpec = {
			mode: 'all',
			combatOnly: Boolean(m[1]),
			scope: 'subject',
			alsoPreventDealtBySubject: true
		};
		p.push({ verb: 'preventDamage', subject: obj.selector, params: { preventSpec }, span }, true);
		return true;
	}

	m = core.match(
		/^prevent (all|the next (that much|that many|\S+)) (combat )?damage that would be dealt to (.+?)(?: by (.+))?$/
	);
	if (m) {
		const isAll = m[1] === 'all';
		const amount = isAll ? undefined : amountWord(p, m[2]) ?? undefined;
		if (!isAll && !amount) return rollbackFail();

		const recRaw = m[4].trim();
		let recSelector: Selector | null = playerPhrase(p, recRaw);
		let actsOnObj = false;
		if (!recSelector) {
			const obj = objectPhrase(p, recRaw);
			if (!obj || obj.fromZone) return rollbackFail();
			if (!isAll && obj.selector.k === 'all' && !/^each\b/.test(recRaw)) {
				return rollbackFail();
			}
			if (obj.selector.k === 'target') {
				const tSpec = p.targets[obj.selector.index];
				if (!tSpec || (tSpec.filter.zone && tSpec.filter.zone !== 'battlefield')) {
					return rollbackFail();
				}
				if (tSpec.kind === 'object') {
					actsOnObj = true;
				} else if (obj.ref) {
					p.setLastTarget(obj.ref);
				}
			} else {
				actsOnObj = true;
			}
			recSelector = obj.selector;
		}

		const fromSource = m[5] ? parsePreventionSource(p, m[5]) : undefined;
		if (m[5] && !fromSource) return rollbackFail();

		const preventSpec: DamagePreventionSpec = {
			mode: isAll ? 'all' : 'next',
			combatOnly: Boolean(m[3]),
			scope: 'subject',
			...(fromSource ? { fromSource } : {})
		};
		p.push(
			{
				verb: 'preventDamage',
				subject: recSelector,
				...(amount ? { amount } : {}),
				params: { preventSpec },
				span
			},
			actsOnObj
		);
		return true;
	}

	return rollbackFail();
}
// --- End Track P7 ---

function tryP13Clause(p: Parser, text: string, span: Span): boolean {
	const mark = p.mark();
	const steps = tryParseP13Sentence(text, {
		addTarget: (spec) => p.addTarget(spec),
		subjectSelector: (phrase) => {
			const strippedEach = phrase.replace(/^each of\s+/i, '');
			const isAnother = /^another target\b/i.test(strippedEach);
			const obj = objectPhrase(p, isAnother ? strippedEach.replace(/^another /i, '') : strippedEach);
			if (!obj) return null;
			if (isAnother && obj.selector.k === 'target') {
				p.targets[obj.selector.index].filter.other = true;
			}
			return { sel: obj.selector, bind: true };
		},
		playerSubject: (phrase) => playerPhrase(p, phrase),
		validateEmblemAbility: (q) => isSupportedEmblemQuotedAbility(q),
		parseSubSteps: (subText) => {
			const sub = parseEffects(subText, span.start, 'triggered', p.trigger);
			if (sub.unparsed.length > 0 || sub.targets.length > 0 || sub.steps.length === 0) {
				return null;
			}
			return sub.steps;
		},
		parseAmount: (amtText) =>
			amountWord(p, amtText.toLowerCase()) ??
			equalTo(p, amtText) ??
			parseP13Amount(
				amtText,
				(sub) => equalTo(p, sub) ?? numberOf(sub) ?? amountWord(p, sub.toLowerCase())
			),
		parseDuration: (raw) => {
			const sd = stripDuration(raw);
			return { body: sd.text, duration: sd.duration };
		}
	});
	if (!steps || steps.length === 0) {
		p.rollback(mark);
		return false;
	}
	for (const st of steps) {
		const actsOnObj = Boolean(st.bindAs);
		const { bindAs: _unusedBind, ...restStep } = st;
		p.push({ ...restStep, span }, actsOnObj);
	}
	return true;
}

/** Clauses without a subject: "Destroy target creature", "Draw a card", "Create a Treasure token". */
function imperative(p: Parser, text: string, span: Span): ClauseResult {
	const t = text.trim();
	let m: RegExpMatchArray | null;

	// --- Track P13: Imperative P13 keyword actions & designations ---
	if (tryP13Clause(p, t, span)) return true;
	// --- End Track P13 ---

	// --- Track P7: Damage prevention shields & CR 615.12 unpreventable damage ---
	if (parsePreventDamageClause(p, t, span)) return true;
	if (t === "damage can't be prevented this turn") {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['damageCantBePrevented'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	if (t === "combat damage can't be prevented this turn") {
		p.push(
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['combatDamageCantBePrevented'], duration: 'endOfTurn' },
				span
			},
			false
		);
		return true;
	}
	// --- End Track P7 ---

	if (
		/^(?:draw|gain|lose|mill|create|search|take|scry|surveil|sacrifice|discard|investigate|goad|amass|incubate|populate|manifest|cloak|bolster|discover|clash|detain|suspect|collect evidence|forage|endure|time travel|blight|fateseal|roll a (?:d(?:4|6|8|10|12|20)|(?:four|six|eight|ten|twelve|twenty|\d+)-sided die))\b/i.test(
			t
		) &&
		!/^lose hexproof/.test(t)
	) {
		return playerPredicate(p, YOU, t, span, true);
	}
	if (/^flip (?:a |one |two |three |four |five |\d+ |that many )?coins?\b/i.test(t)) {
		return playerPredicate(p, YOU, t, span, true);
	}
	if (/^shuffle(?: your library)?$/i.test(t)) {
		p.push(
			{
				verb: 'search',
				subject: { k: 'none' },
				amount: n(0),
				params: {
					search: {
						filter: { types: ['Conspiracy'] },
						count: 0,
						upTo: true,
						statedQuality: true,
						destinations: []
					}
				},
				span
			},
			false
		);
		return true;
	}
	if (t === 'proliferate') {
		p.push({ verb: 'proliferate', subject: { k: 'none' }, span }, false);
		return true;
	}
	if (t === 'end the turn') {
		p.push({ verb: 'endTurn', subject: { k: 'none' }, span }, false);
		return true;
	}
	// --- Track P10: Generalized `attach` (CR 701.3a–d, CR 613.7e) ---
	m = t.match(/^attach(?: (.+?))? to (.+)$/);
	if (m) {
		const snapshot = p.mark();
		const rawAttachment = m[1]?.trim();
		let attachObject: Selector | undefined;
		if (rawAttachment && rawAttachment !== '~') {
			const attObj = objectPhrase(p, rawAttachment);
			if (!attObj || attObj.fromZone) {
				p.rollback(snapshot);
				return false;
			}
			if (attObj.selector.k === 'target') {
				const attSpec = p.targets[attObj.selector.index];
				if (!attSpec || attSpec.kind !== 'object' || (attSpec.filter.zone ?? 'battlefield') !== 'battlefield') {
					p.rollback(snapshot);
					return false;
				}
			}
			if (attObj.selector.k !== 'self') {
				attachObject = attObj.selector;
			}
		}
		const isAnotherHost = /^another target\b/i.test(m[2]);
		const obj = objectPhrase(p, isAnotherHost ? m[2].replace(/^another /i, '') : m[2]);
		if (!obj || obj.fromZone) {
			p.rollback(snapshot);
			return false;
		}
		if (obj.selector.k === 'target') {
			const hostSpec = p.targets[obj.selector.index];
			if (!hostSpec || hostSpec.kind !== 'object' || (hostSpec.filter.zone ?? 'battlefield') !== 'battlefield') {
				p.rollback(snapshot);
				return false;
			}
			if (isAnotherHost) {
				if (attachObject?.k === 'target') hostSpec.otherTarget = true;
				else hostSpec.filter.other = true;
			}
		} else if (obj.selector.k !== 'binding' && obj.selector.k !== 'eventObject' && obj.selector.k !== 'attachedTo') {
			p.rollback(snapshot);
			return false;
		}
		p.push(
			{
				verb: 'attach',
				subject: obj.selector,
				...(attachObject ? { params: { attachObject } } : {}),
				span
			},
			true
		);
		return true;
	}
	// --- End Track P10 ---
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
	// --- Track P7: Distribute counters among targets (CR 601.2d) ---
	m = t.match(/^distribute (that many|\S+) (\S+) counters? among (.+)$/);
	if (m) {
		const amount = amountWord(p, m[1]);
		const counter = COUNTER_WORDS[m[2]];
		if (!amount || !counter) return false;
		const divTarget = parseDividedTargets(p, m[3], amount, true);
		if (!divTarget) return false;
		p.push(
			{ verb: 'putCounters', subject: divTarget, amount, params: { counter, divided: true }, span },
			true
		);
		return true;
	}
	// --- End Track P7 ---
	// --- Track P13: Generalized putCounters & removeCounters ---
	m = t.match(
		/^put (?:a|the) number of ([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) counters? on (.+?) equal to (.+)$/i
	);
	if (m) {
		const counter = COUNTER_WORDS[m[1].toLowerCase()];
		const rawObj = m[2].replace(/^each of\s+/i, '');
		const isAnother = /^another target\b/i.test(rawObj);
		const obj = counter ? objectPhrase(p, isAnother ? rawObj.replace(/^another /i, '') : rawObj) : null;
		const amount = obj ? equalTo(p, m[3].trim()) : null;
		if (!counter || !obj || !amount || obj.fromZone) return false;
		if (isAnother && obj.selector.k === 'target') p.targets[obj.selector.index].filter.other = true;
		p.push({ verb: 'putCounters', subject: obj.selector, amount, params: { counter }, span }, true);
		return true;
	}
	m = t.match(
		/^put (that many|that much|\S+) ([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) counters? on (.+)$/i
	);
	if (m) {
		const amount = amountWord(p, m[1].toLowerCase());
		const counter = COUNTER_WORDS[m[2].toLowerCase()];
		const rawObj = m[3].replace(/^each of\s+/i, '');
		const isAnother = /^another target\b/i.test(rawObj);
		const obj = amount && counter ? objectPhrase(p, isAnother ? rawObj.replace(/^another /i, '') : rawObj) : null;
		if (!amount || !counter || !obj || obj.fromZone) return false;
		if (isAnother && obj.selector.k === 'target') p.targets[obj.selector.index].filter.other = true;
		p.push({ verb: 'putCounters', subject: obj.selector, amount, params: { counter }, span }, true);
		return true;
	}
	m = t.match(
		/^remove (all|that many|\S+) ([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) counters? from (.+)$/i
	);
	if (m) {
		const isAll = m[1].toLowerCase() === 'all';
		const amount = isAll ? n(999) : amountWord(p, m[1].toLowerCase());
		const counter = COUNTER_WORDS[m[2].toLowerCase()];
		const rawObj = m[3].replace(/^each of\s+/i, '');
		const isAnother = /^another target\b/i.test(rawObj);
		const obj = amount && counter ? objectPhrase(p, isAnother ? rawObj.replace(/^another /i, '') : rawObj) : null;
		if (!amount || !counter || !obj || obj.fromZone) return false;
		if (isAnother && obj.selector.k === 'target') p.targets[obj.selector.index].filter.other = true;
		p.push({ verb: 'removeCounters', subject: obj.selector, amount, params: { counter }, span }, true);
		return true;
	}
	// --- End Track P13 ---
	m = t.match(/^switch (.+?)'s power and toughness until end of turn$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		p.push({ verb: 'switchPT', subject: obj.selector, params: { duration: 'endOfTurn' }, span }, true);
		return true;
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
	m = t.match(/^(look at|reveal) the top (?:(that many|\S+) )?cards? of your library$/);
	if (m) {
		const amount = m[2] ? amountWord(p, m[2]) : n(1);
		if (!amount) return false;
		const isLook = m[1] === 'look at';
		const stepIndex = p.push({ verb: 'dig', subject: YOU, amount, span }, false);
		p.pendingDig = {
			stepIndex,
			hasKeep: false,
			hasRest: false,
			...(isLook ? { lookOnly: true } : {}),
			draft: {
				keep: 0,
				upTo: false,
				keepTo: 'hand',
				rest: 'libraryBottom',
				...(!isLook ? { revealAll: true } : {})
			}
		};
		return true;
	}
	m = t.match(/^(look at|reveal) the top card of (target player's|target opponent's|that player's|their) library$/i);
	if (m) {
		const isLook = m[1].toLowerCase() === 'look at';
		const ownerKey = m[2].toLowerCase();
		const pPhrase =
			ownerKey === "target player's"
				? 'target player'
				: ownerKey === "target opponent's"
					? 'target opponent'
					: ownerKey === "that player's"
						? 'that player'
						: 'they';
		const sel = playerPhrase(p, pPhrase);
		const pr = sel ? singlePlayer(sel) : null;
		if (!pr) return false;
		if (ownerKey.startsWith('target ')) p.lastPlayer = sel!;
		p.push(
			{
				verb: 'reveal',
				subject: { k: 'libraryTop', ...(pr.k !== 'you' ? { player: pr } : {}) },
				...(isLook ? { params: { lookOnly: true } } : {}),
				span
			},
			true
		);
		return true;
	}
	// --- Track P10: "Reveal cards from the top of your library until you reveal a [filter] card" ---
	m = t.match(/^reveal cards from the top of your library until you reveal (?:a|an) (.+?) card$/i);
	if (m) {
		const untilFilter = objectFilter(`${m[1].trim()} card`);
		if (!untilFilter) return false;
		const stepIndex = p.push({ verb: 'dig', subject: YOU, amount: n(999), span }, true);
		p.pendingDig = {
			stepIndex,
			hasKeep: false,
			hasRest: false,
			draft: {
				keep: 1,
				upTo: false,
				keepTo: 'hand',
				rest: 'libraryBottom',
				revealAll: true,
				untilFilter
			}
		};
		return true;
	}
	// --- End Track P10 ---
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
	m = t.match(/^(that much|that many|\S+) mana of any (?:one )?color$/i);
	if (m) {
		const amt = amountWord(p, m[1].toLowerCase());
		if (amt) {
			p.push({ verb: 'addMana', subject: { k: 'none' }, amount: amt, params: { manaChoice: 'any' }, span }, false);
			return true;
		}
	}
	m = t.match(/^(that much|that many|\S+) mana of any (?:one )?color in your commander's color identity$/i);
	if (m) {
		const amt = amountWord(p, m[1].toLowerCase());
		if (amt) {
			p.push({ verb: 'addMana', subject: { k: 'none' }, amount: amt, params: { manaChoice: 'commanderIdentity' }, span }, false);
			return true;
		}
	}
	m = t.match(/^(that much|that many|\S+)\s+\{([WUBRGC])\}$/i);
	if (m) {
		const amt = amountWord(p, m[1].toLowerCase());
		if (amt) {
			p.push(
				{ verb: 'addMana', subject: { k: 'none' }, amount: amt, params: { mana: [m[2].toUpperCase() as ManaColor] }, span },
				false
			);
			return true;
		}
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
	/^(?:you|each opponent|each player|target player|target opponent|its controller|its owner|(?:that|the exiled) (?:card|creature|permanent|spell)'s (?:controller|owner)|that player|they|it (?=deals|fights?|gets?|gains?|loses?|explores?|connives?|adapts?|phases?|becomes?|endures?|is |can't|doesn't|does not)|that creature |those creatures |that permanent |those permanents |that target |those targets |that creature or planeswalker |that permanent or player |the amassed [Aa]rmy |the ring tempts you|enchanted |equipped |until (?:end of turn|your next turn|(?:the )?end of your next turn|your next end step), |for as long as |draw|draws|lose|loses|gain|gains|get|gets|become|becomes|put|remove|exile|exert|exerts|destroy|return|create|creates|search|scry|surveil|surveils|investigate|investigates|mill|mills|sacrifice|deal|deals|add|take|takes|phase|phases|attach|counter|proliferate|switch|look|reveal|reveals|shuffle|shuffles|tap|untap|fight|fights|transform|transforms|convert|converts|flip|flips|roll|rolls|discover|discovers|clash|clashes|detain|detains|suspect|suspects|collect|collects|forage|forages|endure|endures|time|blight|blights|fateseal|fateseals|discard|discards|connive|connives|explore|explores|goad|goads|regenerate|regenerates|amass|amasses|incubate|incubates|populate|populates|manifest|manifests|cloak|cloaks|bolster|bolsters|monstrosity|support|adapt|adapts|prevent|prevents|distribute|distributes|choose|double|triple|exchange|turn|venture|ventures|earthbend|airbend|learn|learns|damage|combat|after|there)\b/i;

/** Splits a sentence into clauses at ", then " and at " and " before a new verb or subject. */
function splitClauses(text: string, offset: number): Clause[] {
	const out: Clause[] = [];
	const re = /,? then |,? and /g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (isInsideQuotes(text, m.index)) continue;
		const after = text.slice(m.index + m[0].length);
		if (!CLAUSE_START.test(after)) continue;
		// "gain trample and get +X/+X" / "get +X/+Y and gain trample" stay one clause (handled by objectPredicate).
		if (/^gets? /.test(after) && /gains? [a-z ]+$/.test(text.slice(last, m.index))) continue;
		if (/^(?:gains?|has|have) /.test(after) && /\bgets? [+\-−](?:\d+|X)\/[+\-−](?:\d+|X)$/.test(text.slice(last, m.index))) continue;
		// "rolls a d20 / six-sided die and adds ..." stays one clause.
		if (
			/^adds?\b/i.test(after) &&
			/\brolls? a (?:d(?:4|6|8|10|12|20)|(?:four|six|eight|ten|twelve|twenty|\d+)-sided die)$/i.test(
				text.slice(last, m.index)
			)
		) {
			continue;
		}
		// Wheel ("discards their hand, then draws seven/that many cards") stays one clause so "that many" is per-player.
		if (
			/^draws? (?:that many|\S+) cards?$/i.test(after) &&
			/\bdiscards? (?:their|your|all the cards in (?:their|your)) hands?$/i.test(text.slice(last, m.index))
		) {
			continue;
		}
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

// --- Track P7 / P13: Turn-history, state, & cast-origin resolution-time condition helpers ---
function isP7ResolutionCondition(cond: Condition): boolean {
	if (cond.k === 'not') return isP7ResolutionCondition(cond.of);
	if (cond.k === 'and' || cond.k === 'or') return cond.of.every(isP7ResolutionCondition);
	return (
		cond.k === 'creatureDiedThisTurn' ||
		cond.k === 'attackedThisTurn' ||
		cond.k === 'permanentLeftBattlefieldThisTurn' ||
		cond.k === 'gainedLifeThisTurn' ||
		cond.k === 'wasCast' ||
		// --- Track P10 ---
		cond.k === 'opponentLostLifeThisTurn' ||
		cond.k === 'descendedThisTurn' ||
		cond.k === 'manaColorSpentToCast' ||
		cond.k === 'opponentComparison' ||
		// --- Track P13 ---
		cond.k === 'controlCommander' ||
		cond.k === 'isTurnOf' ||
		cond.k === 'isMonarch' ||
		cond.k === 'hasCompletedDungeon' ||
		cond.k === 'hasInitiative' ||
		cond.k === 'hasCitysBlessing' ||
		cond.k === 'hasMaxSpeed' ||
		cond.k === 'opponentPoisonAtLeast' ||
		cond.k === 'nonlandEnteredThisTurn' ||
		cond.k === 'voidThisTurn' ||
		cond.k === 'sameColorManaSpentAtLeast' ||
		cond.k === 'spellsCastLastTurn' ||
		cond.k === 'totalPowerControlled' ||
		cond.k === 'distinctControlledCreaturePowers' ||
		cond.k === 'colorsAmongControlledPermanents' ||
		cond.k === 'cardsPutIntoGraveyardFromAnywhereThisTurn' ||
		cond.k === 'spellsCastThisTurnCount' ||
		cond.k === 'boastAttackedThisTurn' ||
		cond.k === 'objectState' ||
		cond.k === 'matchesFilter' ||
		cond.k === 'selfInZone' ||
		cond.k === 'compare'
		// --- End Track P13 ---
	);
}

function tryReplacementIfSentence(
	p: Parser,
	innerClauseText: string,
	cond: Condition,
	stepsBefore: number,
	targetsBefore: number,
	span: Span
): boolean {
	if (stepsBefore !== 1) return false;
	const baseStep = p.steps[0];
	if (!baseStep || baseStep.condition || baseStep.optional) return false;

	const savedMark = p.mark();
	let directRef: Ref | null = null;
	const subj = baseStep.subject;
	if (subj.k === 'target') directRef = { k: 'target', index: subj.index };
	else if (subj.k === 'self') directRef = { k: 'self' };
	else if (subj.k === 'eventObject') directRef = { k: 'eventObject' };
	else if (subj.k === 'attachedTo') directRef = { k: 'attachedTo' };

	if (directRef) {
		p.lastObject = { ref: directRef, stepIndex: -1 };
		delete baseStep.bindAs;
	}

	let normInner = innerClauseText.trim();
	if (/^[A-Z][a-z]*\b/.test(normInner) && LOWER_START.has(normInner.split(/[\s,']/)[0].toLowerCase())) {
		normInner = normInner.charAt(0).toLowerCase() + normInner.slice(1);
	}
	normInner = normInner.replace(/^it deals\b/i, '~ deals');

	if (
		!clause(p, { text: normInner, span }, false) ||
		p.steps.length !== 2 ||
		p.targets.length !== targetsBefore ||
		p.steps[1].verb !== baseStep.verb ||
		Boolean(p.steps[1].optional)
	) {
		p.rollback(savedMark);
		return false;
	}

	const negCond: Condition = cond.k === 'not' ? cond.of : { k: 'not', of: cond };
	baseStep.condition = negCond;
	p.steps[1].condition = cond;
	p.lastObject = directRef ? { ref: directRef, stepIndex: -1 } : undefined;
	return true;
}
// --- End Track P7 ---

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
	// --- Track P7: "unless you attacked this turn" / "unless a creature died this turn" / etc. ---
	const p7UnlessCond = parseCondition(`if ${tail}`, { allowDungeonCompletion: true });
	if (p7UnlessCond && isP7ResolutionCondition(p7UnlessCond)) {
		const normalizedBase =
			/^sacrifice it$/i.test(baseText) && !p.lastObject ? 'sacrifice ~' : baseText;
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
		const negCond: Condition =
			p7UnlessCond.k === 'not' ? p7UnlessCond.of : { k: 'not', of: p7UnlessCond };
		for (const step of added) {
			step.condition = step.condition ? { k: 'and', of: [negCond, step.condition] } : negCond;
		}
		return true;
	}
	// --- End Track P7 ---
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
	let t = c.text.trim();
	if (p.steps.length > 0 && /^then,?\s+/i.test(t) && !/^then\s+if\b/i.test(t)) {
		t = t.replace(/^then,?\s+/i, '').trim();
	}
	if (!t) return false;
	if (allowUnless && /\bunless\b/i.test(t) && tryUnlessClause(p, t, c.span)) return true;
	if (imperative(p, t, c.span)) return true;
	if (tryP13Clause(p, t, c.span)) return true;

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
	const dur = t.match(/^(until end of turn|until your next turn|until (?:the )?end of your next turn), (.+)$/i);
	if (dur) {
		const durTail = dur[1].toLowerCase();
		if (imperative(p, `${dur[2].trim()} ${durTail}`, c.span)) return true;
	}
	const body = dur ? dur[2] : t;
	const durSuffix = dur ? ` ${dur[1].toLowerCase()}` : '';
	const words = body.split(' ');
	for (let i = words.length - 1; i >= 1; i--) {
		const subjText = words.slice(0, i).join(' ');
		const vp = words.slice(i).join(' ') + durSuffix;
		if (
			!/^(?:each\s+(?:gets?|gains?|can't)|gets?|gains?|has\b|have\b|loses?|phases?|deals|fights?|explores?|connives?|adapts?|endures?|becomes?|is\b|can't|can\b)\b/.test(
				vp
			)
		) {
			continue;
		}
		const snapshot = p.targets.length;
		const subject =
			subjText === 'it' && !p.lastObject && p.context === 'activated' && /^(?:deals|fights?|endures?)\b/.test(vp)
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
	// --- Track P13: Generalized "<clause> for each <filter / zone count>" scaling ---
	const perGeneral = t.match(
		/^(.+?) for each (.+?)( (?:until end of turn|until your next turn|until (?:the )?end of your next turn))?$/i
	);
	if (
		perGeneral &&
		!/^(?:add|copy)\b/i.test(perGeneral[1]) &&
		!/\b(?:players?|opponents?|votes?|target|targets|time|times|mana|counters?\s+(?:removed|put))\b/i.test(
			perGeneral[2]
		)
	) {
		const normWhat = perGeneral[2]
			.trim()
			.replace(/\s+on the battlefield$/i, '')
			.replace(/^card in /i, 'cards in ')
			.replace(/^card type among /i, 'card types among ')
			.replace(/^color among /i, 'colors among ')
			.replace(/^unlocked door among /i, 'unlocked doors among ');
		const countAmt = numberOf(normWhat);
		if (countAmt) {
			const multiplyAmount = (base: Amount, mult: number): Amount | null => {
				if (mult === 0) return n(0);
				if (mult === 1) return base;
				if (mult === -1) return { k: 'negate', of: base };
				const abs = Math.abs(mult);
				if (abs > 5) return null;
				const sumAmt: Amount = { k: 'sum', args: Array.from({ length: abs }, () => base) };
				return mult < 0 ? { k: 'negate', of: sumAmt } : sumAmt;
			};
			const ok = scalePerClause(`${perGeneral[1]}${perGeneral[3] ?? ''}`, (a) => {
				if (!a || a.k !== 'const') return null;
				return multiplyAmount(countAmt, a.n);
			});
			if (ok) return true;
		}
	}
	// --- End Track P13 ---
	return false;
}

/** Sentence-initial words that are not names or subtypes, so they can be lower-cased. */
const LOWER_START = new Set([
	'a', 'adapt', 'adapts', 'add', 'airbend', 'all', 'amass', 'amasses', 'an', 'another', 'any', 'artifacts', 'at', 'attach', 'attacking', 'become', 'black', 'blight', 'blights', 'blocking', 'blue', 'bolster', 'bolsters', 'choose', 'clash', 'clashes', 'cloak', 'cloaks', 'collect', 'collects', 'combat', 'connive', 'connives', 'convert', 'converts', 'copy', 'counter', 'create', 'creatures', 'damage', 'deal', 'destroy', 'detain', 'detains', 'discard', 'discards', 'discover', 'discovers', 'distribute', 'distributes', 'double', 'draw',
	'each', 'earthbend', 'enchanted', 'enchantments', 'end', 'endure', 'endures', 'equipped', 'exchange', 'exert', 'exerts', 'exile', 'explore', 'explores', 'face-down', 'fateseal', 'fateseals', 'fight', 'five', 'flip', 'for', 'forage', 'forages', 'four', 'gain', 'goad', 'goads', 'green', 'historic', 'if', 'incubate', 'incubates', 'investigate', 'it', 'its', 'lands', 'learn', 'look', 'lose', 'mana', 'manifest', 'manifests', 'mill', 'monstrosity', 'multicolored', 'nonland', 'nontoken', 'one', 'other', 'otherwise', 'pay', 'permanents', 'planeswalkers', 'players', 'populate', 'populates', 'prevent', 'prevents', 'proliferate', 'put',
	'red', 'regenerate', 'regenerates', 'remove', 'return', 'reveal', 'roll', 'rolls', 'sacrifice', 'scry', 'search', 'shuffle', 'six', 'spend', 'starting', 'support', 'surveil', 'suspect', 'suspects', 'switch', 'take', 'tap', 'tapped', 'target', 'that', 'the', 'then', 'they', 'this', 'those', 'three', 'time',
	'tokens', 'transform', 'triple', 'turn', 'two', 'untap', 'untapped', 'until', 'up', 'venture', 'when', 'whenever', 'white', 'you', 'your'
]);

// --- Track P10: Mana Spending Restriction Parser (CR 106.6, CR 106.6a) ---
function objectFilterToPlainManaFilter(f: ObjectFilter): PlainManaObjectFilter | null {
	if (
		f.other ||
		f.tapped !== undefined ||
		f.attacking !== undefined ||
		f.blocking !== undefined ||
		f.unblockedAttacker !== undefined ||
		f.suspected !== undefined ||
		f.named ||
		f.power ||
		f.toughness ||
		f.hasCounters !== undefined ||
		f.controller ||
		f.controllerRef ||
		f.owner ||
		f.wasNotCast ||
		f.abilitySourceFilter ||
		f.sharesTypeWithCommander
	) {
		return null;
	}
	const out: PlainManaObjectFilter = {};
	if (f.types?.length) out.types = [...f.types];
	if (f.allTypes?.length) out.allTypes = [...f.allTypes];
	if (f.notTypes?.length) out.notTypes = [...f.notTypes];
	if (f.supertypes?.length) out.supertypes = [...f.supertypes];
	if (f.notSupertypes?.length) out.notSupertypes = [...f.notSupertypes];
	if (f.subtypes?.length) out.subtypes = [...f.subtypes];
	if (f.colors?.length) {
		if (f.colors.includes('C')) out.colorless = true;
		const nonColorless = f.colors.filter((c) => c !== 'C');
		if (nonColorless.length > 0) out.colors = nonColorless;
	}
	if (f.notColors?.length) out.notColors = [...f.notColors];
	if (f.multicolored) out.multicolored = true;
	if (f.monocolored) out.monocolored = true;
	if (f.hasKeywords?.length) out.hasKeywords = [...f.hasKeywords];
	if (f.ofChosenType) out.ofChosenType = true;
	if (f.manaValue) {
		if (f.manaValue.value.k !== 'const') return null;
		const v = f.manaValue.value.n;
		if (f.manaValue.op === '>=') out.minManaValue = v;
		else if (f.manaValue.op === '>') out.minManaValue = v + 1;
		else if (f.manaValue.op === '<=') out.maxManaValue = v;
		else if (f.manaValue.op === '<') out.maxManaValue = v - 1;
		else if (f.manaValue.op === '=') {
			out.minManaValue = v;
			out.maxManaValue = v;
		} else {
			return null;
		}
	}
	return out;
}

function parseSpellClauseForMana(raw: string): NonNullable<ManaSpendingRestrictionSpec['allowSpells']> | null {
	let s = raw.trim().replace(/^cast\s+/i, '').trim();
	if (/^(?:your|a) commanders?(?: spells?)?$/i.test(s) || /^commander spells?$/i.test(s)) {
		return { isCommander: true };
	}
	if (/^(?:a )?spells? with \{X\} in (?:its|their) mana costs?$/i.test(s)) {
		return { hasXInCost: true };
	}
	const zoneCast = s.match(/^(?:a )?spells? from (?:your )?(graveyard|exile|command zone)$/i);
	if (zoneCast) {
		const zRaw = zoneCast[1].toLowerCase();
		const castFromZone: ZoneType = zRaw === 'command zone' ? 'command' : (zRaw as ZoneType);
		return { filter: { castFromZone } };
	}
	const kwSpell = s.match(/^(?:a |an )?spells? with ([a-z][a-z ]*)$/i);
	if (kwSpell && !/\bmana value\b/i.test(kwSpell[1])) {
		return { filter: { hasKeywords: [kwSpell[1].trim().toLowerCase()] } };
	}
	if (/^(?:a |an )?creature spells? of the chosen type$/i.test(s)) {
		return { filter: { types: ['Creature'], ofChosenType: true } };
	}
	let hasXInCost = false;
	if (/\s+with \{X\} in (?:its|their) mana costs?$/i.test(s)) {
		hasXInCost = true;
		s = s.replace(/\s+with \{X\} in (?:its|their) mana costs?$/i, '').trim();
	}
	s = s.replace(/^(?:a|an)\s+/i, '').trim();
	if (!/\bspells?$/i.test(s)) return null;
	const inner = s.replace(/\s*spells?$/i, '').trim();
	if (!inner) {
		return hasXInCost ? { hasXInCost: true } : {};
	}
	const objF = objectFilter(`${inner} card`);
	if (!objF) return null;
	const plain = objectFilterToPlainManaFilter(objF);
	if (!plain) return null;
	return {
		filter: plain,
		...(hasXInCost ? { hasXInCost: true } : {})
	};
}

function parseAbilityClauseForMana(raw: string): NonNullable<ManaSpendingRestrictionSpec['allowAbilities']> | null {
	const s = raw.trim().replace(/^(?:to\s+)?activate\s+/i, '').trim();
	if (/^(?:an )?abilit(?:y|ies)$/i.test(s) || /^abilit(?:y|ies) of permanents$/i.test(s)) {
		return { anyAbility: true };
	}
	if (/^abilit(?:y|ies) of creatures of the chosen type$/i.test(s)) {
		return { sourceFilter: { types: ['Creature'], ofChosenType: true } };
	}
	const ofMatch = s.match(/^abilit(?:y|ies) of (.+?)(?:\s+sources?|\s+cards?)?$/i);
	if (ofMatch) {
		const rawSrc = ofMatch[1].trim().replace(/^(?:a|an)\s+/i, '');
		const objF = objectFilter(rawSrc);
		if (!objF) return null;
		const plain = objectFilterToPlainManaFilter(objF);
		if (!plain) return null;
		return { sourceFilter: plain };
	}
	const preMatch = s.match(/^(.+?) abilit(?:y|ies)$/i);
	if (preMatch) {
		const rawSrc = preMatch[1].trim().replace(/^(?:a|an)\s+/i, '');
		const objF = objectFilter(rawSrc);
		if (!objF) return null;
		const plain = objectFilterToPlainManaFilter(objF);
		if (!plain) return null;
		return { sourceFilter: plain };
	}
	return null;
}

function parseManaRestrictionSentence(t: string): ManaSpendingRestrictionSpec | null {
	const onlyTo = t.match(/^spend this mana only to (.+)$/i);
	if (onlyTo) {
		const body = onlyTo[1].trim();
		if (/^foretell cards$/i.test(body)) {
			return { allowAbilities: { foretell: true } };
		}
		// Combined: "cast <X> spells or [to] activate <Y> abilities" / "activate abilities or cast <X> spells"
		const castOrAct = body.match(/^cast (.+?)\s+(?:or|and\/or)\s+(?:to\s+)?activate (.+)$/i);
		if (castOrAct) {
			const allowSpells = parseSpellClauseForMana(`cast ${castOrAct[1]}`);
			const allowAbilities = parseAbilityClauseForMana(`activate ${castOrAct[2]}`);
			if (!allowSpells || !allowAbilities) return null;
			return { allowSpells, allowAbilities };
		}
		const actOrCast = body.match(/^activate (.+?)\s+(?:or|and\/or)\s+(?:to\s+)?cast (.+)$/i);
		if (actOrCast) {
			const allowAbilities = parseAbilityClauseForMana(`activate ${actOrCast[1]}`);
			const allowSpells = parseSpellClauseForMana(`cast ${actOrCast[2]}`);
			if (!allowSpells || !allowAbilities) return null;
			return { allowSpells, allowAbilities };
		}
		// Two spell alternatives: "cast <A> spells or [cast] <B> spells" / "cast <A> spells or spells with {X} in their mana costs"
		const twoCast = body.match(/^cast (.+? spells?)\s+(?:or|and\/or)\s+(?:cast\s+)?(.+)$/i);
		if (twoCast) {
			const sp1 = parseSpellClauseForMana(`cast ${twoCast[1]}`);
			const sp2 = parseSpellClauseForMana(`cast ${twoCast[2]}`);
			if (sp1 && sp2 && !sp1.isCommander && !sp2.isCommander) {
				return {
					allowSpells: {
						...sp1,
						...(sp2.filter ? { altFilter: sp2.filter } : {}),
						...(sp2.hasXInCost ? { altHasXInCost: true } : {})
					}
				};
			}
		}
		if (/^cast\b/i.test(body)) {
			const allowSpells = parseSpellClauseForMana(body);
			return allowSpells ? { allowSpells } : null;
		}
		if (/^activate\b/i.test(body)) {
			const allowAbilities = parseAbilityClauseForMana(body);
			return allowAbilities ? { allowAbilities } : null;
		}
		return null;
	}

	const cantCast = t.match(/^this mana can't be spent to cast (?:a |an )?non([a-z]+) spells?$/i);
	if (cantCast) {
		const typeWord = cantCast[1].toLowerCase();
		const allowSpells = parseSpellClauseForMana(`cast ${typeWord} spells`);
		if (!allowSpells) return null;
		return {
			allowSpells,
			allowAbilities: { anyAbility: true, foretell: true }
		};
	}
	return null;
}

function attachToTrailingAddManaSteps(
	p: Parser,
	updater: (prevParams: EffectParams) => EffectParams
): boolean {
	let idx = p.steps.length - 1;
	if (idx < 0 || p.steps[idx]?.verb !== 'addMana') return false;
	for (; idx >= 0 && p.steps[idx]?.verb === 'addMana'; idx--) {
		p.steps[idx].params = updater(p.steps[idx].params ?? {});
	}
	return true;
}
// --- End Track P10 ---

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

	// --- Track P13: Flashback / graveyard-cast riders & multi-sentence Council vote follow-ups ---
	if (/^the flashback cost is equal to its mana cost$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'grantGraveyardCast' || !prev.params?.graveyardCastSpec) return fail();
		prev.params = {
			...prev.params,
			graveyardCastSpec: { ...prev.params.graveyardCastSpec, flashbackEqualManaCost: true }
		};
		return true;
	}
	if (
		/^if (?:that spell|that card|a spell cast this way) would be put into (?:your|a) graveyard(?: this turn)?, exile it instead$/i.test(
			t
		)
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'grantGraveyardCast' || !prev.params?.graveyardCastSpec) return fail();
		prev.params = {
			...prev.params,
			graveyardCastSpec: { ...prev.params.graveyardCastSpec, exileIfWouldEnterGraveyard: true }
		};
		return true;
	}
	if (p.steps.length > 0 && p.steps[p.steps.length - 1]?.verb === 'vote') {
		const voteStep = p.steps[p.steps.length - 1];
		const vs = voteStep.params?.voteSpec;
		if (vs) {
			const dilemmaFollow = t.match(/^for each ([a-z]+) vote,\s*(.+)$/i);
			if (dilemmaFollow) {
				const optName = dilemmaFollow[1].toLowerCase();
				const optIdx = vs.options.indexOf(optName);
				if (optIdx === 0 || optIdx === 1) {
					const innerParse = parseEffects(dilemmaFollow[2].trim(), span.start, p.context, p.trigger);
					if (innerParse.unparsed.length === 0 && innerParse.targets.length === 0 && innerParse.steps.length > 0) {
						const prevPer: [EffectStep[], EffectStep[]] = vs.perOptionEffect
							? [[...vs.perOptionEffect[0]], [...vs.perOptionEffect[1]]]
							: [[], []];
						prevPer[optIdx] = innerParse.steps;
						voteStep.params = {
							...voteStep.params,
							voteSpec: { ...vs, perOptionEffect: prevPer }
						};
						return true;
					}
				}
			}
			const councilFollow = t.match(
				/^if ([a-z]+) gets more votes(?: or the vote is tied)?,\s*(.+)$/i
			);
			if (councilFollow) {
				const optName = councilFollow[1].toLowerCase();
				const optIdx = vs.options.indexOf(optName);
				if (optIdx === 0 || optIdx === 1) {
					const innerParse = parseEffects(councilFollow[2].trim(), span.start, p.context, p.trigger);
					if (innerParse.unparsed.length === 0 && innerParse.targets.length === 0 && innerParse.steps.length > 0) {
						const prevWin: [EffectStep[], EffectStep[]] = vs.perWinningEffect
							? [[...vs.perWinningEffect[0]], [...vs.perWinningEffect[1]]]
							: [[], []];
						prevWin[optIdx] = innerParse.steps;
						voteStep.params = {
							...voteStep.params,
							voteSpec: { ...vs, perWinningEffect: prevWin }
						};
						return true;
					}
				}
			}
		}
	}
	// --- End Track P13 ---

	if (/^this mana can't be spent to cast (?:a )?nonartifact spells?$/i.test(t)) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'addMana') return fail();
		prev.params = { ...prev.params, manaRestriction: 'artifactSpellOrNonSpell' };
		return true;
	}

	// --- Track P10: Mana restrictions, unemptied mana, counter replacement, token ability riders, & coin flip follow-ups ---
	const manaRestrSpec = parseManaRestrictionSentence(t);
	if (manaRestrSpec) {
		if (!attachToTrailingAddManaSteps(p, (prev) => ({ ...prev, manaRestrictionSpec: manaRestrSpec }))) {
			return fail();
		}
		return true;
	}

	if (
		/^(?:until end of turn, )?you don't lose this mana as steps and phases end$/i.test(t)
	) {
		if (!attachToTrailingAddManaSteps(p, (prev) => ({ ...prev, retainManaUntilEndOfTurn: true }))) {
			return fail();
		}
		return true;
	}

	const retainUnspent = t.match(
		/^(?:until end of turn, )?you don't lose unspent (?:(white|blue|black|red|green|colorless) )?mana as steps and phases end(?: this turn| until end of turn)?$/i
	);
	if (retainUnspent && (/^until end of turn,/i.test(t) || /(?:this turn|until end of turn)$/i.test(t))) {
		const cw = retainUnspent[1]?.toLowerCase();
		const unemptiedColors: ManaColor[] | 'all' =
			!cw ? 'all' : cw === 'colorless' ? ['C'] : [COLOR_WORDS[cw]];
		p.push({ verb: 'retainMana', subject: { k: 'none' }, params: { unemptiedColors }, span }, false);
		return true;
	}

	if (
		/^(?:then )?(?:that player|that opponent|they) (?:then )?shuffles?(?: their library)?$/i.test(t)
	) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb === 'search') return true;
		if (p.lastPlayer && playerPredicate(p, p.lastPlayer, 'shuffles', span)) return true;
		if (p.lastObject) {
			const ownerSel = playerPhrase(p, 'its owner');
			if (ownerSel && playerPredicate(p, ownerSel, 'shuffles', span)) return true;
		}
		return fail();
	}

	const counterRep = t.match(
		/^if (?:that|the) spell is countered this way, (exile it|put it on (?:the )?(top|bottom) of its owner's library) instead of putting it into its owner's graveyard$/i
	);
	if (counterRep) {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'counterSpell') return fail();
		const counterReplacementZone: NonNullable<EffectParams['counterReplacementZone']> =
			counterRep[1].toLowerCase().startsWith('exile')
				? 'exile'
				: counterRep[2].toLowerCase() === 'top'
					? 'libraryTop'
					: 'libraryBottom';
		prev.params = { ...prev.params, counterReplacementZone };
		return true;
	}

	const tokHasQuoted = t.match(
		/^(?:it|they|that token|those tokens|the tokens?) (?:has|have) [“"]([^”"]+)[”"]$/i
	);
	if (tokHasQuoted) {
		const prev = p.steps[p.steps.length - 1];
		const qText = tokHasQuoted[1].trim();
		if (prev?.verb !== 'createToken' || !prev.params?.token || !isSupportedTokenQuotedAbility(qText)) {
			return fail();
		}
		prev.params = {
			...prev.params,
			token: {
				...prev.params.token,
				quotedAbilities: [...(prev.params.token.quotedAbilities ?? []), qText]
			}
		};
		return true;
	}

	const flipOutcome = t.match(/^if you (win|lose) the flip, (.+)$/i);
	if (flipOutcome && p.lastCoinFlipStep !== undefined && p.steps[p.lastCoinFlipStep]?.verb === 'flipCoin') {
		const flipIdx = p.lastCoinFlipStep;
		const isWin = flipOutcome[1].toLowerCase() === 'win';
		const childParser = new Parser(p.context, p.trigger);
		childParser.definedX = p.definedX;
		childParser.lastPlayer = p.lastPlayer;
		childParser.lastObject = p.lastObject ? { ...p.lastObject, stepIndex: -1 } : undefined;
		const innerStart = Math.max(span.start, span.end - flipOutcome[2].length);
		if (
			!sentence(childParser, flipOutcome[2].trim(), { start: innerStart, end: span.end }) ||
			childParser.targets.length > 0 ||
			childParser.steps.length === 0
		) {
			return fail();
		}
		const flipStep = p.steps[flipIdx];
		flipStep.params = {
			...flipStep.params,
			...(isWin
				? { winFlipEffect: [...(flipStep.params?.winFlipEffect ?? []), ...childParser.steps] }
				: { loseFlipEffect: [...(flipStep.params?.loseFlipEffect ?? []), ...childParser.steps] })
		};
		return true;
	}
	// --- End Track P10 ---

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

	// --- Track P7: Burn riders (CR 614.6 / CR 701.19) & Turn-history / wasCast conditionals ---
	if (
		/^a (?:creature|permanent|creature or planeswalker) dealt damage this way can't be regenerated this turn$/i.test(
			t
		)
	) {
		const dmgIndices: number[] = [];
		for (let i = stepsBefore - 1; i >= 0 && p.steps[i]?.verb === 'damage'; i--) {
			dmgIndices.unshift(i);
		}
		if (dmgIndices.length === 0) return fail();
		for (const idx of dmgIndices) {
			const bindName = p.steps[idx].bindAs ?? `b${idx}`;
			p.steps[idx].bindAs = bindName;
			p.push({ verb: 'cantRegenerate', subject: { k: 'binding', name: bindName }, span }, false);
		}
		p.lastOptionalStep = undefined;
		return true;
	}

	if (
		/^if (?:a|any) (?:creature|permanent|creature or planeswalker) dealt damage this way would die this turn, exile it instead$/i.test(
			t
		)
	) {
		const dmgIndices: number[] = [];
		for (let i = stepsBefore - 1; i >= 0 && p.steps[i]?.verb === 'damage'; i--) {
			dmgIndices.unshift(i);
		}
		if (dmgIndices.length === 0) return fail();
		for (const idx of dmgIndices) {
			const bindName = p.steps[idx].bindAs ?? `b${idx}`;
			p.steps[idx].bindAs = bindName;
			p.push(
				{ verb: 'exileInsteadOfDying', subject: { k: 'binding', name: bindName }, span },
				false
			);
		}
		p.lastOptionalStep = undefined;
		return true;
	}

	const exileOnDieSubj = t.match(/^if (.+?) would die this turn, exile (?:it|them) instead$/i);
	if (
		exileOnDieSubj &&
		!/^(?:a|an|any)\b/i.test(exileOnDieSubj[1].trim()) &&
		!/\bdealt damage this way\b/i.test(exileOnDieSubj[1])
	) {
		const obj = objectPhrase(p, exileOnDieSubj[1].trim());
		if (!obj || obj.fromZone) return fail();
		if (obj.selector.k === 'target') {
			const tSpec = p.targets[obj.selector.index];
			if (!tSpec || tSpec.kind !== 'object' || (tSpec.filter.zone ?? 'battlefield') !== 'battlefield') {
				return fail();
			}
		}
		p.push({ verb: 'exileInsteadOfDying', subject: obj.selector, span }, true);
		p.lastOptionalStep = undefined;
		return true;
	}

	const ifP7Lead = t.match(/^(?:then\s+)?(if [^,]+),\s*(.+)$/i);
	if (ifP7Lead) {
		const cond = parseCondition(ifP7Lead[1], { allowDungeonCompletion: true });
		if (cond && isP7ResolutionCondition(cond)) {
			let innerText = ifP7Lead[2].trim();
			if (/\s+instead$/i.test(innerText)) {
				const stripped = innerText.replace(/\s+instead$/i, '').trim();
				if (!tryReplacementIfSentence(p, stripped, cond, stepsBefore, targetsBefore, span)) {
					return fail();
				}
				p.lastOptionalStep = undefined;
				return true;
			}
			if (/\binstead\b/i.test(innerText)) return fail();
			innerText = innerText.replace(/^it (?:also )?deals\b/i, '~ deals').replace(/^also\s+/i, '');
			const innerStart = Math.max(span.start, span.end - ifP7Lead[2].length);
			if (!sentence(p, innerText, { start: innerStart, end: span.end })) return fail();
			for (const step of p.steps.slice(stepsBefore)) {
				step.condition = step.condition ? { k: 'and', of: [cond, step.condition] } : cond;
			}
			return true;
		}
	}

	const insteadIfTail = t.match(/^(.+?)\s+instead\s+(if .+)$/i);
	if (insteadIfTail) {
		const cond = parseCondition(insteadIfTail[2], { allowDungeonCompletion: true });
		if (cond && isP7ResolutionCondition(cond)) {
			if (!tryReplacementIfSentence(p, insteadIfTail[1].trim(), cond, stepsBefore, targetsBefore, span)) {
				return fail();
			}
			p.lastOptionalStep = undefined;
			return true;
		}
	}
	// --- End Track P7 ---

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
		p.flushPendingDig();
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
			if (s.params?.dieBonus) s.params.dieBonus = substituteX(s.params.dieBonus, resolvedX);
			if (s.params?.reflexiveTrigger) {
				for (const rs of s.params.reflexiveTrigger.effect) {
					if (rs.amount) rs.amount = substituteX(rs.amount, resolvedX);
					if (rs.params?.toughness) rs.params.toughness = substituteX(rs.params.toughness, resolvedX);
				}
			}
		}
		for (const tSpec of p.targets.slice(targetsBefore)) {
			if (tSpec.divideTotal) tSpec.divideTotal = substituteX(tSpec.divideTotal, resolvedX);
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
	if (step.verb === 'clash' || step.verb === 'discover' || step.verb === 'flipCoin') return { k: 'you' };
	if (step.verb === 'move' && step.params?.from === 'hand' && step.params?.to === 'battlefield' && step.params?.upTo) {
		return step.actor ?? { k: 'you' };
	}
	return undefined;
}

// --- Track P10: Reflexive Trigger Follow-Up Parser (`CR 603.12`, `CR 603.12a`, `CR 603.2d`) ---
function parseReflexiveTriggerHeader(
	text: string
): {
	eventFilter: NonNullable<ReflexiveTriggerSpec['eventFilter']>;
	objectFilter?: ObjectFilter;
	innerText: string;
} | null {
	const whenYouDo = text.match(/^when (you do|that player does|the player does|they do), (.+)$/i);
	if (whenYouDo) {
		return { eventFilter: 'whenYouDo', innerText: whenYouDo[2].trim() };
	}
	const sacWay = text.match(
		/^(?:when|whenever) (?:you sacrifice|that player sacrifices|a player sacrifices) (?:one or more |a |an )?(.+?) this way, (.+)$/i
	);
	if (sacWay) {
		const f = objectFilter(sacWay[1].trim());
		if (!f) return null;
		return {
			eventFilter: 'sacrificedThisWay',
			...(Object.keys(f).length > 0 ? { objectFilter: f } : {}),
			innerText: sacWay[2].trim()
		};
	}
	const dieWay = text.match(/^(?:when|whenever) (?:one or more |a |an )?(.+?) dies? this way, (.+)$/i);
	if (dieWay) {
		const f = objectFilter(dieWay[1].trim());
		if (!f) return null;
		return {
			eventFilter: 'diedThisWay',
			...(Object.keys(f).length > 0 ? { objectFilter: f } : {}),
			innerText: dieWay[2].trim()
		};
	}
	const discWay = text.match(
		/^(?:when|whenever) (?:(?:you discard|a player discards) (?:one or more |a |an )?(.+?) this way|(?:one or more |a |an )?(.+?) (?:is|are) discarded this way), (.+)$/i
	);
	if (discWay) {
		const rawObj = (discWay[1] ?? discWay[2]).trim();
		const f = objectFilter(rawObj);
		if (!f) return null;
		return {
			eventFilter: 'discardedThisWay',
			...(Object.keys(f).length > 0 ? { objectFilter: f } : {}),
			innerText: discWay[3].trim()
		};
	}
	const exWay = text.match(
		/^(?:when|whenever) (?:(?:you exile|a player exiles) (?:one or more |a |an )?(.+?) this way|(?:one or more |a |an )?(.+?) (?:is|are) exiled this way), (.+)$/i
	);
	if (exWay) {
		const rawObj = (exWay[1] ?? exWay[2]).trim();
		const f = objectFilter(rawObj);
		if (!f) return null;
		return {
			eventFilter: 'exiledThisWay',
			...(Object.keys(f).length > 0 ? { objectFilter: f } : {}),
			innerText: exWay[3].trim()
		};
	}
	const ctrWay = text.match(
		/^(?:when|whenever) (?:one or more |a |an )?(?:.+? )?counters? (?:is|are) removed this way, (.+)$/i
	);
	if (ctrWay) {
		return { eventFilter: 'removedCounterThisWay', innerText: ctrWay[1].trim() };
	}
	return null;
}

function parseReflexiveTriggerFollowUp(p: Parser, text: string, span: Span): boolean | null {
	const hdr = parseReflexiveTriggerHeader(text);
	if (!hdr) return null;

	let parentIdx: number | undefined;
	if (hdr.eventFilter === 'whenYouDo') {
		parentIdx = p.lastOptionalStep;
		const chooser = parentIdx !== undefined ? stepOptionalChooser(p.steps[parentIdx]) : undefined;
		if (parentIdx === undefined || !chooser) return false;
		const whoMatch = text.match(/^when ([^,]+),/i);
		const who = whoMatch?.[1]?.toLowerCase() ?? 'you do';
		if (who === 'you do' && chooser.k !== 'you') return false;
		if (who !== 'you do' && chooser.k === 'you') return false;
	} else {
		parentIdx = p.lastOptionalStep ?? (p.steps.length > 0 ? p.steps.length - 1 : undefined);
		if (parentIdx === undefined || !p.steps[parentIdx]) return false;
	}

	const parentStep = p.steps[parentIdx];
	if (!parentStep || parentStep.params?.reflexiveTrigger) return false;

	// Ensure parentStep binds its acted-on objects so reflexive inner clauses can read "its power", "that card", etc.
	const savedBind = parentStep.bindAs;
	let inheritedObj: { ref: Ref; stepIndex: number } | undefined;
	if (p.lastObject && p.lastObject.stepIndex === parentIdx) {
		const bindName = parentStep.bindAs ?? `b${parentIdx}`;
		parentStep.bindAs = bindName;
		inheritedObj = { ref: { k: 'binding', name: bindName }, stepIndex: -1 };
	} else if (p.lastObject) {
		if (p.lastObject.stepIndex >= 0 && p.steps[p.lastObject.stepIndex]) {
			const st = p.steps[p.lastObject.stepIndex];
			const bindName = st.bindAs ?? `b${p.lastObject.stepIndex}`;
			st.bindAs = bindName;
			inheritedObj = { ref: { k: 'binding', name: bindName }, stepIndex: -1 };
		} else {
			inheritedObj = { ...p.lastObject };
		}
	}

	// Reject cross-reference to parent spell targets inside reflexive trigger body (`target[i]` indices are local to reflexiveTrigger.targets).
	if (inheritedObj?.ref.k === 'target') {
		inheritedObj = undefined;
	}

	const childParser = new Parser('triggered');
	childParser.definedX = p.definedX;
	if (p.lastPlayer && !(p.lastPlayer.k === 'playerRef' && p.lastPlayer.ref.k === 'target')) {
		childParser.lastPlayer = p.lastPlayer;
	}
	childParser.lastObject = inheritedObj;

	const innerStart = Math.max(span.start, span.end - hdr.innerText.length);
	if (
		!sentence(childParser, hdr.innerText, { start: innerStart, end: span.end }) ||
		childParser.steps.length === 0 ||
		childParser.unparsed.length > 0
	) {
		if (savedBind === undefined) delete parentStep.bindAs;
		else parentStep.bindAs = savedBind;
		return false;
	}

	const reflexiveTrigger: ReflexiveTriggerSpec = {
		targets: childParser.targets,
		effect: childParser.steps,
		text: text.trim(),
		eventFilter: hdr.eventFilter,
		...(hdr.objectFilter ? { objectFilter: hdr.objectFilter } : {})
	};
	parentStep.params = { ...parentStep.params, reflexiveTrigger };
	if (hdr.eventFilter === 'whenYouDo') {
		p.lastOptionalStep = parentIdx;
	}
	return true;
}
// --- End Track P10 ---

function parseOptionalFollowUp(
	p: Parser,
	text: string,
	span: Span,
	parseInner: (innerText: string, innerStart: number) => boolean
): boolean | null {
	const refl = parseReflexiveTriggerFollowUp(p, text, span);
	if (refl !== null) return refl;

	const ifWinClash =
		p.lastOptionalStep !== undefined && p.steps[p.lastOptionalStep]?.verb === 'clash'
			? text.match(/^if you win(?: the clash)?, (.+)$/i)
			: null;
	const ifDo = ifWinClash
		? (['', 'if', 'you do', ifWinClash[1]] as unknown as RegExpMatchArray)
		: text.match(/^(if) (you do|that player does|the player does|they do), (.+)$/i);
	const ifDont = ifDo
		? null
		: text.match(/^(?:if (you don't|that player doesn't|the player doesn't|they don't)|otherwise), (.+)$/i);
	if (!ifDo && !ifDont) return null;

	const optIdx = p.lastOptionalStep;
	const chooser = optIdx !== undefined ? stepOptionalChooser(p.steps[optIdx]) : undefined;
	if (optIdx === undefined || !chooser) return false;

	const isAccept = Boolean(ifDo);
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
		/^(.+?)(?:,\s*(?:and|then)|,?\s+(?:and|then))\s+((?:(?:if|when) (?:you do|that player does|the player does|they do)|(?:when|whenever) .+ this way|if you win(?: the (?:clash|flip))?|if you lose the flip|if (?:you don't|that player doesn't|the player doesn't|they don't)|otherwise), .+)$/i
	);
	if (ifDoSplit && !isInsideQuotes(text, text.indexOf(ifDoSplit[2]))) {
		const mark = p.mark();
		const head = ifDoSplit[1].trim();
		const tail = ifDoSplit[2].trim();
		const tailOffset = offset + text.indexOf(tail);
		if (clauses(p, head, offset) && clauses(p, tail, tailOffset)) return true;
		p.rollback(mark);
		return false;
	}
	// A search clause consumes the rest of the sentence ("..., put it into your hand, then shuffle").
	const search = text.match(/^(.*?)\b((?:its controller may |its owner may |target player may |target opponent may |that player may |you may |they may )?search(?:es)? (?:your|their|that player's|target player's|target opponent's) (?:library|graveyard) .+)$/i);
	if (search && !isInsideQuotes(text, text.indexOf(search[2]))) {
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
type DigRestSpec = Pick<NonNullable<EffectParams['dig']>, 'rest' | 'restRandom' | 'restOrder' | 'restToHand'>;

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
	if (d === 'into your hand') {
		return { rest: 'libraryBottom', restToHand: true };
	}
	return null;
}

function parseDigKeepClause(clauseStr: string, hasUntilFilter = false): DigKeepSpec | null {
	const s = clauseStr.trim();
	const mayPrefix = /^you may\s+/i.test(s);
	const body = s.replace(/^you may\s+/i, '');

	if (hasUntilFilter) {
		const untilKeep = body.match(/^put (?:that card|it) (.+)$/i);
		if (untilKeep) {
			const dest = parseDigDestination(untilKeep[1].trim());
			if (!dest) return null;
			return {
				keep: 1,
				upTo: mayPrefix,
				keepTo: dest.keepTo,
				...(dest.keepTapped ? { keepTapped: true } : {})
			};
		}
	}

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
		const parsed = objectFilter(filterStr);
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

	if (pd.draft.untilFilter && /^(?:then\s+)?put all cards revealed this way into your hand$/i.test(t)) {
		pd.draft = {
			...pd.draft,
			keep: 1,
			upTo: false,
			keepTo: 'hand',
			rest: 'libraryBottom',
			restToHand: true
		};
		pd.hasKeep = true;
		pd.hasRest = true;
		commitPendingDig(p, pd);
		return true;
	}

	if (!pd.hasKeep) {
		const combined = t.match(
			/^(.+?)(?:,\s*|\s+)(?:and|then)\s+(?:put\s+)?(?:the rest|the other(?:s| cards)?|all other cards revealed this way)\s+(.+)$/i
		);
		if (combined) {
			const keepSpec = parseDigKeepClause(combined[1], Boolean(pd.draft.untilFilter));
			const restSpec = parseDigRestDestination(combined[2]);
			if (!keepSpec || !restSpec) return false;
			pd.draft = { ...pd.draft, ...keepSpec, ...restSpec };
			pd.hasKeep = true;
			pd.hasRest = true;
			commitPendingDig(p, pd);
			return true;
		}
		const keepSpec = parseDigKeepClause(t, Boolean(pd.draft.untilFilter));
		if (!keepSpec) return false;
		pd.draft = { ...pd.draft, ...keepSpec };
		pd.hasKeep = true;
		return true;
	}

	if (!pd.hasRest) {
		const restMatch = t.match(
			/^(?:then\s+)?(?:put\s+)?(?:the rest|the other(?:s| cards)?|all other cards revealed this way)\s+(.+)$/i
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
	const parsed = objectFilter(trimmed);
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
	const trimmed = text.trim();
	let lookOnly = false;
	let m = trimmed.match(
		/^(.+?) reveals? their hand(?:,?\s+(?:and\s+)?you (may )?choose (?:a|an) (.+?) from it(?:,?\s+and\s+((?:if you do,\s*)?(?:(?:that player|the player|that opponent|they) discards? (?:that card|it)|(?:you )?exile (?:that card|it))))?)?$/i
	);
	if (!m) {
		const lookM = trimmed.match(
			/^look at (target player's|target opponent's|that player's|their) hand(?:,?\s+(?:and\s+)?you (may )?choose (?:a|an) (.+?) from it(?:,?\s+and\s+((?:if you do,\s*)?(?:(?:that player|the player|that opponent|they) discards? (?:that card|it)|(?:you )?exile (?:that card|it))))?)?$/i
		);
		if (lookM) {
			lookOnly = true;
			const whoPoss = lookM[1].toLowerCase();
			const whoNom =
				whoPoss === "target player's"
					? 'target player'
					: whoPoss === "target opponent's"
						? 'target opponent'
						: whoPoss === "that player's"
							? 'that player'
							: 'they';
			m = [lookM[0], whoNom, lookM[2], lookM[3], lookM[4]];
		}
	}
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
		...(lookOnly ? { lookOnly: true } : {}),
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

// --- Track P10: Die-roll result table row parser (CR 706.3b) ---
const DIE_ROLL_ROW_RE = /^(\d+)(?:\s*[—–-]\s*(\d+)|(\+))?\s*\|\s*(.+)$/s;

function tryParseDieRollBranch(
	p: Parser,
	rawText: string,
	span: Span,
	context: EffectContext,
	trigger?: TriggerDef
): boolean {
	const trimmed = rawText.trim();
	const m = trimmed.match(DIE_ROLL_ROW_RE);
	if (!m) return false;
	let rollStep: EffectStep | undefined;
	for (let i = p.steps.length - 1; i >= 0; i--) {
		if (p.steps[i].verb === 'rollDie') {
			rollStep = p.steps[i];
			break;
		}
	}
	if (!rollStep) return false;
	const min = parseInt(m[1], 10);
	const max = m[2] !== undefined ? parseInt(m[2], 10) : m[3] === '+' ? 999 : min;
	if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return false;
	const pipeIdx = rawText.indexOf('|');
	const afterPipeRaw = pipeIdx >= 0 ? rawText.slice(pipeIdx + 1) : m[4];
	const leadSpaces = afterPipeRaw.length - afterPipeRaw.trimStart().length;
	const bodyText = afterPipeRaw.trim();
	if (!bodyText) return false;
	const bodyOffset = span.start + (pipeIdx >= 0 ? pipeIdx + 1 + leadSpaces : 0);
	const subParse = parseEffects(bodyText, bodyOffset, context, trigger);
	if (subParse.unparsed.length > 0 || subParse.targets.length > 0 || subParse.steps.length === 0) {
		return false;
	}
	const existing = rollStep.params?.dieRollTable ?? [];
	rollStep.params = {
		...rollStep.params,
		dieRollTable: [...existing, { min, max, effect: subParse.steps }]
	};
	return true;
}
// --- End Track P10 ---

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
	if (text.includes('\n')) {
		let lineOffset = offset;
		for (const rawLine of text.split('\n')) {
			const lineSpan: Span = { start: lineOffset, end: lineOffset + rawLine.length };
			if (DIE_ROLL_ROW_RE.test(rawLine.trim())) {
				if (!tryParseDieRollBranch(p, rawLine, lineSpan, context, trigger)) {
					p.unparsed.push(lineSpan);
					p.lastOptionalStep = undefined;
				}
			} else {
				for (const s of splitSentences(rawLine, lineOffset)) {
					if (!sentence(p, s.text, s.span)) {
						p.unparsed.push(s.span);
						p.lastOptionalStep = undefined;
					}
				}
			}
			lineOffset += rawLine.length + 1;
		}
	} else {
		for (const s of splitSentences(text, offset)) {
			if (DIE_ROLL_ROW_RE.test(s.text.trim()) && tryParseDieRollBranch(p, s.text, s.span, context, trigger)) {
				continue;
			}
			if (!sentence(p, s.text, s.span)) {
				p.unparsed.push(s.span);
				p.lastOptionalStep = undefined;
			}
		}
	}
	p.flushPendingDig();
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
		if (flavor && !/\bfaces a villainous choice$/i.test(flavor[1])) {
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
		if (DIE_ROLL_ROW_RE.test(line.body.trim())) {
			effectSentences.push({ text: line.body, span: line.bodySpan });
			continue;
		}
		// --- Track P13: Restore "Each/Target opponent faces a villainous choice — <Capital>..." ---
		if (line.abilityWord && /\bfaces a villainous choice$/i.test(line.abilityWord)) {
			for (const s of splitSentences(line.text, line.span.start)) {
				if (parseAdditionalCostSentence(s.text)) continue;
				effectSentences.push(s);
			}
			continue;
		}
		// --- End Track P13 ---
		for (const s of line.sentences) {
			if (parseAdditionalCostSentence(s.text)) continue;
			effectSentences.push(s);
		}
	}

	// Parse all effect sentences with one parser so "it" can refer across lines.
	const p = new Parser('spell');
	for (const s of effectSentences) {
		if (DIE_ROLL_ROW_RE.test(s.text.trim()) && tryParseDieRollBranch(p, s.text, s.span, 'spell')) {
			continue;
		}
		if (!sentence(p, s.text, s.span)) {
			p.unparsed.push(s.span);
			p.lastOptionalStep = undefined;
		}
	}
	p.flushPendingDig();
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
