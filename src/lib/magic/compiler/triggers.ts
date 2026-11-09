/**
 * Trigger-condition grammar (ENGINE_ARCHITECTURE_PLAN.md section 2.2, CR 603.1).
 *
 * Parses the head of a triggered ability ("When ~ enters", "Whenever a land you control enters",
 * "At the beginning of your upkeep") and its intervening-if clause (CR 603.4) into a TriggerDef and a
 * Condition, and says where the effect text starts. Input is normalised text (self-references are
 * `~`, ability words already stripped). Anything not understood is reported as an unparsed span.
 *
 * Runs alongside the Phase 1 adapter for now. scripts/magic-triggers-diff.ts compares the two.
 */
import type { Amount, CardDefinition, Condition, EventFilter, ObjectFilter, Span, TriggerDef } from '../ir.ts';
import type { GamePhase, ParsedEffect, TriggerScope } from '../types.ts';
import { parseObjectPhrase } from './costs.ts';

export interface TriggerParse {
	trigger?: TriggerDef;
	condition?: Condition;
	/** Offset (in the caller's coordinates) where the effect text starts. */
	effectStart: number;
	/** Parts of the trigger head or condition no production understood. */
	unparsed: Span[];
}

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
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50
};

function number(word: string): number | null {
	const low = word.toLowerCase();
	if (/^\d+$/.test(low)) return parseInt(low, 10);
	return NUMBER_WORDS[low] ?? null;
}

const n = (value: number): Amount => ({ k: 'const', n: value });

// ---- Phases ---------------------------------------------------------------------------------

const STEPS: Record<string, GamePhase> = {
	upkeep: 'upkeep',
	'draw step': 'draw',
	'end step': 'end_step',
	'precombat main phase': 'main1',
	'first main phase': 'main1',
	'postcombat main phase': 'main2',
	'second main phase': 'main2'
};

/** "your upkeep", "each opponent's end step", "combat on your turn", "each combat". */
function phaseBegin(rest: string): TriggerDef | null {
	if (rest === 'combat on your turn') return { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'controller_turn' };
	if (rest === 'each combat') return { event: 'phaseBegin', filter: { phase: 'begin_combat' }, scope: 'each_turn' };
	const m = rest.match(/^(each other player's|each opponent's|each player's|each|your|the) (.+)$/);
	if (!m) return null;
	const phase = STEPS[m[2]];
	if (!phase) return null;
	const scope: TriggerScope =
		m[1] === 'your' ? 'controller_turn' : m[1] === "each opponent's" || m[1] === "each other player's" ? 'opponent_turn' : 'each_turn';
	// "the end step" only means "each" outside a delayed trigger ("the next end step" is delayed).
	return { event: 'phaseBegin', filter: { phase }, scope };
}

// ---- Subjects -------------------------------------------------------------------------------

interface Subject {
	object?: EventFilter['object'];
	orSelf?: boolean;
	oneOrMore?: boolean;
	player?: EventFilter['player'];
}

function objectSubject(text: string): Subject | null {
	if (text === '~') return { object: 'self' };
	if (text === 'equipped creature' || text === 'enchanted creature' || text === 'enchanted permanent') {
		return { object: 'attachedTo' };
	}
	const orSelf = text.match(/^~ or (another .+)$/);
	if (orSelf) {
		const s = objectSubject(orSelf[1]);
		return s && typeof s.object === 'object' ? { ...s, orSelf: true } : null;
	}
	let phrase = text;
	let oneOrMore: true | undefined;
	if (/^one or more /.test(phrase)) {
		phrase = phrase.slice('one or more '.length);
		oneOrMore = true;
	} else if (/^(?:a|an) /.test(phrase)) {
		phrase = phrase.replace(/^(?:a|an) /, '');
	} else if (!/^another /.test(phrase)) {
		return null;
	}
	// "a creature an opponent controls" / "a creature you don't control".
	let controller: ObjectFilter['controller'];
	const opp = phrase.match(/^(.+) (?:an opponent controls|your opponents control|you don't control)$/);
	if (opp) {
		phrase = opp[1];
		controller = 'opponent';
	}
	const filter = parseObjectPhrase(phrase);
	if (!filter) return null;
	if (controller) {
		if (filter.controller) return null;
		filter.controller = controller;
	}
	return { object: filter, oneOrMore };
}

function playerSubject(text: string): EventFilter['player'] | null {
	if (text === 'you') return { relation: 'you' };
	if (text === 'a player') return { relation: 'any' };
	if (text === 'an opponent') return { relation: 'opponent' };
	return null;
}

// ---- Events ---------------------------------------------------------------------------------

/** One object event: "enters", "dies", "attacks", "deals combat damage to a player", ... */
function objectEvent(verb: string, subject: Subject): TriggerDef | null {
	const base: EventFilter = {};
	if (subject.object !== undefined) base.object = subject.object;
	if (subject.orSelf) base.orSelf = true;
	if (subject.oneOrMore) base.oneOrMore = true;
	const def = (event: TriggerDef['event'], extra: EventFilter = {}): TriggerDef => ({
		event,
		filter: { ...base, ...extra }
	});

	switch (verb) {
		case 'enters':
		case 'enter':
		case 'enters the battlefield':
			return def('zoneChange', { to: 'battlefield' });
		case 'enters the battlefield under your control':
		case 'enters under your control': {
			if (typeof base.object !== 'object') return null;
			return { event: 'zoneChange', filter: { ...base, object: { ...base.object, controller: 'you' }, to: 'battlefield' } };
		}
		case 'dies':
		case 'die':
		case 'is put into a graveyard from the battlefield':
		case 'are put into a graveyard from the battlefield':
			return def('zoneChange', { from: 'battlefield', to: 'graveyard' });
		case 'leaves the battlefield':
		case 'leave the battlefield':
			return def('zoneChange', { from: 'battlefield' });
		case 'attacks':
		case 'attack':
			return def('attacks');
		case 'blocks':
		case 'block':
			return def('blocks');
		case 'becomes blocked':
			return def('becomesBlocked');
		case 'becomes tapped':
			return def('becomesTapped');
		case 'is dealt damage':
			return def('dealtDamage');
		case 'deals combat damage to a player':
		case 'deal combat damage to a player':
			return def('dealsDamage', { combat: true, damageTo: 'player' });
		case 'deals combat damage to a creature':
			return def('dealsDamage', { combat: true, damageTo: 'creature' });
		case 'deals combat damage to a player or planeswalker':
			return def('dealsDamage', { combat: true, damageTo: 'playerOrPlaneswalker' });
		case 'deals combat damage':
			return def('dealsDamage', { combat: true, damageTo: 'any' });
		case 'deals damage to a player':
			return def('dealsDamage', { damageTo: 'player' });
		case 'deals damage':
			return def('dealsDamage', { damageTo: 'any' });
		case 'becomes the target of a spell or ability':
			return def('becomesTarget', { targetedBy: 'spellOrAbility' });
		case 'becomes the target of a spell':
			return def('becomesTarget', { targetedBy: 'spell' });
		case 'becomes the target of an ability':
			return def('becomesTarget', { targetedBy: 'ability' });
		case 'becomes attached to a creature':
			return def('attached', { host: { types: ['Creature'] } });
		case 'becomes attached to a creature you control':
			return def('attached', { host: { types: ['Creature'], controller: 'you' } });
		default:
			return null;
	}
}

/** "Whenever ~ enters or attacks", "Whenever ~ attacks or blocks". */
function objectEvents(verbs: string, subject: Subject): TriggerDef | null {
	const whole = objectEvent(verbs, subject);
	if (whole) return whole;
	const parts = verbs.split(/,? or |, /);
	if (parts.length < 2) return null;
	const defs = parts.map((v) => objectEvent(v, subject));
	if (defs.some((d) => !d)) return null;
	return { ...defs[0]!, or: defs.slice(1) as TriggerDef[] };
}

/** The spell part of "you cast a creature spell": "a spell", "an instant or sorcery spell", "~". */
function spellFilter(text: string): EventFilter['object'] | null {
	if (text === '~') return 'self';
	const m = text.match(/^(?:a|an) (.+)$/);
	if (!m) return null;
	if (m[1] === 'spell') return {};
	const spell = m[1].match(/^(.+) spell$/);
	// "card" gives modifier-only phrases a noun: "noncreature" -> "noncreature card".
	return spell ? parseObjectPhrase(`${spell[1]} card`) : null;
}

function playerEvent(player: EventFilter['player'], rest: string): TriggerDef | null {
	const cast = rest.match(/^(cast or copy|casts or copies|casts?) (.+)$/);
	if (cast) {
		const object = spellFilter(cast[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player };
		if (/copy|copies/.test(cast[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	if (player?.relation === 'you' && rest === 'attack') {
		return { event: 'attacks', filter: { player, oneOrMore: true } };
	}
	if (rest === 'gain life' || rest === 'gains life') return { event: 'gainLife', filter: { player } };
	if (rest === 'draw a card' || rest === 'draws a card') return { event: 'drawCard', filter: { player } };
	return null;
}

/** "a +1/+1 counter is put on ~", "one or more +1/+1 counters are put on ~". */
function counterEvent(head: string): TriggerDef | null {
	const m = head.match(/^(?:a|one or more) \+1\/\+1 counters? (?:is|are) (?:put|placed) on ~$/);
	return m ? { event: 'counterPlaced', filter: { object: 'self', counter: '+1/+1' } } : null;
}

function triggerHead(head: string): TriggerDef | null {
	const at = head.match(/^at the beginning of (.+)$/i);
	if (at) return phaseBegin(at[1].toLowerCase());

	const ww = head.match(/^(?:when|whenever) (.+)$/i);
	if (!ww) return null;
	const body = ww[1];
	const counter = counterEvent(body);
	if (counter) return counter;

	// Player subjects first ("you cast", "an opponent draws a card").
	const ps = body.match(/^(you|a player|an opponent) (.+)$/);
	if (ps) {
		const ev = playerEvent(playerSubject(ps[1])!, ps[2]);
		if (ev) return ev;
	}

	// Object subjects: try every split point between subject and verb, longest subject first.
	const words = body.split(' ');
	for (let i = words.length - 1; i >= 1; i--) {
		const subject = objectSubject(words.slice(0, i).join(' '));
		if (!subject) continue;
		const ev = objectEvents(words.slice(i).join(' '), subject);
		if (ev) return ev;
	}
	return null;
}

// ---- Intervening-if conditions --------------------------------------------------------------

export function parseCondition(text: string): Condition | null {
	const t = text.trim();
	let m = t.match(/^if you have (\S+) or more life$/);
	if (m && number(m[1]) !== null) {
		return { k: 'compare', left: { k: 'life', of: { k: 'you' } }, op: '>=', right: n(number(m[1])!) };
	}
	m = t.match(/^if you control (\S+) or more (.+)$/);
	if (m && number(m[1]) !== null) {
		const filter = parseObjectPhrase(m[2]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(number(m[1])!) };
		}
	}
	m = t.match(/^if you control (?:a|an) (.+)$/);
	if (m) {
		const filter = parseObjectPhrase(m[1]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(1) };
		}
	}
	m = t.match(/^if you control no (.+)$/);
	if (m) {
		const filter = parseObjectPhrase(m[1]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '=', right: n(0) };
		}
	}
	m = t.match(/^if ~ is in your graveyard with (\S+) or more creature cards above it$/);
	if (m && number(m[1]) !== null) {
		return { k: 'graveyardAbove', filter: { types: ['Creature'] }, count: number(m[1])! };
	}
	if (t === 'if you have no cards in hand') {
		return { k: 'compare', left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } }, op: '=', right: n(0) };
	}
	if (t === "if it's your turn") return { k: 'isTurnOf', player: { k: 'you' } };
	if (t === "if it's not your turn") return { k: 'not', of: { k: 'isTurnOf', player: { k: 'you' } } };
	return null;
}

// ---- Entry point ----------------------------------------------------------------------------

/**
 * Parses the head of a triggered ability. Returns null if `body` isn't a triggered ability (doesn't
 * start with When/Whenever/At). `offset` is the position of `body` in the caller's text.
 */
export function parseTriggerHeader(body: string, offset = 0): TriggerParse | null {
	if (!/^(?:when|whenever|at)\b/i.test(body)) return null;
	const comma = body.indexOf(',');
	if (comma < 0) return { effectStart: offset + body.length, unparsed: [{ start: offset, end: offset + body.length }] };

	const unparsed: Span[] = [];
	const head = body.slice(0, comma);
	const trigger = triggerHead(head) ?? undefined;
	if (!trigger) unparsed.push({ start: offset, end: offset + head.length });

	let effectStart = comma + 1;
	let condition: Condition | undefined;
	const rest = body.slice(effectStart);
	const lead = rest.length - rest.trimStart().length;
	if (/^if\b/i.test(rest.trimStart())) {
		const condStart = effectStart + lead;
		const condEnd = body.indexOf(',', condStart);
		if (condEnd < 0) {
			unparsed.push({ start: offset + condStart, end: offset + body.length });
			return { trigger, effectStart: offset + body.length, unparsed };
		}
		condition = parseCondition(body.slice(condStart, condEnd)) ?? undefined;
		if (!condition) unparsed.push({ start: offset + condStart, end: offset + condEnd });
		effectStart = condEnd + 1;
	}
	if (trigger && condition && condition.k === 'graveyardAbove') trigger.fromZone = 'graveyard';

	const after = body.slice(effectStart);
	effectStart += after.length - after.trimStart().length;
	return { trigger, condition, effectStart: offset + effectStart, unparsed };
}

// ---- What the runtime can match (Phase 5) ----------------------------------------------------

/** Phases the engine emits PhaseBegin for (beginPhase). It never begins `begin_combat`. */
const RUNTIME_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>(['upkeep', 'draw', 'main1', 'main2', 'end_step']);

/** ObjectFilter fields runtime/triggers.ts checks. A filter using any other field never matches. */
const RUNTIME_OBJECT_FIELDS: ReadonlySet<string> = new Set([
	'types',
	'subtypes',
	'supertypes',
	'notTypes',
	'controller',
	'token',
	'other',
	'colors',
	'tapped'
]);

/** EventFilter fields each event kind's matcher checks (runtime/triggers.ts). */
const RUNTIME_EVENT_FIELDS: Partial<Record<TriggerDef['event'], ReadonlySet<string>>> = {
	zoneChange: new Set(['object', 'orSelf', 'from', 'to']),
	cast: new Set(['object', 'player', 'orCopy']),
	attacks: new Set(['object', 'oneOrMore', 'player']),
	blocks: new Set(['object']),
	becomesBlocked: new Set(['object']),
	dealsDamage: new Set(['object', 'orSelf', 'combat', 'damageTo']),
	dealtDamage: new Set(['object']),
	phaseBegin: new Set(['phase']),
	counterPlaced: new Set(['object', 'counter']),
	becomesTarget: new Set(['object', 'targetedBy']),
	attached: new Set(['object', 'host'])
};

function objectFilterProblem(f: ObjectFilter | undefined): string | null {
	if (!f) return null;
	for (const key of Object.keys(f)) {
		if (!RUNTIME_OBJECT_FIELDS.has(key)) return `object filter field "${key}"`;
	}
	return null;
}

/**
 * Why the runtime can't honour this trigger, or null if it can. A trigger the runtime can't check
 * exactly must never fire (it would fire on the wrong events), so the compiler marks the ability
 * unsupported (`event_not_implemented`).
 */
export function runtimeTriggerProblem(def: TriggerDef): string | null {
	const fields = RUNTIME_EVENT_FIELDS[def.event];
	if (!fields) return `event "${def.event}" is not emitted`;
	for (const key of Object.keys(def.filter)) {
		if (!fields.has(key)) return `${def.event} filter field "${key}"`;
	}
	const f = def.filter;
	if (typeof f.object === 'object') {
		const p = objectFilterProblem(f.object);
		if (p) return p;
	}
	const p = objectFilterProblem(f.host);
	if (p) return p;
	// The object an Aura/Equipment is attached to has already been detached when it leaves.
	if (f.object === 'attachedTo' && !['attacks', 'dealsDamage'].includes(def.event)) {
		return `"${def.event}" of the attached-to object`;
	}
	if (def.event === 'phaseBegin' && (!f.phase || !RUNTIME_PHASES.has(f.phase))) return `phase "${f.phase}"`;
	if (def.event === 'becomesTarget' && f.targetedBy !== 'spell') return 'targeted by an ability';
	if (def.event === 'cast' && f.player && !['you', 'opponent', 'any'].includes(f.player.relation)) {
		return `caster "${f.player.relation}"`;
	}
	if (def.event === 'attacks' && f.player && f.player.relation !== 'you') return 'attacking player';
	if (def.fromZone && def.fromZone !== 'graveyard') return `functions from ${def.fromZone}`;
	for (const alt of def.or ?? []) {
		const q = runtimeTriggerProblem(alt);
		if (q) return q;
	}
	return null;
}

// ---- Legacy execution shim (Phase 5 -> Phase 3) ---------------------------------------------

/**
 * How a triggered ability's effect is executed until Phase 3's IR interpreter replaces the
 * ParsedEffect path: the legacy parser's effects for the ability's line, and the line's text (shown
 * on the stack). Attached to the compiled ability object; never stored in GameState.
 */
export interface LegacyTriggerExecution {
	effects: ParsedEffect[];
	/** The ability's line as printed (for the stack item and the log). */
	clause: string;
	/** True if the legacy rule tree / structured parser claimed this line (the pre-Phase-5 engine ran it). */
	legacyClaimed: boolean;
}

const LEGACY_EXECUTION = new WeakMap<object, LegacyTriggerExecution>();

export function setLegacyTriggerExecution(ability: object, exec: LegacyTriggerExecution): void {
	LEGACY_EXECUTION.set(ability, exec);
}

/** One triggered ability as the runtime matches it. */
export interface RuntimeTrigger {
	/** Index in compileCard(card).faces[0].abilities (stored on stack items, CR 603.4 re-check). */
	abilityIndex: number;
	trigger: TriggerDef;
	condition?: Condition;
	/** The IR effect is fully understood (kind 'triggered'); false: only the trigger head is. */
	effectSupported: boolean;
	legacy: LegacyTriggerExecution;
}

const RUNTIME_TRIGGERS = new WeakMap<CardDefinition, RuntimeTrigger[]>();

/**
 * The triggered abilities the runtime matches for a compiled card:
 * - abilities of kind 'triggered' (trigger, condition and effect understood), and
 * - unsupported abilities whose trigger head is understood but whose effect isn't, if the
 *   pre-Phase-5 engine already ran them (`legacyClaimed`), so nothing regresses. They keep running
 *   the legacy effects until Phase 3; section 2.7's guided resolution is the eventual fallback.
 * Abilities with no legacy effects never run (there's nothing to execute yet).
 */
export function runtimeTriggers(def: CardDefinition): RuntimeTrigger[] {
	const cached = RUNTIME_TRIGGERS.get(def);
	if (cached) return cached;
	const out: RuntimeTrigger[] = [];
	(def.faces[0]?.abilities ?? []).forEach((ab, abilityIndex) => {
		const legacy = LEGACY_EXECUTION.get(ab);
		if (!legacy || legacy.effects.length === 0) return;
		if (ab.kind === 'triggered') {
			out.push({ abilityIndex, trigger: ab.trigger, condition: ab.condition, effectSupported: true, legacy });
		} else if (ab.kind === 'unsupported' && ab.reason === 'unparsed' && ab.trigger && legacy.legacyClaimed) {
			out.push({ abilityIndex, trigger: ab.trigger, condition: ab.condition, effectSupported: false, legacy });
		}
	});
	RUNTIME_TRIGGERS.set(def, out);
	return out;
}
