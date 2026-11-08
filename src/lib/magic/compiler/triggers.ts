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
import type { Amount, Condition, EventFilter, ObjectFilter, Span, TriggerDef } from '../ir.ts';
import type { GamePhase, TriggerScope } from '../types.ts';
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
			return def('becomesTarget');
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
