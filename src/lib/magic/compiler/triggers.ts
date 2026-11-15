/**
 * Trigger-condition grammar (ENGINE_ARCHITECTURE_PLAN.md section 2.2, CR 603.1).
 *
 * Parses the head of a triggered ability ("When ~ enters", "Whenever a land you control enters",
 * "At the beginning of your upkeep") and its intervening-if clause (CR 603.4) into a TriggerDef and a
 * Condition, and says where the effect text starts. Input is normalised text (self-references are
 * `~`, ability words already stripped). Anything not understood is reported as an unparsed span.
 *
 * compiler/card.ts uses it for every "When/Whenever/At" line.
 */
import type { Amount, CardDefinition, Compare, Condition, CostDef, EffectStep, EventFilter, ModalDef, ObjectFilter, Span, TargetSpec, TriggerDef } from '../ir.ts';
import { getKeywordSpec } from '../keywords.ts';
import type { GamePhase, TriggerScope } from '../types.ts';
import { parseObjectPhrase, singularSubtype } from './costs.ts';

export interface TriggerParse {
	trigger?: TriggerDef;
	condition?: Condition;
	/** Offset (in the caller's coordinates) where the effect text starts. */
	effectStart: number;
	/** Parts of the trigger head or condition no production understood. */
	unparsed: Span[];
}

const NUMBER_WORDS: Record<string, number> = {
	zero: 0,
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
	attachedFilter?: ObjectFilter;
	orSelf?: boolean;
	oneOrMore?: boolean;
	player?: EventFilter['player'];
}

const ATTACHED_SUBJ_TYPES: Record<string, string> = {
	creature: 'Creature',
	land: 'Land',
	artifact: 'Artifact',
	enchantment: 'Enchantment',
	planeswalker: 'Planeswalker'
};

function objectSubject(text: string): Subject | null {
	if (text === '~') return { object: 'self' };
	if (text === 'equipped creature') {
		return { object: 'attachedTo', attachedFilter: { types: ['Creature'] } };
	}
	const enchSubj = text.match(/^enchanted (creature|permanent|land|artifact|enchantment|planeswalker)$/);
	if (enchSubj) {
		const mappedType = ATTACHED_SUBJ_TYPES[enchSubj[1]];
		return {
			object: 'attachedTo',
			...(mappedType ? { attachedFilter: { types: [mappedType] } } : {})
		};
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
	// "a creature an opponent controls" / "a creature you don't control" / "with toughness N [or greater/less]".
	let controller: ObjectFilter['controller'];
	let toughnessCmp: Compare | undefined;
	while (true) {
		const opp = phrase.match(/^(.+?)\s+(?:an opponent controls|your opponents control|you don't control)$/i);
		if (opp && !controller) {
			phrase = opp[1];
			controller = 'opponent';
			continue;
		}
		const withToughness = phrase.match(/^(.+?)\s+with toughness (\S+)(?: or (greater|more|less|fewer))?$/i);
		if (withToughness && !toughnessCmp) {
			const rawVal = withToughness[2];
			if (rawVal.toLowerCase() === 'a' || rawVal.toLowerCase() === 'an') return null;
			const numVal = number(rawVal);
			if (numVal === null) return null;
			const dir = withToughness[3]?.toLowerCase();
			toughnessCmp = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value: n(numVal) };
			phrase = withToughness[1];
			continue;
		}
		break;
	}
	const filter = parseObjectPhrase(phrase);
	if (!filter) return null;
	if (controller) {
		if (filter.controller) return null;
		filter.controller = controller;
	}
	if (toughnessCmp) {
		if (filter.toughness) return null;
		filter.toughness = toughnessCmp;
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
			return def('zoneChange', {
				from: 'battlefield',
				to: 'graveyard',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'is put into exile from the battlefield':
		case 'are put into exile from the battlefield':
			return def('zoneChange', {
				from: 'battlefield',
				to: 'exile',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'is put into exile':
		case 'are put into exile':
			if (subject.object !== 'attachedTo' && subject.object !== 'self') return null;
			return def('zoneChange', {
				from: 'battlefield',
				to: 'exile',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'leaves the battlefield':
		case 'leave the battlefield':
			return def('zoneChange', {
				from: 'battlefield',
				...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
			});
		case 'attacks':
		case 'attack':
			return def('attacks');
		case 'attacks while saddled':
		case 'attack while saddled':
			return def('attacks', { saddled: true });
		case 'blocks':
		case 'block':
			return def('blocks');
		case 'becomes blocked':
		case 'become blocked':
			return subject.oneOrMore ? null : def('becomesBlocked');
		case 'becomes tapped':
			return def('becomesTapped');
		case 'becomes crewed':
			return def('becomesCrewed');
		case 'becomes saddled':
			return def('becomesSaddled');
		case 'is exerted':
		case 'are exerted':
			return def('exert');
		case 'is dealt damage':
		case 'are dealt damage':
			return subject.oneOrMore ? null : def('dealtDamage');
		case 'deals combat damage to a player':
		case 'deal combat damage to a player':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'any' } })
				: def('dealsDamage', { combat: true, damageTo: 'player' });
		case 'deals combat damage to an opponent':
		case 'deals combat damage to one of your opponents':
		case 'deal combat damage to an opponent':
		case 'deal combat damage to one of your opponents':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'opponent' } })
				: def('dealsDamage', { combat: true, damageTo: 'player', player: { relation: 'opponent' } });
		case 'deals combat damage to you':
		case 'deal combat damage to you':
			return subject.oneOrMore
				? def('combatDamageBatchPlayer', { player: { relation: 'you' } })
				: def('dealsDamage', { combat: true, damageTo: 'player', player: { relation: 'you' } });
		case 'deals combat damage to a creature':
		case 'deal combat damage to a creature':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'creature' });
		case 'deals combat damage to a player or planeswalker':
		case 'deal combat damage to a player or planeswalker':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'playerOrPlaneswalker' });
		case 'deals combat damage':
		case 'deal combat damage':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: true, damageTo: 'any' });
		case 'deals damage to a player':
		case 'deal damage to a player':
			return subject.oneOrMore ? null : def('dealsDamage', { damageTo: 'player' });
		case 'deals damage to an opponent':
		case 'deals damage to one of your opponents':
		case 'deal damage to an opponent':
		case 'deal damage to one of your opponents':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { damageTo: 'player', player: { relation: 'opponent' } });
		case 'deals damage to you':
		case 'deal damage to you':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { damageTo: 'player', player: { relation: 'you' } });
		case 'deals damage':
		case 'deal damage':
			return subject.oneOrMore ? null : def('dealsDamage', { damageTo: 'any' });
		case 'becomes the target of a spell or ability':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'spellOrAbility' });
		case 'becomes the target of a spell':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'spell' });
		case 'becomes the target of an ability':
			return subject.oneOrMore ? null : def('becomesTarget', { targetedBy: 'ability' });
		case 'is tapped for mana':
			return def('tappedForMana');
		case 'becomes attached to a creature':
			return def('attached', { host: { types: ['Creature'] } });
		case 'becomes attached to a creature you control':
			return def('attached', { host: { types: ['Creature'], controller: 'you' } });
		case 'transforms':
		case 'transform':
			return def('transforms');
		case 'is turned face up':
		case 'are turned face up':
			return def('turnFaceUp');
		case 'explores':
		case 'explore':
			return def('explore');
		case 'connives':
		case 'connive':
			return def('connive');
		// --- Track P5 ---
		case 'becomes monstrous':
		case 'become monstrous':
			return def('becameMonstrous');
		default: {
			const transInto = verb.match(/^transforms? into (.+)$/i);
			if (transInto) {
				const phrase = transInto[1].replace(/^(?:a|an)\s+/i, '').trim();
				const qual = parseObjectPhrase(phrase);
				if (qual) return def('transforms', { toFaceFilter: qual });
			}
			const becomesTgt = verb.match(
				/^becomes? the target of (a spell or ability|a spell|an ability)(?: (an opponent controls|your opponents control|you don't control|you control))?$/i
			);
			if (becomesTgt && !subject.oneOrMore) {
				const rawBy = becomesTgt[1].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
				const rawCtrl = becomesTgt[2]?.toLowerCase();
				const player: EventFilter['player'] = !rawCtrl
					? undefined
					: rawCtrl === 'you control'
						? { relation: 'you' }
						: { relation: 'opponent' };
				return def('becomesTarget', { targetedBy, ...(player ? { player } : {}) });
			}
			return null;
		}
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
	const spell = m[1].match(
		/^(?:(.+) )?spell((?:\s+(?:of the chosen (?:type|color)|with (?:power|toughness|mana value) \S+(?: or (?:greater|more|less|fewer))?))+)?$/i
	);
	if (!spell) return null;
	// "card" gives modifier-only phrases a noun: "noncreature" -> "noncreature card".
	let phrase = `${spell[1] ? `${spell[1]} ` : ''}card${spell[2] ?? ''}`;
	let toughnessCmp: Compare | undefined;
	const withToughness = phrase.match(/^(.+?)\s+with toughness (\S+)(?: or (greater|more|less|fewer))?$/i);
	if (withToughness) {
		const rawVal = withToughness[2];
		if (rawVal.toLowerCase() === 'a' || rawVal.toLowerCase() === 'an') return null;
		const numVal = number(rawVal);
		if (numVal === null) return null;
		const dir = withToughness[3]?.toLowerCase();
		toughnessCmp = { op: !dir ? '=' : dir === 'greater' || dir === 'more' ? '>=' : '<=', value: n(numVal) };
		phrase = withToughness[1];
	}
	const parsed = parseObjectPhrase(phrase);
	if (!parsed) return null;
	if (toughnessCmp) {
		if (parsed.toughness) return null;
		parsed.toughness = toughnessCmp;
	}
	return parsed;
}

function discardedCardFilter(text: string): ObjectFilter | null {
	if (text === '~') return null;
	const m = text.match(/^(?:a|an) (.+)$/i);
	if (!m) return null;
	const inner = m[1].trim();
	if (/^card$/i.test(inner)) return {};
	if (!/\bcard$/i.test(inner)) return null;
	return parseObjectPhrase(inner);
}

const ORDINAL_WORDS: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3
};

function playerEvent(player: EventFilter['player'], rest: string): TriggerDef | null {
	if (player?.relation === 'you' && rest === 'cycle ~') {
		return { event: 'cycle', filter: { object: 'self', player }, fromZone: 'any' };
	}
	const cycleOrDiscard = rest.match(/^(?:cycle or discard|cycles or discards) (.+)$/);
	if (cycleOrDiscard) {
		const object = discardedCardFilter(cycleOrDiscard[1]);
		if (object) return { event: 'discard', filter: { player, object } };
	}
	const cycle = rest.match(/^cycles? (.+)$/);
	if (cycle) {
		const object = discardedCardFilter(cycle[1]);
		if (object) return { event: 'cycle', filter: { player, object } };
	}
	const discard = rest.match(/^discards? (.+)$/);
	if (discard) {
		const object = discardedCardFilter(discard[1]);
		if (object) return { event: 'discard', filter: { player, object } };
	}
	const nthCast = rest.match(/^casts? (your|their) (first|second|third) spell each turn$/);
	if (nthCast) {
		if ((nthCast[1] === 'your') !== (player?.relation === 'you')) return null;
		return { event: 'cast', filter: { object: {}, player, nthThisTurn: ORDINAL_WORDS[nthCast[2]] } };
	}
	const castTargetsSelf = rest.match(/^(cast or copy|casts or copies|casts?) (.+?) that targets ~$/);
	if (castTargetsSelf) {
		const object = spellFilter(castTargetsSelf[2]);
		if (object === null || object === 'self') return null;
		const filter: EventFilter = { object, player, targetsSelf: true };
		if (/copy|copies/.test(castTargetsSelf[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
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
	// "Whenever you tap a land for mana" / "Whenever a player taps a Forest for mana".
	const tap = rest.match(/^taps? (?:a|an) (.+) for mana$/);
	if (tap) {
		const object = parseObjectPhrase(tap[1]);
		if (object) return { event: 'tappedForMana', filter: { object, player } };
	}
	const nthDraw = rest.match(/^draws? (your|their) (first|second|third) card each turn$/);
	if (nthDraw) {
		if ((nthDraw[1] === 'your') !== (player?.relation === 'you')) return null;
		return { event: 'drawCard', filter: { player, nthThisTurn: ORDINAL_WORDS[nthDraw[2]] } };
	}
	if (rest === 'draw a card' || rest === 'draws a card') return { event: 'drawCard', filter: { player } };
	if (rest === 'investigate' || rest === 'investigates') return { event: 'investigate', filter: { player } };
	if (rest === 'surveil' || rest === 'surveils') return { event: 'surveil', filter: { player } };
	// --- Track P5 ---
	if (rest === 'amass' || rest === 'amasses') return { event: 'amass', filter: { player } };
	const amassSub = rest.match(/^amass(?:es)? ([A-Z][A-Za-z'-]*)$/);
	if (amassSub) {
		const sub = singularSubtype(amassSub[1]);
		if (sub) return { event: 'amass', filter: { player, amassSubtype: sub } };
	}
	if (rest === 'manifest dread' || rest === 'manifests dread') {
		return { event: 'manifestDread', filter: { player } };
	}
	if (/^becomes? the monarch$/i.test(rest)) return { event: 'becameMonarch', filter: { player } };
	const turnUp = rest.match(/^turns? (?:a|an) (.+) face up$/);
	if (turnUp) {
		const object = parseObjectPhrase(turnUp[1]);
		if (object) return { event: 'turnFaceUp', filter: { object, player } };
	}
	const foretell = rest.match(/^foretells? (.+)$/);
	if (foretell) {
		const object = discardedCardFilter(foretell[1]);
		if (object) return { event: 'foretell', filter: { object, player } };
	}
	const plot = rest.match(/^plots? (.+)$/);
	if (plot) {
		const object = discardedCardFilter(plot[1]);
		if (object) return { event: 'plot', filter: { object, player } };
	}
	const exert = rest.match(/^exerts? (?:(another .+?)|(?:a|an) (.+))$/);
	if (exert) {
		const object = parseObjectPhrase(exert[1] ?? exert[2]);
		if (object) return { event: 'exert', filter: { object, player } };
	}
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
	if (/^at (?:the )?end of combat$/i.test(head)) {
		return { event: 'phaseBegin', filter: { phase: 'end_combat' }, scope: 'each_turn' };
	}

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

export function canonicalKickerTag(raw: string): string {
	const t = raw.trim();
	if (/^(?:\{[^}]+\})+$/i.test(t)) {
		return t.replace(/\{([^}]+)\}/g, (_, inner: string) => `{${inner.trim().toUpperCase()}}`);
	}
	return t.toLowerCase();
}

export function parseCondition(text: string): Condition | null {
	const t = text.trim();
	if (/^if (?:it|~) was kicked$/i.test(t)) {
		return { k: 'kicked' };
	}
	if (/^if (?:it|~) was(?:n't| not) kicked$/i.test(t)) {
		return { k: 'not', of: { k: 'kicked' } };
	}
	if (/^if (?:it|~) was kicked twice$/i.test(t)) {
		return { k: 'kicked', minCount: 2 };
	}
	const kickedTimes = t.match(/^if (?:it|~) was kicked (\S+) times?$/i);
	if (kickedTimes) {
		const rawWord = kickedTimes[1].toLowerCase();
		const minCount = rawWord === 'once' ? 1 : number(rawWord);
		if (minCount !== null && minCount >= 1) {
			return { k: 'kicked', minCount };
		}
	}
	const kickedWithTag = t.match(/^if (?:it|~) was kicked with its (.+?) kicker$/i);
	if (kickedWithTag) {
		return { k: 'kicked', tag: canonicalKickerTag(kickedWithTag[1]) };
	}
	if (/^if (?:it|~) escaped$/i.test(t)) {
		return { k: 'escaped' };
	}
	if (/^if (?:it|~) (?:didn't|did not) escape$/i.test(t)) {
		return { k: 'not', of: { k: 'escaped' } };
	}
	if (/^if (?:its evoke cost was paid|(?:it|~) was evoked)$/i.test(t)) {
		return { k: 'evoked' };
	}
	if (/^if (?:its evoke cost was(?:n't| not) paid|(?:it|~) was(?:n't| not) evoked)$/i.test(t)) {
		return { k: 'not', of: { k: 'evoked' } };
	}
	if (/^if (?:it|~) was foretold$/i.test(t)) {
		return { k: 'foretold' };
	}
	if (/^if (?:it|~) was(?:n't| not) foretold$/i.test(t)) {
		return { k: 'not', of: { k: 'foretold' } };
	}
	if (/^if (?:(?:~|it) is|it's) saddled$/i.test(t)) {
		return { k: 'saddled' };
	}
	if (/^if (?:(?:~|it) is(?:n't| not)|it's not) saddled$/i.test(t)) {
		return { k: 'not', of: { k: 'saddled' } };
	}
	// --- Track P5 ---
	if (/^if (?:(?:~|it) (?:is|was)|it's) monstrous$/i.test(t)) {
		return { k: 'monstrous' };
	}
	if (/^if (?:(?:~|it) (?:is(?:n't| not)|was(?:n't| not))|it's not) monstrous$/i.test(t)) {
		return { k: 'not', of: { k: 'monstrous' } };
	}
	if (/^if (?:its blitz cost was paid|(?:it|~) was blitzed)$/i.test(t)) {
		return { k: 'blitzed' };
	}
	if (/^if (?:its blitz cost was(?:n't| not) paid|(?:it|~) was(?:n't| not) blitzed)$/i.test(t)) {
		return { k: 'not', of: { k: 'blitzed' } };
	}
	if (
		/^if (?:~|it|he|she|they) (?:is|are|was|were|has been|have been) exerted(?: this turn)?$/i.test(
			t
		)
	) {
		return { k: 'exertedThisTurn' };
	}
	if (
		/^if (?:(?:~|it|he|she|they) (?:is(?:n't| not)|are(?:n't| not)|was(?:n't| not)|were(?:n't| not)|has(?:n't| not) been|have(?:n't| not) been)|it's not) exerted(?: this turn)?$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'exertedThisTurn' } };
	}
	if (/^if you control (?:a|your) commander$/i.test(t)) {
		return { k: 'controlCommander' };
	}
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
	m = t.match(/^if you control (?:(?:a|an) (.+)|(another .+))$/i);
	if (m) {
		const filter = parseObjectPhrase(m[1] ?? m[2]);
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
	if (/^if you(?:'re| are) the monarch$/i.test(t)) return { k: 'isMonarch', player: { k: 'you' } };
	if (/^if you(?:'re not| aren't| are not) the monarch$/i.test(t)) {
		return { k: 'not', of: { k: 'isMonarch', player: { k: 'you' } } };
	}
	if (/^if an opponent is the monarch$/i.test(t)) return { k: 'isMonarch', relation: 'opponent' };
	if (/^if a player is the monarch$/i.test(t)) return { k: 'isMonarch', relation: 'any' };
	if (/^if there is no monarch$/i.test(t)) return { k: 'not', of: { k: 'isMonarch', relation: 'any' } };
	// --- Track P7 ---
	if (/^if a creature died this turn$/i.test(t)) return { k: 'creatureDiedThisTurn' };
	if (/^if (?:no creatures? died|a creature didn't die|a creature did not die) this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'creatureDiedThisTurn' } };
	}
	if (/^if you attacked(?: with a creature)? this turn$/i.test(t)) return { k: 'attackedThisTurn' };
	if (/^if you (?:didn't|did not) attack(?: with a creature)? this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'attackedThisTurn' } };
	}
	if (
		/^if a permanent (?:you controlled left the battlefield|left the battlefield under your control) this turn$/i.test(
			t
		)
	) {
		return { k: 'permanentLeftBattlefieldThisTurn' };
	}
	if (
		/^if no permanents? (?:you controlled left the battlefield|left the battlefield under your control) this turn$/i.test(
			t
		)
	) {
		return { k: 'not', of: { k: 'permanentLeftBattlefieldThisTurn' } };
	}
	if (/^if you(?:'ve| have)? gained life this turn$/i.test(t)) return { k: 'gainedLifeThisTurn' };
	const gainedMin = t.match(/^if you(?:'ve| have)? gained (\S+) or more life this turn$/i);
	if (gainedMin && number(gainedMin[1]) !== null) {
		return { k: 'gainedLifeThisTurn', min: n(number(gainedMin[1])!) };
	}
	if (/^if you (?:didn't gain|did not gain|haven't gained|have not gained) life this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'gainedLifeThisTurn' } };
	}
	if (/^if you cast (?:it|~) from your hand$/i.test(t)) return { k: 'wasCast', fromHand: true };
	if (/^if you (?:didn't|did not) cast (?:it|~) from your hand$/i.test(t)) {
		return { k: 'not', of: { k: 'wasCast', fromHand: true } };
	}
	if (/^if (?:you cast (?:it|~)|(?:it|~) was cast)$/i.test(t)) return { k: 'wasCast' };
	if (/^if (?:you (?:didn't|did not) cast (?:it|~)|(?:it|~) was(?:n't| not) cast)$/i.test(t)) {
		return { k: 'not', of: { k: 'wasCast' } };
	}
	// --- End Track P7 ---
	return null;
}

export type ActivatedExtraRestriction =
	| 'as a sorcery'
	| 'once each turn'
	| 'during your turn'
	| 'during your upkeep'
	| 'during combat';

/**
 * CR 602.5b: Parses `"Activate only if <condition>[ and only <timing/restriction>]."` while
 * preserving subtype capitalization (e.g. `"Swamp"`, `"Plains"`). Excludes zone-only restrictions
 * (`~ is in your hand|graveyard`) handled separately by `ACTIVATED_ZONE_RESTRICTION_SENTENCE`.
 */
export function parseActivatedIfConditionSentence(
	raw: string
): { condition: Condition; extra?: ActivatedExtraRestriction } | null {
	const t = raw.trim().replace(/\.$/, '').trim();
	if (/~ is in your (?:hand|graveyard)\b/i.test(t)) return null;
	const ifFirst = t.match(
		/^activate only if (.+?)(?: and only (as a sorcery|once each turn|during your turn|during your upkeep|during combat))?$/i
	);
	if (ifFirst) {
		const condition = parseCondition(`if ${ifFirst[1].trim()}`);
		if (!condition) return null;
		const extra = ifFirst[2]?.toLowerCase() as ActivatedExtraRestriction | undefined;
		return { condition, ...(extra ? { extra } : {}) };
	}
	const extraFirst = t.match(
		/^activate only (as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if (.+)$/i
	);
	if (extraFirst) {
		const condition = parseCondition(`if ${extraFirst[2].trim()}`);
		if (!condition) return null;
		const extra = extraFirst[1].toLowerCase() as ActivatedExtraRestriction;
		return { condition, extra };
	}
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

/** Phases the engine emits PhaseBegin for (beginPhase). */
const RUNTIME_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>([
	'upkeep',
	'draw',
	'main1',
	'begin_combat',
	'end_combat',
	'main2',
	'end_step'
]);

/** ObjectFilter fields runtime/triggers.ts checks. A filter using any other field never matches. */
const RUNTIME_OBJECT_FIELDS: ReadonlySet<string> = new Set([
	'types',
	'subtypes',
	'supertypes',
	'notTypes',
	'notSupertypes',
	'notSubtypes',
	'controller',
	'owner',
	'token',
	'other',
	'colors',
	'tapped',
	'isCommander',
	'saddled',
	// --- Track P4 ---
	'ofChosenType',
	'ofChosenColor',
	// --- Track P5 ---
	'monstrous',
	// --- Track P7 ---
	'power',
	'toughness',
	'manaValue'
]);

/** EventFilter fields each event kind's matcher checks (runtime/triggers.ts). */
const RUNTIME_EVENT_FIELDS: Partial<Record<TriggerDef['event'], ReadonlySet<string>>> = {
	zoneChange: new Set(['object', 'orSelf', 'from', 'to', 'attachedFilter']),
	cast: new Set(['object', 'player', 'orCopy', 'nthThisTurn', 'targetsSelf']),
	attacks: new Set(['object', 'oneOrMore', 'player', 'saddled']),
	combatDamageBatchPlayer: new Set(['object', 'oneOrMore', 'player']),
	blocks: new Set(['object', 'orSelf']),
	becomesBlocked: new Set(['object', 'orSelf']),
	dealsDamage: new Set(['object', 'orSelf', 'combat', 'damageTo', 'player']),
	dealtDamage: new Set(['object', 'orSelf']),
	phaseBegin: new Set(['phase']),
	counterPlaced: new Set(['object', 'counter']),
	becomesTarget: new Set(['object', 'orSelf', 'targetedBy', 'player']),
	attached: new Set(['object', 'host']),
	tappedForMana: new Set(['object', 'player']),
	gainLife: new Set(['player']),
	drawCard: new Set(['player', 'nthThisTurn']),
	becomesTapped: new Set(['object', 'orSelf']),
	cycle: new Set(['object', 'player']),
	discard: new Set(['object', 'player']),
	transforms: new Set(['object', 'toFaceFilter']),
	turnFaceUp: new Set(['object', 'player']),
	investigate: new Set(['player']),
	surveil: new Set(['player']),
	explore: new Set(['object', 'orSelf']),
	connive: new Set(['object', 'orSelf']),
	becomesCrewed: new Set(['object', 'orSelf']),
	becameMonarch: new Set(['player']),
	becomesSaddled: new Set(['object', 'orSelf']),
	foretell: new Set(['object', 'player']),
	plot: new Set(['object', 'player']),
	// --- Track P4 ---
	exert: new Set(['object', 'orSelf', 'player']),
	// --- Track P5 ---
	amass: new Set(['player', 'amassSubtype']),
	manifestDread: new Set(['player']),
	becameMonstrous: new Set(['object', 'orSelf']),
	// --- Track P6 ---
	counterRemoved: new Set(['object', 'counter', 'lastCounter'])
};

function objectFilterProblem(f: ObjectFilter | undefined): string | null {
	if (!f) return null;
	for (const key of Object.keys(f)) {
		if (!RUNTIME_OBJECT_FIELDS.has(key)) return `object filter field "${key}"`;
	}
	if (f.power && f.power.value.k !== 'const') return 'non-constant power filter';
	if (f.toughness && f.toughness.value.k !== 'const') return 'non-constant toughness filter';
	if (f.manaValue && f.manaValue.value.k !== 'const') return 'non-constant manaValue filter';
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
	const p =
		objectFilterProblem(f.host) ??
		objectFilterProblem(f.toFaceFilter) ??
		objectFilterProblem(f.attachedFilter);
	if (p) return p;
	if (
		f.object === 'attachedTo' &&
		![
			'attacks',
			'blocks',
			'becomesBlocked',
			'dealsDamage',
			'dealtDamage',
			'becomesTarget',
			'tappedForMana',
			'becomesTapped'
		].includes(def.event) &&
		!(def.event === 'zoneChange' && f.from === 'battlefield')
	) {
		return `"${def.event}" of the attached-to object`;
	}
	if (def.event === 'phaseBegin' && (!f.phase || !RUNTIME_PHASES.has(f.phase))) return `phase "${f.phase}"`;
	if (
		(def.event === 'becomesTarget' || def.event === 'dealsDamage') &&
		f.player &&
		!['you', 'opponent', 'any'].includes(f.player.relation)
	) {
		return `player "${f.player.relation}"`;
	}
	if (def.event === 'cast' && f.player && !['you', 'opponent', 'any'].includes(f.player.relation)) {
		return `caster "${f.player.relation}"`;
	}
	if (def.event === 'attacks' && f.player && f.player.relation !== 'you') return 'attacking player';
	if (
		def.event === 'combatDamageBatchPlayer' &&
		(!f.oneOrMore || !f.player || !['you', 'opponent', 'any'].includes(f.player.relation))
	) {
		return 'combatDamageBatchPlayer filter';
	}
	if (def.fromZone && def.fromZone !== 'graveyard' && !(def.fromZone === 'any' && def.event === 'cycle')) {
		return `functions from ${def.fromZone}`;
	}
	for (const alt of def.or ?? []) {
		const q = runtimeTriggerProblem(alt);
		if (q) return q;
	}
	return null;
}

// ---- Runtime view ---------------------------------------------------------------------------

/** One triggered ability as the runtime matches it. */
export interface RuntimeTrigger {
	/** Index in compileCard(card).faces[faceIndex].abilities (stored on stack items, CR 603.4 re-check). */
	abilityIndex: number;
	trigger: TriggerDef;
	condition?: Condition;
	/** Existence condition for striated frames (CR 711.5 Leveler, CR 722.2 Station). */
	grantCondition?: Condition;
	/** The IR effect is fully understood and interpretable (kind 'triggered'). */
	effectSupported: boolean;
	/** The ability's normalised text (`~` for the card's name), shown on the stack. Display only. */
	text: string;
	/**
	 * The compiled effect (steps and target specs) when the ability is automated. Absent for an
	 * ability whose effect the compiler marked unsupported: it still triggers and goes on the stack,
	 * and is resolved manually (plan section 2.7).
	 */
	effect?: { steps: EffectStep[]; targets: TargetSpec[]; modal?: ModalDef; unparsed: [] };
	/**
	 * Ward (CR 702.21a), a keyword the engine implements itself: "Whenever this permanent becomes the
	 * target of a spell or ability an opponent controls, counter it unless that player pays [cost]."
	 */
	ward?: { cost: string; costDefs?: CostDef[] };
	/** Set for triggers emitted from a Layer 6 granted trigger keyword (e.g. prowess, battle cry). */
	grantedKeyword?: string;
}

const RUNTIME_TRIGGERS = new WeakMap<CardDefinition, Map<number, RuntimeTrigger[]>>();

/**
 * The triggered abilities the runtime matches for a compiled card:
 * - abilities of kind 'triggered' (trigger, condition and effect understood and interpretable),
 * - unsupported abilities whose trigger head is understood but whose effect isn't. Step E2 (plan
 *   section 2.7): they trigger and go on the stack like any other; a human controller resolves them
 *   manually and a bot skips them, and
 * - triggered keyword abilities declared in KEYWORD_REGISTRY (Ward, Prowess, Battle cry, Afterlife,
 *   Bushido, Living weapon, For Mirrodin!, Exploit, etc.).
 * Abilities whose trigger head isn't understood (or names an event the engine never emits) can't
 * be matched; the engine mentions them when the permanent enters (compiler/support.ts).
 */
export function runtimeTriggers(def: CardDefinition, faceIndex = 0): RuntimeTrigger[] {
	let byFace = RUNTIME_TRIGGERS.get(def);
	const cached = byFace?.get(faceIndex);
	if (cached) return cached;
	const out: RuntimeTrigger[] = [];
	(def.faces[faceIndex]?.abilities ?? []).forEach((ab, abilityIndex) => {
		if (ab.kind === 'keyword') {
			const spec = getKeywordSpec(ab.keyword.name);
			if (
				spec?.status === 'implemented' &&
				(spec.implementation?.kind === 'trigger' ||
					(spec.implementation?.kind === 'castOption' && spec.implementation.buildTriggers))
			) {
				out.push(...spec.implementation.buildTriggers!(ab.keyword, abilityIndex, ab.span));
			}
			return;
		}
		if (ab.kind === 'triggered') {
			out.push({
				abilityIndex,
				trigger: ab.trigger,
				condition: ab.condition,
				...(ab.grantCondition ? { grantCondition: ab.grantCondition } : {}),
				effectSupported: true,
				text: ab.text ?? '',
				effect: { steps: ab.effect, targets: ab.targets, ...(ab.modal ? { modal: ab.modal } : {}), unparsed: [] }
			});
		} else if (ab.kind === 'unsupported' && ab.reason === 'unparsed' && ab.trigger) {
			// An unparsed intervening-if leaves `condition` undefined: such abilities are 'unparsed' via
			// the trigger head (no ab.trigger), so they never get here.
			out.push({
				abilityIndex,
				trigger: ab.trigger,
				condition: ab.condition,
				...(ab.grantCondition ? { grantCondition: ab.grantCondition } : {}),
				effectSupported: false,
				text: ab.text
			});
		}
	});
	if (!byFace) {
		byFace = new Map();
		RUNTIME_TRIGGERS.set(def, byFace);
	}
	byFace.set(faceIndex, out);
	return out;
}
