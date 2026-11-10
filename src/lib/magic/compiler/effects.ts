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
import type { CounterType, LibrarySearchSpec, ManaColor, ScryfallCard, StackItem } from '../types.ts';
import { buildTokenSpec, parseLibrarySearchSpec } from '../oracle.ts';
import { parseAdditionalCostSentence, parseObjectPhrase } from './costs.ts';
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
	fifteen: 15,
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

/** Keywords a "gains <keyword>" clause can grant until end of turn. */
const GRANTABLE_KEYWORDS = [
	'double strike',
	'first strike',
	'deathtouch',
	'defender',
	'flying',
	'haste',
	'hexproof',
	'indestructible',
	'lifelink',
	'menace',
	'reach',
	'shroud',
	'trample',
	'vigilance'
];

const COUNTER_WORDS: Record<string, CounterType> = {
	'+1/+1': '+1/+1',
	'-1/-1': '-1/-1',
	'−1/−1': '-1/-1',
	charge: 'charge',
	shield: 'shield',
	stun: 'stun',
	lore: 'lore',
	time: 'time',
	loyalty: 'loyalty'
};

/** Sentences that carry no effect of their own. */
const NEUTRAL_SENTENCES: RegExp[] = [
	// The engine has no regeneration, so "can't be regenerated" always holds.
	/^(?:it|they) can't be regenerated\.?$/i,
	/^then shuffle\.?$/i
];

/** Activation and cast restrictions; enforced by the cast/activation legality checks, not effects. */
const RESTRICTION_SENTENCES: RegExp[] = [
	/^activate only as a sorcery\.?$/i,
	/^activate only during your turn\.?$/i,
	/^activate only once each turn\.?$/i,
	/^activate only during your upkeep\.?$/i,
	/^activate only during combat\.?$/i,
	/^equip only as a sorcery\.?$/i,
	/^cast (?:~|this spell) only during combat\.?$/i,
	/^cast (?:~|this spell) only during your turn\.?$/i,
	/^cast (?:~|this spell) only before attackers are declared\.?$/i,
	/^~ can't be countered\.?$/i,
	/^this spell can't be countered\.?$/i,
	// Cost reductions of the spell itself are statics, applied when the cost is determined.
	/^~ costs .+ less to cast\b.*$/i,
	/^this spell costs .+ less to cast\b.*$/i,
	/^if you control (?:a|your) commander, you may cast (?:~|this spell) without paying its mana cost\.?$/i
];

// ---- Parse context --------------------------------------------------------------------------

interface ObjectRes {
	selector: Selector;
	/** Ref to the same object(s), for "it"/"its" in later clauses. */
	ref?: Ref;
	/** The step that acts on this object should bind its result under this name. */
	plural?: boolean;
	topmostOnly?: boolean;
	fromZone?: 'graveyard';
}

class Parser {
	readonly steps: EffectStep[] = [];
	readonly targets: TargetSpec[] = [];
	readonly unparsed: Span[] = [];
	readonly context: EffectContext;
	/** What "it", "that creature", "its controller" refer to. */
	private lastObject?: { ref: Ref; stepIndex: number };
	/** Implicit subject of a continued predicate ("Target player draws two cards and loses 2 life"). */
	lastPlayer?: Selector;
	/** "where X is ..." defined in an earlier sentence of the same ability (Thassa's Oracle). */
	definedX?: Amount;

	constructor(context: EffectContext) {
		this.context = context;
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
		definedX?: Amount;
		binds: Array<string | undefined>;
	} {
		return {
			steps: this.steps.length,
			targets: this.targets.length,
			lastPlayer: this.lastPlayer,
			lastObject: this.lastObject,
			definedX: this.definedX,
			binds: this.steps.map((s) => s.bindAs)
		};
	}

	rollback(m: ReturnType<Parser['mark']>): void {
		this.steps.length = m.steps;
		this.targets.length = m.targets;
		this.lastPlayer = m.lastPlayer;
		this.lastObject = m.lastObject;
		this.definedX = m.definedX;
		this.steps.forEach((s, i) => {
			if (m.binds[i] === undefined) delete s.bindAs;
			else s.bindAs = m.binds[i];
		});
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
		return idx;
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
	}
}

// ---- Object phrases -------------------------------------------------------------------------

const IT_WORDS = /^(?:it|them|that creature|that permanent|that card|that token|the creature|the card|those cards|those creatures|those permanents)$/i;

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
 * graveyard", "noncreature spell", "player", "opponent". Returns a TargetSpec without counts.
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
	const spell = phrase.match(/^(?:(.+) )?spells?$/);
	if (spell && zone === 'battlefield') {
		const filter = spell[1] ? objectFilter(`${spell[1]} card`) : {};
		if (!filter) return null;
		return { kind: 'object', filter: { ...filter, zone: 'stack' } };
	}
	const ctl = splitController(phrase);
	phrase = ctl.phrase;
	if (/^creature or player$/.test(phrase)) {
		return { kind: 'objectOrPlayer', filter: { zone: 'battlefield', types: ['Creature'] }, player: { relation: 'any' } };
	}
	const filter = objectFilter(phrase);
	if (!filter) return null;
	if (zone === 'graveyard' && !/\bcards?$/.test(phrase)) return null;
	if (zone === 'battlefield' && /\bcards?$/.test(phrase)) return null;
	const out: ObjectFilter = { ...filter, zone };
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
	if (IT_WORDS.test(t)) {
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
	const bare = !all && /\b(?:you control|your opponents control|you don't control)$/.test(t) && !/^(?:a|an|another|target)\b/.test(t);
	if (all || bare) {
		const ctl = splitController(all ? all[1] : t);
		const filter = objectFilter(ctl.phrase);
		if (!filter) return null;
		const out: ObjectFilter = { ...filter, zone: 'battlefield' };
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
	const of = t.match(/^(?:its|that creature's|that permanent's|that spell's|their) (controller|owner)$/);
	if (of) {
		const ref = p.itRef();
		if (!ref) return null;
		return { k: 'playerRef', ref: of[1] === 'controller' ? { k: 'controllerOf', of: ref } : { k: 'ownerOf', of: ref } };
	}
	if (t === 'the player whose turn it is') return { k: 'playerRef', ref: { k: 'activePlayer' } };
	if (t === 'that player' && p.context === 'triggered') {
		// In a triggered ability "that player" is the player the event was about ("Whenever an
		// opponent casts a spell, that player ..."), unless an earlier clause chose a target player.
		const last = p.lastPlayer;
		if (last && last.k === 'playerRef' && last.ref.k === 'target') return last;
		return { k: 'playerRef', ref: { k: 'eventPlayer' } };
	}
	if ((t === 'that player' || t === 'they') && p.lastPlayer) return p.lastPlayer;
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
	const stat = t.match(/^(?:(its)|that card's|that creature's|that permanent's|the exiled creature's) (power|toughness|mana value)$/);
	if (stat) {
		const it = p.itRef();
		const ref = it ?? (stat[1] ? { k: 'self' as const } : null);
		if (!ref) return null;
		const which = stat[2] === 'mana value' ? 'manaValue' : (stat[2] as 'power' | 'toughness');
		return it ? { k: 'stat', of: ref, stat: which, lki: true } : { k: 'stat', of: ref, stat: which };
	}
	// "the entering creature's power" (CR 603.6a: the object that entered, as it is now).
	const entering = t.match(/^the entering (?:creature|permanent)'s (power|toughness)$/);
	if (entering && p.context === 'triggered') return { k: 'stat', of: { k: 'eventObject' }, stat: entering[1] as 'power' | 'toughness' };
	if (t === "~'s power") return { k: 'stat', of: { k: 'self' }, stat: 'power' };
	if (t === "~'s toughness") return { k: 'stat', of: { k: 'self' }, stat: 'toughness' };
	const num = t.match(/^the number of (.+)$/);
	if (num) return numberOf(num[1]);
	return null;
}

/** "creatures you control", "Elves you control", "cards in your hand". */
function numberOf(text: string): Amount | null {
	const hand = text.match(/^cards in (your|target opponent's) hand$/);
	if (hand && hand[1] === 'your') return { k: 'cardsIn', zone: 'hand', of: { k: 'you' } };
	if (/^times? you've cast (?:your|a) commander from the command zone this game$/i.test(text.trim())) {
		return { k: 'commanderCastCount' };
	}
	const ctl = splitController(text.trim());
	const filter = objectFilter(ctl.phrase);
	if (!filter) return null;
	const of: ObjectFilter = { ...filter, zone: 'battlefield' };
	if (ctl.controller) of.controller = ctl.controller;
	return { k: 'count', of };
}

/** A count before a noun: "two", "X", "that many". */
function amountWord(p: Parser, word: string): Amount | null {
	if (word === 'that many' || word === 'that much') return p.thatMany();
	return count(word);
}

/** Splits a trailing ", where X is ..." clause off a sentence. */
function whereX(text: string): { text: string; x?: Amount; bad?: boolean } {
	const m = text.match(/^(.+?),? where X is (.+)$/);
	if (!m) return { text };
	const num = m[2].match(/^the number of (.+)$/);
	if (num) {
		const x = numberOf(num[1]);
		return x ? { text: m[1], x } : { text, bad: true };
	}
	const dev = m[2].match(/^your devotion to (white|blue|black|red|green)$/);
	if (dev) {
		const color = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[dev[1] as 'blue'];
		return { text: m[1], x: { k: 'devotion', colors: [color] } };
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

/** "a 3/3 green Beast creature token", "two 1/1 white Soldier creature tokens with lifelink", "a Treasure token". */
function tokenPhrase(p: Parser, text: string): { amount: Amount; token: TokenSpec } | null {
	const t = text.trim();
	if (/^a treasure token$/i.test(t)) {
		return {
			amount: n(1),
			token: { name: 'Treasure', power: 0, toughness: 0, colors: [], typeLine: 'Token Artifact — Treasure', keywords: [] }
		};
	}
	const m = t.match(
		/^(that many|\S+) (\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*)([A-Z][A-Za-z' ]*?) (?:artifact )?creature tokens?(?: with ([a-z, ]+?))?$/
	);
	if (!m) return null;
	const amount = amountWord(p, m[1]);
	if (!amount) return null;
	const kw = m[6] ?? '';
	if (kw && !kw.split(/,? and |, /).every((k) => GRANTABLE_KEYWORDS.includes(k.trim()) || k.trim() === 'changeling')) {
		return null;
	}
	const spec = buildTokenSpec(parseInt(m[2], 10), parseInt(m[3], 10), `${m[4]}${m[5]}`.trim(), kw);
	if (/\bchangeling\b/.test(kw)) spec.keywords.push('Changeling');
	return { amount, token: { ...spec, colors: [...spec.colors], keywords: [...spec.keywords] } };
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
	if (f.colors?.length) spec.allowedColors = [...f.colors];
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
	if (!/(?:into your hand|onto the battlefield|on top|into their hand)/.test(puts)) return null;
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

function keywordList(text: string): string[] | null {
	const parts = text.split(/,? and |, /).map((s) => s.trim().toLowerCase());
	if (!parts.every((k) => GRANTABLE_KEYWORDS.includes(k))) return null;
	return parts.map((k) => k.charAt(0).toUpperCase() + k.slice(1));
}

/** Verb phrases whose subject is an object ("~ gets +1/+0 until end of turn", "it phases out"). */
function objectPredicate(p: Parser, subject: ObjectRes, vp: string, span: Span): ClauseResult {
	const { text, eot } = stripDuration(vp);
	const params = eot ? { duration: 'endOfTurn' as const } : {};

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
	if (/^phases? out$/.test(text) && !eot) {
		p.push({ verb: 'phaseOut', subject: subject.selector, span }, true);
		return true;
	}
	const dmg = text.match(/^deals (\S+) damage to (.+)$/);
	if (dmg && !eot && subject.selector.k === 'self') {
		const amount = count(dmg[1]);
		const target = damageRecipient(p, dmg[2]);
		if (!amount || !target) return false;
		p.push({ verb: 'damage', subject: target, amount, span }, false);
		return true;
	}
	const dmgThat = text.match(/^deals (that much|that many) damage to (.+)$/);
	if (dmgThat && !eot && subject.selector.k === 'self') {
		const amount = amountWord(p, dmgThat[1]);
		const target = amount && damageRecipient(p, dmgThat[2]);
		if (!amount || !target) return false;
		p.push({ verb: 'damage', subject: target, amount, span }, false);
		return true;
	}
	const dmgEq = text.match(/^deals damage equal to (.+?) to (.+)$/);
	if (dmgEq && !eot && subject.selector.k === 'self') {
		const amount = equalTo(p, dmgEq[1]);
		const target = amount && damageRecipient(p, dmgEq[2]);
		if (!amount || !target) return false;
		p.push({ verb: 'damage', subject: target, amount, span }, false);
		return true;
	}
	const fight = text.match(/^fights? (.+)$/);
	if (fight && !eot) {
		const isAnotherTarget = /^another target\b/.test(fight[1]);
		const other = objectPhrase(p, isAnotherTarget ? fight[1].replace(/^another /, '') : fight[1]);
		if (!other) return false;
		if (isAnotherTarget && subject.selector.k === 'self' && other.selector.k === 'target') {
			p.targets[other.selector.index].filter.other = true;
		}
		p.push({ verb: 'fight', subject: subject.selector, params: { with: other.selector }, span }, false);
		return true;
	}
	return false;
}

/** The recipient of "deals N damage to ...". */
function damageRecipient(p: Parser, text: string): Selector | null {
	const t = text.trim();
	const player = playerPhrase(p, t);
	if (player) return player;
	const obj = objectPhrase(p, t);
	return obj ? obj.selector : null;
}

/** Verb phrases whose subject is a player ("draws two cards", "loses 2 life", "creates a token"). */
function playerPredicate(p: Parser, subject: Selector, vp: string, span: Span, fromImperative = false): ClauseResult {
	let text = vp.trim();
	let optional: EffectStep['optional'];
	const may = text.match(/^may (.+)$/);
	if (may) {
		const chooser = singlePlayer(subject);
		if (!chooser) return false;
		optional = { chooser };
		text = may[1];
	}
	const opt = optional ? { optional } : {};
	p.lastPlayer = subject;

	let m = text.match(/^draws? (?:(up to) )?(\S+) cards?$/);
	if (m) {
		const amount = count(m[2]);
		if (!amount) return false;
		p.push({ verb: 'draw', subject, amount, ...(m[1] ? { params: { upTo: true } } : opt), span }, false);
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
	m = text.match(/^mills? (\S+) cards?$/);
	if (m) {
		const amount = count(m[1]);
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
	if (/^sacrifices? ~$/.test(text) && subject.k === 'player' && subject.filter.relation === 'you') {
		p.push({ verb: 'sacrifice', subject: { k: 'self' }, ...opt, span }, false);
		return true;
	}
	// Step E2: "sacrifices a creature", "sacrifice two artifacts": the player chooses (CR 701.21a).
	m = text.match(/^sacrifices? (a|an|one|two|three|\d+) (.+)$/);
	if (m && !optional) {
		const amount = count(m[1] === 'a' || m[1] === 'an' ? 'one' : m[1]);
		const filter = amount && objectFilter(m[2]);
		if (!amount || !filter || filter.zone || filter.controller) return false;
		const step: EffectStep = { verb: 'sacrifice', subject: { k: 'all', filter: { ...filter, zone: 'battlefield' } }, amount, span };
		if (subject.k === 'player' && subject.filter.relation === 'each_opponent') {
			(step.subject as { filter: ObjectFilter }).filter.controller = 'opponent';
		} else if (subject.k === 'playerRef' && subject.ref.k === 'target') {
			step.actor = subject.ref;
		} else if (!(subject.k === 'player' && subject.filter.relation === 'you')) {
			return false;
		}
		p.push(step, true);
		return true;
	}
	// Step E2: "discards two cards" (the player chooses, CR 701.8b).
	m = text.match(/^discards? (a|one|two|three|\d+) cards?$/);
	if (m && !optional && (subject.k === 'player' || (subject.k === 'playerRef' && subject.ref.k === 'target'))) {
		const amount = count(m[1] === 'a' ? 'one' : m[1]);
		if (!amount) return false;
		p.push({ verb: 'discard', subject, amount, span }, true);
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

/** Clauses without a subject: "Destroy target creature", "Draw a card", "Create a Treasure token". */
function imperative(p: Parser, text: string, span: Span): ClauseResult {
	const t = text.trim();
	let m: RegExpMatchArray | null;

	if (/^(?:draw|gain|lose|mill|create|search|take|scry|sacrifice|discard)\b/.test(t) && !/^lose hexproof/.test(t) && !/^create a token that's a copy\b/.test(t)) {
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
	m = t.match(/^attach(?: ~)? to (target .+ you control)$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.selector.k !== 'target') return false;
		p.push({ verb: 'attach', subject: obj.selector, span }, true);
		return true;
	}
	m = t.match(/^(destroy|exile) (.+)$/);
	if (m) {
		const obj = objectPhrase(p, m[2]);
		if (!obj) return false;
		const verb = m[1] as 'destroy' | 'exile';
		if (verb === 'destroy' && obj.selector.k === 'self') return false;
		p.push({ verb, subject: obj.selector, span }, true);
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
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.fromZone) return false;
		if (obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'graveyard') {
			p.push({ verb: 'move', subject: obj.selector, params: { from: 'graveyard', to: 'hand' }, span }, true);
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
	m = t.match(/^(?:return|put) (.+) (?:to|onto) the battlefield( tapped)?( under your control)?$/);
	if (m) {
		const self = m[1] === '~ from your graveyard' || (m[1] === '~' && p.context === 'triggered');
		const obj = self ? { selector: { k: 'self' } as Selector, fromZone: 'graveyard' as const } : objectPhrase(p, m[1]);
		if (!obj) return false;
		const fromGy =
			obj.fromZone === 'graveyard' ||
			(obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'graveyard');
		if (!fromGy) return false;
		const params: EffectStep['params'] = { from: 'graveyard', to: 'battlefield' };
		if ('topmostOnly' in obj && obj.topmostOnly) params.topmostOnly = true;
		if (m[2]) params.tapped = true;
		if (m[3]) params.underYourControl = true;
		p.push({ verb: 'move', subject: obj.selector, params, span }, true);
		return true;
	}
	m = t.match(/^return (.+) to (?:your|its owner's|their owner's|their owners') hands?$/);
	if (m) {
		const obj = objectPhrase(p, m[1]);
		if (!obj) return false;
		const fromGy = obj.selector.k === 'target' && p.targets[obj.selector.index].filter.zone === 'graveyard';
		if (!fromGy) return false;
		p.push({ verb: 'move', subject: obj.selector, params: { from: 'graveyard', to: 'hand' }, span }, true);
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
		const obj = objectPhrase(p, m[1]);
		if (!obj || obj.selector.k !== 'target' || p.targets[obj.selector.index].filter.zone !== 'stack') return false;
		p.push({ verb: 'copySpell', subject: obj.selector, span }, true);
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
	m = t.match(/^look at the top (\S+) cards of your library$/);
	if (m) {
		const amount = count(m[1]);
		if (!amount) return false;
		p.push({ verb: 'dig', subject: YOU, amount, span }, false);
		return true;
	}
	if (/^take an extra turn after this one$/.test(t)) return playerPredicate(p, YOU, t, span, true);
	return false;
}

/** "Add {R}{R}{R}", "Add one mana of any color", "Add {G} for each Elf you control". */
function addMana(p: Parser, text: string, span: Span): ClauseResult {
	const t = text.trim().replace(/^an additional\s+/i, '');
	const symbols = (s: string) => (s.match(/\{([WUBRGC])\}/g) ?? []).map((x) => x[1] as ManaColor);
	if (/^(?:\{[WUBRGC]\})+$/.test(t)) {
		const mana = symbols(t);
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(mana.length), params: { mana }, span }, false);
		return true;
	}
	if (/^\{[WUBRGC]\}(?:, \{[WUBRGC]\})*,? or \{[WUBRGC]\}$/.test(t)) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(1), params: { manaChoice: symbols(t) }, span }, false);
		return true;
	}
	let m = t.match(/^(\S+) mana of any (?:one )?color$/);
	if (m && count(m[1])) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: count(m[1])!, params: { manaChoice: 'any' }, span }, false);
		return true;
	}
	if (/^one mana of any color in your commander's color identity$/.test(t)) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(1), params: { manaChoice: 'commanderIdentity' }, span }, false);
		return true;
	}
	if (/^one mana of any color that a land an opponent controls could produce$/.test(t)) {
		p.push({ verb: 'addMana', subject: { k: 'none' }, amount: n(1), params: { manaChoice: 'opponentLandColors' }, span }, false);
		return true;
	}
	m = t.match(/^\{([WUBRGC])\} for each (.+)$/);
	if (m) {
		const amount = /^card in target opponent's hand$/.test(m[2]) ? null : numberOf(m[2].replace(/^(\S+)/, (w) => w));
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
	/^(?:you|each opponent|each player|target player|target opponent|its controller|its owner|that player|they|draw|draws|lose|loses|gain|gains|get|gets|put|exile|destroy|return|create|creates|search|scry|mill|mills|sacrifice|deal|deals|add|take|takes|phase|phases|attach|counter|proliferate|switch|look|tap|untap|fight|fights)\b/;

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

/** One clause: an imperative, or a subject followed by a predicate. */
function clause(p: Parser, c: Clause): ClauseResult {
	const t = c.text.trim();
	if (!t) return false;
	if (imperative(p, t, c.span)) return true;

	// Player subjects.
	const ps = t.match(
		/^(you|each opponent|each player|target player|target opponent|its controller|its owner|that player|they|the player whose turn it is|(?:that creature's|that permanent's) controller) (.+)$/
	);
	if (ps) {
		const subject = playerPhrase(p, ps[1]);
		if (subject && playerPredicate(p, subject, ps[2], c.span)) return true;
	}
	// A continued predicate with the previous player as subject ("... and loses 2 life").
	if (p.lastPlayer && /^(?:draws?|loses?|gains?|mills?|creates?)\b/.test(t)) {
		if (playerPredicate(p, p.lastPlayer, t, c.span)) return true;
	}
	// Object subjects: try each split point, longest subject first.
	const dur = t.match(/^until end of turn, (.+)$/);
	const body = dur ? dur[1] : t;
	const words = body.split(' ');
	for (let i = words.length - 1; i >= 1; i--) {
		const subjText = words.slice(0, i).join(' ');
		const vp = words.slice(i).join(' ') + (dur ? ' until end of turn' : '');
		if (!/^(?:gets?|gains?|phases?|deals|fights?)\b/.test(vp)) continue;
		const snapshot = p.targets.length;
		const subject = objectPhrase(p, subjText);
		if (!subject) continue;
		if (objectPredicate(p, subject, vp, c.span)) return true;
		p.targets.length = snapshot;
	}
	const perCmdCast = t.match(
		/^(.+?) for each time you've cast (?:your|a) commander from the command zone this game( until end of turn)?$/i
	);
	if (perCmdCast) {
		const mark = p.mark();
		const baseClauseText = `${perCmdCast[1]}${perCmdCast[2] ?? ''}`;
		if (clause(p, { text: baseClauseText, span: c.span }) && p.steps.length > mark.steps) {
			const scaleAmount = (a: Amount | undefined): Amount | null => {
				if (!a || a.k !== 'const') return null;
				if (a.n === 1) return { k: 'commanderCastCount' };
				if (a.n === 0) return a;
				if (a.n === -1) return { k: 'negate', of: { k: 'commanderCastCount' } };
				return null;
			};
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
	}
	return false;
}

/** Sentence-initial words that are not names or subtypes, so they can be lower-cased. */
const LOWER_START = new Set([
	'a', 'add', 'all', 'an', 'another', 'any', 'at', 'attach', 'copy', 'counter', 'create', 'creatures', 'deal', 'destroy', 'draw',
	'each', 'end', 'exile', 'fight', 'gain', 'if', 'it', 'its', 'look', 'lose', 'mill', 'permanents', 'proliferate', 'put',
	'return', 'sacrifice', 'scry', 'search', 'switch', 'take', 'tap', 'target', 'that', 'the', 'then', 'they', 'those',
	'untap', 'until', 'up', 'you', 'your'
]);

// ---- Sentences ------------------------------------------------------------------------------

const NEXT_END_STEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'each_turn' };
const THAT_TURNS_END_STEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'end_step' }, scope: 'controller_turn' };
const NEXT_TURNS_UPKEEP: TriggerDef = { event: 'phaseBegin', filter: { phase: 'upkeep' }, scope: 'each_turn' };

function delayedTrigger(when: string): { trigger: TriggerDef; nextTurn?: boolean } | null {
	if (when === 'the next end step') return { trigger: NEXT_END_STEP };
	if (when === "that turn's end step") return { trigger: THAT_TURNS_END_STEP };
	if (when === "the next turn's upkeep") return { trigger: NEXT_TURNS_UPKEEP, nextTurn: true };
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
	if (NEUTRAL_SENTENCES.some((re) => re.test(t0))) return true;
	if (RESTRICTION_SENTENCES.some((re) => re.test(t0))) return true;

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
	if (t === 'put up to one of them on top of your library and the rest on the bottom of your library in a random order') {
		const prev = p.steps[p.steps.length - 1];
		if (prev?.verb !== 'dig') return fail();
		prev.params = {
			...prev.params,
			dig: { keep: 1, upTo: true, keepTo: 'libraryTop', rest: 'libraryBottom', restRandom: true }
		};
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

	// Delayed effects: "At the beginning of the next end step, exile it." / "Exile it at the beginning of the next end step."
	const lead = t.match(/^at the beginning of (the next end step|that turn's end step|the next turn's upkeep), (.+)$/);
	const trail = t.match(/^(.+) at the beginning of (the next end step|that turn's end step|the next turn's upkeep)$/);
	if (lead || trail) {
		const dt = delayedTrigger(lead ? lead[1] : trail![2]);
		const inner = lead ? lead[2] : trail![1];
		if (!dt) return fail();
		const before = p.steps.length;
		if (!clauses(p, inner, span.start)) return fail();
		const effect = p.steps.splice(before);
		effect.forEach((s) => (s.span = span));
		p.push(
			{
				verb: 'delayedTrigger',
				subject: { k: 'none' },
				delayed: { trigger: dt.trigger, ...(dt.nextTurn ? { nextTurn: true } : {}), effect },
				span
			},
			false
		);
		return true;
	}

	// X definitions at the end of the sentence.
	const wx = whereX(t);
	if (wx.bad) return fail();
	if (!clauses(p, wx.text, span.start)) return fail();
	if (wx.x) {
		p.definedX = wx.x;
		for (const s of p.steps.slice(stepsBefore)) {
			if (s.amount) s.amount = substituteX(s.amount, wx.x);
			if (s.params?.toughness) s.params.toughness = substituteX(s.params.toughness, wx.x);
		}
	}
	return true;
}

function clauses(p: Parser, text: string, offset: number): boolean {
	// A search clause consumes the rest of the sentence ("..., put it into your hand, then shuffle").
	const search = text.match(/^(.*?)\b((?:its controller may |you may |they may )?search(?:es)? (?:your|their) library .+)$/);
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
		if (!clause(p, c)) {
			p.rollback(mark);
			return false;
		}
	}
	return true;
}

// ---- Entry points ---------------------------------------------------------------------------

/**
 * Parses effect text (one or more sentences of normalised text). `offset` is the position of `text`
 * in the face's normalised text, so spans line up with the rest of the IR.
 */
export function parseEffects(text: string, offset = 0, context: EffectContext = 'spell'): EffectParse {
	const p = new Parser(context);
	for (const s of splitSentences(text, offset)) {
		if (!sentence(p, s.text, s.span)) p.unparsed.push(s.span);
	}
	return { steps: p.steps, targets: p.targets, unparsed: p.unparsed };
}

/** "Choose one —" + bullet lines. */
function parseModal(header: string, bullets: Array<{ text: string; start: number; end: number }>): EffectParse {
	const counts: Record<string, [number, number]> = {
		'choose one —': [1, 1],
		'choose two —': [2, 2],
		'choose one or both —': [1, 2],
		'choose one or more —': [1, bullets.length],
		'choose any number —': [0, bullets.length]
	};
	const range = counts[header.toLowerCase()];
	const unparsed: Span[] = [];
	const modes: ModalDef['modes'] = [];
	for (const b of bullets) {
		const body = b.text.replace(/^•\s*/, '');
		const start = b.start + (b.text.length - body.length);
		const parse = parseEffects(body, start, 'spell');
		unparsed.push(...parse.unparsed);
		modes.push({ targets: parse.targets, effect: parse.steps, span: { start: b.start, end: b.end } });
	}
	if (!range) unparsed.push({ start: bullets[0]?.start ?? 0, end: bullets[bullets.length - 1]?.end ?? 0 });
	return { steps: [], targets: [], modal: { min: range?.[0] ?? 1, max: range?.[1] ?? 1, modes }, unparsed };
}

/** Lines of an instant or sorcery that aren't part of its effect. */
function isNonEffectLine(body: string): boolean {
	// Implemented/handled spell keyword lines ("Buyback {2}", "Overload {6}{U}", "Suspend 4—{U}", "Flash") have no period.
	if (!/[.!]$/.test(body) && /^(?:overload|suspend|flash|buyback)\b/i.test(body.trim())) return true;
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
		if (/^choose\b.*—$/i.test(line.text)) {
			const bullets: Array<{ text: string; start: number; end: number }> = [];
			while (lines[i + 1]?.text.startsWith('•')) {
				const b = lines[++i];
				bullets.push({ text: b.text, start: b.span.start, end: b.span.end });
			}
			const m = parseModal(line.text, bullets);
			modal = m.modal;
			unparsed.push(...m.unparsed);
			continue;
		}
		if (isNonEffectLine(line.body)) continue;
		if (/^(?:when|whenever|at the beginning of (?:your|each|the))\b/i.test(line.body) && !/^at the beginning of (?:the next|that turn's)/i.test(line.body)) {
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
		if (!sentence(p, s.text, s.span)) p.unparsed.push(s.span);
	}
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

/**
 * The compiled effect of a resolving spell or activated ability. Lives in the compiler because it
 * reads the stack item's rules text; the runtime only sees the result. Cached per text.
 */
export function compiledStackItemEffects(item: StackItem): EffectParse | null {
	if (item.kind !== 'spell' && item.kind !== 'activated') return null;
	const card: ScryfallCard = item.card;
	const text = item.kind === 'spell' ? card.oracleText : item.oracleText;
	if (item.kind === 'spell' && !/\b(?:Instant|Sorcery)\b/.test(card.typeLine)) return null;
	if (card.backFace || card.oracleText.includes('\n//\n')) return null;
	const key = `${item.kind}:${hashText(card.name)}:${hashText(text)}`;
	const cached = STACK_CACHE.get(key);
	if (cached) return cached;
	const out = item.kind === 'spell' ? parseSpellText(card.name, text) : parseAbilityEffectText(card.name, text);
	STACK_CACHE.set(key, out);
	return out;
}

/**
 * Compiled `addMana` steps of a card's activated abilities, for CR 106.7 ("any color that a land
 * an opponent controls could produce"). Lives in the compiler so the runtime never reads rules text.
 */
export function compiledCardManaSteps(card: ScryfallCard): EffectStep[] {
	if (card.backFace || card.oracleText.includes('\n//\n')) return [];
	const key = `${hashText(card.name)}:${hashText(card.oracleText)}`;
	const cached = MANA_STEPS_CACHE.get(key);
	if (cached) return cached;
	const norm = normalizeFace(card.name, card.oracleText);
	const out: EffectStep[] = [];
	for (const line of norm.lines) {
		const quote = line.body.search(/["“]/);
		const colon = line.body.indexOf(':');
		if (colon <= 0 || (quote >= 0 && quote < colon) || /^(?:when|whenever|at|choose)\b/i.test(line.body)) continue;
		const parse = parseEffects(line.body.slice(colon + 1).trim(), 0, 'activated');
		for (const s of parse.steps) if (s.verb === 'addMana') out.push(s);
	}
	MANA_STEPS_CACHE.set(key, out);
	return out;
}
