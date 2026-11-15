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
import type { CounterType, GamePhase, ManaColor, TriggerScope, ZoneType } from '../types.ts';
import { COUNTERS, singularSubtype } from './costs.ts';
import { parseExtendedObjectPhrase } from './effectsWave5.ts';

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
	// --- Track P10 ---
	const enchCtrl = rest.match(
		/^the (upkeep|draw step|end step) of (?:enchanted|equipped) (creature|permanent|land|artifact|enchantment|planeswalker)'s controller$/
	);
	if (enchCtrl) {
		const phase = STEPS[enchCtrl[1]];
		if (!phase) return null;
		const mappedType = ATTACHED_SUBJ_TYPES[enchCtrl[2]];
		return {
			event: 'phaseBegin',
			filter: {
				phase,
				enchantedControllerUpkeep: true,
				...(mappedType ? { attachedFilter: { types: [mappedType] } } : {})
			},
			scope: 'each_turn'
		};
	}
	const enchPlayer = rest.match(/^enchanted player's (upkeep|draw step|end step)$/);
	if (enchPlayer) {
		const phase = STEPS[enchPlayer[1]];
		if (!phase) return null;
		return {
			event: 'phaseBegin',
			filter: { phase, enchantedPlayerUpkeep: true },
			scope: 'each_turn'
		};
	}
	// --- End Track P10 ---
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
	if (
		text === '~' ||
		/^this (?:creature|permanent|artifact|enchantment|land|planeswalker|room|vehicle|aura|equipment)$/i.test(
			text
		)
	) {
		return { object: 'self' };
	}
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
	for (let guard = 0; guard < 16; guard++) {
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
	const filter = parseExtendedObjectPhrase(phrase);
	if (!filter) return null;
	if (controller) {
		if (filter.controller && filter.controller !== controller) return null;
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
		// --- Track P10 ---
		case "attacks and isn't blocked":
		case "attack and aren't blocked":
		case 'attacks and is not blocked':
		case 'attack and are not blocked':
			return def(
				'attackedAndUnblocked',
				subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
			);
		case 'attacks alone':
		case 'attack alone':
			return subject.oneOrMore
				? null
				: def('attacks', {
						alone: true,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
		case 'becomes untapped':
		case 'become untapped':
			return subject.oneOrMore
				? null
				: def(
						'becomesUntapped',
						subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
					);
		case 'deals noncombat damage to a player':
		case 'deal noncombat damage to a player':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'player' });
		case 'deals noncombat damage to an opponent':
		case 'deals noncombat damage to one of your opponents':
		case 'deal noncombat damage to an opponent':
		case 'deal noncombat damage to one of your opponents':
			return subject.oneOrMore
				? null
				: def('dealsDamage', {
						combat: false,
						damageTo: 'player',
						player: { relation: 'opponent' }
					});
		case 'deals noncombat damage to you':
		case 'deal noncombat damage to you':
			return subject.oneOrMore
				? null
				: def('dealsDamage', { combat: false, damageTo: 'player', player: { relation: 'you' } });
		case 'deals noncombat damage to a creature':
		case 'deal noncombat damage to a creature':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'creature' });
		case 'deals noncombat damage':
		case 'deal noncombat damage':
			return subject.oneOrMore ? null : def('dealsDamage', { combat: false, damageTo: 'any' });
		case 'exploits a creature':
		case 'exploit a creature':
			return subject.oneOrMore ? null : def('exploited');
		case 'blocks or becomes blocked':
		case 'block or become blocked':
			return subject.oneOrMore
				? null
				: def(
						'blocksOrBecomesBlocked',
						subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {}
					);
		// --- End Track P10 ---
		default: {
			// --- Track P10 ---
			const bobb = verb.match(/^blocks? or becomes? blocked by (?:a|an) (.+)$/i);
			if (bobb && !subject.oneOrMore) {
				const host = parseExtendedObjectPhrase(bobb[1]);
				if (host) {
					return def('blocksOrBecomesBlocked', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			const blocksHost = verb.match(/^blocks? (?:a|an) (.+)$/i);
			if (blocksHost && !subject.oneOrMore) {
				const host = parseExtendedObjectPhrase(blocksHost[1]);
				if (host) {
					return def('blocks', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			const blockedByHost = verb.match(/^becomes? blocked by (?:a|an) (.+)$/i);
			if (blockedByHost && !subject.oneOrMore) {
				const host = parseExtendedObjectPhrase(blockedByHost[1]);
				if (host) {
					return def('becomesBlocked', {
						host,
						...(subject.attachedFilter ? { attachedFilter: subject.attachedFilter } : {})
					});
				}
			}
			// --- End Track P10 ---
			// --- Track P13 ---
			if (/^transforms? into ~$/i.test(verb) && subject.object === 'self') {
				return def('transforms');
			}
			const becomesAttached = verb.match(/^becomes? attached to (?:a|an) (.+)$/i);
			if (becomesAttached && !subject.oneOrMore) {
				const host = parseExtendedObjectPhrase(becomesAttached[1]);
				if (host) return def('attached', { host });
			}
			const valiantTgt = verb.match(
				/^becomes? the target of (a spell or ability|a spell|an ability) you control for the first time each turn$/i
			);
			if (valiantTgt && !subject.oneOrMore) {
				const rawBy = valiantTgt[1].toLowerCase();
				const targetedBy: EventFilter['targetedBy'] =
					rawBy === 'a spell' ? 'spell' : rawBy === 'an ability' ? 'ability' : 'spellOrAbility';
				return def('becomesTarget', {
					targetedBy,
					player: { relation: 'you' },
					firstTimeTargetedByYouThisTurn: true
				});
			}
			// --- End Track P13 ---
			const transInto = verb.match(/^transforms? into (.+)$/i);
			if (transInto) {
				const phrase = transInto[1].replace(/^(?:a|an)\s+/i, '').trim();
				const qual = parseExtendedObjectPhrase(phrase);
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
	if (!/\bspell\b/i.test(m[1])) return null;
	const parsed = parseExtendedObjectPhrase(m[1], { allowSpellNoun: true });
	return parsed ?? null;
}

function discardedCardFilter(text: string): ObjectFilter | null {
	if (text === '~') return null;
	const m = text.match(/^(?:a|an) (.+)$/i);
	if (!m) return null;
	const inner = m[1].trim();
	if (/^card$/i.test(inner)) return {};
	if (!/\bcard$/i.test(inner)) return null;
	return parseExtendedObjectPhrase(inner);
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
	// --- Track P13: Cast qualifiers (opponent's turn, Paradox, from graveyard/exile, kicked) ---
	const castOppTurn = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) during an opponent's turn$/i
	);
	if (castOppTurn) {
		const object = spellFilter(castOppTurn[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player, duringOpponentTurn: true };
		if (/copy|copies/i.test(castOppTurn[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	const castNotHand = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) from anywhere other than (?:your|their|its owner's) hand$/i
	);
	if (castNotHand) {
		const object = spellFilter(castNotHand[2]);
		if (object === null) return null;
		const filter: EventFilter = { object, player, castFromNotHand: true };
		if (/copy|copies/i.test(castNotHand[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	const castZone = rest.match(
		/^(cast or copy|casts or copies|casts?) (.+?) from (?:your |a |their )?(graveyard|exile)$/i
	);
	if (castZone) {
		const object = spellFilter(castZone[2]);
		if (object === null) return null;
		const castFromZone: ZoneType = castZone[3].toLowerCase() === 'exile' ? 'exile' : 'graveyard';
		const filter: EventFilter = { object, player, castFromZone };
		if (/copy|copies/i.test(castZone[1])) filter.orCopy = true;
		return { event: 'cast', filter };
	}
	// --- End Track P13 ---
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
		const object = parseExtendedObjectPhrase(tap[1]);
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
		const object = parseExtendedObjectPhrase(turnUp[1]);
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
		const object = parseExtendedObjectPhrase(exert[1] ?? exert[2]);
		if (object) return { event: 'exert', filter: { object, player } };
	}
	// --- Track P10 ---
	if (player?.relation === 'you') {
		const atkMin = rest.match(/^attacks? with (\S+) or more (.+)$/i);
		if (atkMin) {
			const minN = number(atkMin[1]);
			const object = parseExtendedObjectPhrase(atkMin[2]);
			if (minN !== null && minN >= 1 && object) {
				return { event: 'attacks', filter: { player, oneOrMore: true, minAttackers: minN, object } };
			}
		}
		const atkOne = rest.match(/^attacks? with (?:a|an) (.+)$/i);
		if (atkOne && !/\balone$/i.test(atkOne[1])) {
			const object = parseExtendedObjectPhrase(atkOne[1]);
			if (object) {
				return { event: 'attacks', filter: { player, oneOrMore: true, minAttackers: 1, object } };
			}
		}
	}
	if (rest === 'sacrifice ~' || rest === 'sacrifices ~') {
		return { event: 'sacrificed', filter: { player, object: 'self' } };
	}
	const sac = rest.match(/^sacrifices? (one or more |another |(?:a|an) )(.+)$/i);
	if (sac) {
		const oneOrMore = /^one or more /i.test(sac[1]);
		const phrase = /^another /i.test(sac[1]) ? `another ${sac[2]}` : sac[2];
		const object = parseExtendedObjectPhrase(phrase);
		if (object) {
			return {
				event: 'sacrificed',
				filter: { player, object, ...(oneOrMore ? { oneOrMore: true } : {}) }
			};
		}
	}
	if (rest === 'scry' || rest === 'scries') return { event: 'scry', filter: { player } };
	if (rest === 'commit a crime' || rest === 'commits a crime') {
		return { event: 'committedCrime', filter: { player } };
	}
	const exp = rest.match(/^expends? (\S+)$/i);
	if (exp) {
		const thresh = number(exp[1]);
		if (thresh !== null && thresh >= 1) {
			return { event: 'expended', filter: { player, expendThreshold: thresh } };
		}
	}
	if (rest === 'discover' || rest === 'discovers') return { event: 'discover', filter: { player } };
	if (rest === 'forage' || rest === 'forages') return { event: 'forage', filter: { player } };
	// --- End Track P10 ---
	// --- Track P13: Room doors, Dungeons, Initiative ---
	if (player?.relation === 'you' && /^unlock this door$/i.test(rest)) {
		return {
			event: 'doorUnlocked',
			filter: { object: 'self', player, thisDoorFaceIndex: -1 }
		};
	}
	if (/^unlocks? a door(?: of a room you control)?$/i.test(rest)) {
		return { event: 'doorUnlocked', filter: { player } };
	}
	if (/^fully unlocks? a room$/i.test(rest)) {
		return { event: 'roomFullyUnlocked', filter: { player } };
	}
	if (/^ventures? into (?:the )?(?:dungeon|undercity)$/i.test(rest)) {
		return { event: 'dungeonRoomEntered', filter: { player } };
	}
	if (/^completes? a dungeon$/i.test(rest)) {
		return { event: 'dungeonCompleted', filter: { player } };
	}
	if (/^takes? the initiative$/i.test(rest)) {
		return { event: 'tookInitiative', filter: { player } };
	}
	// --- End Track P13 ---
	return null;
}

const PERMANENT_TYPES_LIST = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];

function parseGraveyardLeaveCardFilter(raw: string | undefined): ObjectFilter | null {
	if (!raw) return {};
	const trimmed = raw.trim();
	if (/^permanents?$/i.test(trimmed)) return { types: [...PERMANENT_TYPES_LIST] };
	const normalized = trimmed.replace(/\s+(?:and\/or|and)\s+/gi, ' or ');
	return parseExtendedObjectPhrase(`${normalized} card`);
}

/** "a +1/+1 counter is put on ~", "one or more +1/+1 counters are put on ~", "an oil counter is put on ~". */
function counterEvent(head: string): TriggerDef | null {
	const m = head.match(
		/^(?:a|an|one or more) ([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) counters? (?:is|are) (?:put|placed) on ~$/i
	);
	if (!m) return null;
	const ctr = COUNTERS[m[1].toLowerCase().replace(/−/g, '-')];
	return ctr ? { event: 'counterPlaced', filter: { object: 'self', counter: ctr } } : null;
}

function triggerHead(head: string, depth = 0): TriggerDef | null {
	if (depth < 2) {
		const compound = head.match(/^((?:when|whenever) .+?)\s+(?:and|or)\s+((?:when|whenever) .+)$/i);
		if (compound) {
			const left = triggerHead(compound[1].trim(), depth + 1);
			const right = triggerHead(compound[2].trim(), depth + 1);
			if (left && right) {
				const rightAlts = right.or ? [{ ...right, or: undefined }, ...right.or] : [right];
				return {
					...left,
					or: [...(left.or ?? []), ...rightAlts]
				};
			}
		}
	}
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

	// --- Track P13: The Ring tempts you ---
	if (/^the ring tempts you$/i.test(body)) {
		return { event: 'ringTempted', filter: { player: { relation: 'you' } } };
	}
	// --- End Track P13 ---

	// --- Track P10 ---
	const dealtDmgDies = body.match(
		/^(?:a )?creature dealt (?:combat )?damage by ~ this turn (?:dies|is put into a graveyard from the battlefield)$/i
	);
	if (dealtDmgDies) {
		return {
			event: 'zoneChange',
			filter: {
				object: { types: ['Creature'] },
				from: 'battlefield',
				to: 'graveyard',
				dealtDamageBySelfThisTurn: true
			}
		};
	}
	const gyLeave = body.match(/^(one or more|(?:a|an)) (?:(.+?) )?cards? leaves? your graveyard$/i);
	if (gyLeave) {
		const oneOrMore = /^one or more$/i.test(gyLeave[1]);
		const object = parseGraveyardLeaveCardFilter(gyLeave[2]);
		if (object) {
			return {
				event: 'graveyardLeaveBatch',
				filter: {
					player: { relation: 'you' },
					object,
					...(oneOrMore ? { oneOrMore: true } : {})
				}
			};
		}
	}
	const battalion = body.match(/^~ and at least (\S+) other creatures attack$/i);
	if (battalion) {
		const nOther = number(battalion[1]);
		if (nOther !== null && nOther >= 1) {
			return {
				event: 'attacks',
				filter: { object: 'self', minAttackers: nOther + 1 }
			};
		}
	}
	// --- End Track P10 ---

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

export function parseCondition(
	text: string,
	opts?: { allowDungeonCompletion?: boolean }
): Condition | null {
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
		const filter = parseExtendedObjectPhrase(m[2]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(number(m[1])!) };
		}
	}
	m = t.match(/^if you control (?:(?:a|an) (.+)|(another .+))$/i);
	if (m) {
		const filter = parseExtendedObjectPhrase(m[1] ?? m[2]);
		if (filter && !filter.controller) {
			return { k: 'compare', left: { k: 'count', of: { ...filter, controller: 'you' } }, op: '>=', right: n(1) };
		}
	}
	m = t.match(/^if you control no (.+)$/);
	if (m) {
		const filter = parseExtendedObjectPhrase(m[1]);
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
	// --- Track P10 ---
	if (/^if an opponent lost life this turn$/i.test(t)) {
		return { k: 'opponentLostLifeThisTurn' };
	}
	if (/^if no opponents? lost life this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'opponentLostLifeThisTurn' } };
	}
	if (/^if you(?:'ve| have)? descended this turn$/i.test(t)) {
		return { k: 'descendedThisTurn' };
	}
	if (/^if you (?:didn't descend|did not descend|haven't descended|have not descended) this turn$/i.test(t)) {
		return { k: 'not', of: { k: 'descendedThisTurn' } };
	}
	const hadCtr = t.match(
		/^if (?:it|~|that (?:creature|permanent)) had (?:a|an|one or more) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) )?counters? on it$/i
	);
	if (hadCtr) {
		const rawCtr = hadCtr[1]?.toLowerCase().replace(/−/g, '-');
		if (!rawCtr) return { k: 'hadCounterOnIt', counter: 'any' };
		const mapped = COUNTERS[rawCtr];
		if (mapped) return { k: 'hadCounterOnIt', counter: mapped };
	}
	const hadNoCtr = t.match(
		/^if (?:it|~|that (?:creature|permanent)) (?:had no|didn't have a|did not have a) (?:([+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) )?counters? on it$/i
	);
	if (hadNoCtr) {
		const rawCtr = hadNoCtr[1]?.toLowerCase().replace(/−/g, '-');
		if (!rawCtr) return { k: 'not', of: { k: 'hadCounterOnIt', counter: 'any' } };
		const mapped = COUNTERS[rawCtr];
		if (mapped) return { k: 'not', of: { k: 'hadCounterOnIt', counter: mapped } };
	}
	const singleSpent = t.match(/^if \{([WUBRG])\} was spent to cast (?:it|~)$/i);
	if (singleSpent) {
		return { k: 'manaColorSpentToCast', color: singleSpent[1].toUpperCase() as ManaColor };
	}
	const orSpent = t.match(/^if \{([WUBRG])\} or \{([WUBRG])\} was spent to cast (?:it|~)$/i);
	if (orSpent) {
		return {
			k: 'or',
			of: [
				{ k: 'manaColorSpentToCast', color: orSpent[1].toUpperCase() as ManaColor },
				{ k: 'manaColorSpentToCast', color: orSpent[2].toUpperCase() as ManaColor }
			]
		};
	}
	const andSpent = t.match(
		/^if (?:both )?\{([WUBRG])\} and \{([WUBRG])\} were spent to cast (?:it|~)$/i
	);
	if (andSpent) {
		return {
			k: 'and',
			of: [
				{ k: 'manaColorSpentToCast', color: andSpent[1].toUpperCase() as ManaColor },
				{ k: 'manaColorSpentToCast', color: andSpent[2].toUpperCase() as ManaColor }
			]
		};
	}
	if (/^if an opponent controls more lands than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'lands' };
	}
	if (/^if an opponent controls more creatures than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'creatures' };
	}
	if (/^if an opponent has more life than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'life' };
	}
	if (/^if an opponent has more cards in hand than you$/i.test(t)) {
		return { k: 'opponentComparison', metric: 'hand' };
	}
	const gyThreshold = t.match(/^if (?:there are )?(\S+) or more cards(?: are)? in your graveyard$/i);
	if (gyThreshold && number(gyThreshold[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } },
			op: '>=',
			right: n(number(gyThreshold[1])!)
		};
	}
	const delirium = t.match(
		/^if (?:there are )?(\S+) or more card types(?: are)? among cards in your graveyard$/i
	);
	if (delirium && number(delirium[1]) !== null) {
		return {
			k: 'compare',
			left: { k: 'distinctCardTypesInZone', zone: 'graveyard', whose: 'you' },
			op: '>=',
			right: n(number(delirium[1])!)
		};
	}
	const gyTypedCond = t.match(
		/^if (?:there are )?(\S+) or more (.+?) cards(?: are)? in your graveyard$/i
	);
	if (gyTypedCond && number(gyTypedCond[1]) !== null) {
		const f = parseGraveyardLeaveCardFilter(gyTypedCond[2]);
		if (f) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'graveyard', controller: 'you' } },
				op: '>=',
				right: n(number(gyTypedCond[1])!)
			};
		}
	}
	// --- End Track P10 ---
	// --- Track P13: Unified Trigger & Resolution Conditions ---
	if (/^if ~ is in your graveyard$/i.test(t)) return { k: 'selfInZone', zone: 'graveyard' };
	if (/^if ~ is in exile$/i.test(t)) return { k: 'selfInZone', zone: 'exile' };
	if (/^if ~ is on the battlefield$/i.test(t)) return { k: 'selfInZone', zone: 'battlefield' };
	if (/^if no spells were cast last turn$/i.test(t)) {
		return { k: 'spellsCastLastTurn', mode: 'none', count: 0 };
	}
	const spellsLastTurn = t.match(/^if a player cast (\S+) or more spells last turn$/i);
	if (spellsLastTurn && number(spellsLastTurn[1]) !== null) {
		return {
			k: 'spellsCastLastTurn',
			mode: 'singlePlayerAtLeast',
			count: number(spellsLastTurn[1])!
		};
	}
	if (opts?.allowDungeonCompletion) {
		if (/^if you(?:'ve| have) completed a dungeon$/i.test(t)) return { k: 'hasCompletedDungeon' };
		if (/^if you (?:haven't|have not) completed a dungeon$/i.test(t)) {
			return { k: 'not', of: { k: 'hasCompletedDungeon' } };
		}
	}
	if (/^if you have the initiative$/i.test(t)) return { k: 'hasInitiative' };
	if (/^if you have the city's blessing$/i.test(t)) return { k: 'hasCitysBlessing' };
	if (/^if you (?:don't|do not) have the city's blessing$/i.test(t)) {
		return { k: 'not', of: { k: 'hasCitysBlessing' } };
	}
	if (/^if you have max speed$/i.test(t)) return { k: 'hasMaxSpeed' };
	const poisonCond = t.match(/^if an opponent has (\S+) or more poison counters$/i);
	if (poisonCond && number(poisonCond[1]) !== null) {
		return { k: 'opponentPoisonAtLeast', min: number(poisonCond[1])! };
	}
	const celebCond = t.match(
		/^if (\S+) or more nonland permanents entered(?: the battlefield)? under your control this turn$/i
	);
	if (celebCond && number(celebCond[1]) !== null) {
		return { k: 'nonlandEnteredThisTurn', min: number(celebCond[1])! };
	}
	if (
		/^if a nonland permanent left the battlefield this turn or a spell was warped this turn$/i.test(
			t
		)
	) {
		return { k: 'voidThisTurn' };
	}
	const adamantAny = t.match(
		/^if at least (\S+) mana of the same color was spent to cast (?:it|~|this spell)$/i
	);
	if (adamantAny && number(adamantAny[1]) !== null) {
		return { k: 'sameColorManaSpentAtLeast', min: number(adamantAny[1])! };
	}
	const adamantCol = t.match(
		/^if at least (\S+) (white|blue|black|red|green) mana was spent to cast (?:it|~|this spell)$/i
	);
	if (adamantCol && number(adamantCol[1]) !== null) {
		const colMap: Record<string, ManaColor> = {
			white: 'W',
			blue: 'U',
			black: 'B',
			red: 'R',
			green: 'G'
		};
		return {
			k: 'sameColorManaSpentAtLeast',
			min: number(adamantCol[1])!,
			color: colMap[adamantCol[2].toLowerCase()]
		};
	}
	const covenCond = t.match(
		/^if you control (\S+) or more creatures with different powers$/i
	);
	if (covenCond && number(covenCond[1]) !== null) {
		return { k: 'distinctControlledCreaturePowers', count: number(covenCond[1])! };
	}
	const totalPwrCond = t.match(
		/^if creatures you control have total power (\S+) or (?:greater|more)$/i
	);
	if (totalPwrCond && number(totalPwrCond[1]) !== null) {
		return { k: 'totalPowerControlled', min: number(totalPwrCond[1])! };
	}
	const spellsThisTurn = t.match(/^if you(?:'ve| have) cast (\S+) or more spells this turn$/i);
	if (spellsThisTurn && number(spellsThisTurn[1]) !== null) {
		return { k: 'spellsCastThisTurnCount', min: number(spellsThisTurn[1])! };
	}
	const typedSpellsThisTurn = t.match(
		/^if you(?:'ve| have) cast (?:(?:a|an)|(\S+) or more) (.+?) spells? this turn$/i
	);
	if (typedSpellsThisTurn) {
		const min = typedSpellsThisTurn[1] ? number(typedSpellsThisTurn[1]) : 1;
		const sf = spellFilter(`a ${typedSpellsThisTurn[2]} spell`);
		if (min !== null && sf && sf !== 'self' && sf !== 'attachedTo') {
			return { k: 'spellsCastThisTurnCount', min, filter: sf };
		}
	}
	const gyCardsTurn = t.match(
		/^if (\S+) or more cards were put into your graveyard from anywhere this turn$/i
	);
	if (gyCardsTurn && number(gyCardsTurn[1]) !== null) {
		return {
			k: 'cardsPutIntoGraveyardFromAnywhereThisTurn',
			min: number(gyCardsTurn[1])!
		};
	}
	if (/^if ~ attacked this turn$/i.test(t)) return { k: 'boastAttackedThisTurn' };
	const selfStatCond = t.match(
		/^if ~'s (power|toughness) is (\S+) or (greater|more|less|fewer)$/i
	);
	if (selfStatCond && number(selfStatCond[2]) !== null) {
		const stat: 'power' | 'toughness' =
			selfStatCond[1].toLowerCase() === 'power' ? 'power' : 'toughness';
		const dir = selfStatCond[3].toLowerCase();
		const op = dir === 'greater' || dir === 'more' ? '>=' : '<=';
		return {
			k: 'compare',
			left: { k: 'stat', stat, of: { k: 'self' } },
			op,
			right: n(number(selfStatCond[2])!)
		};
	}
	const selfStateCond = t.match(
		/^if (?:(?:~|it) is|it's) (not )?(tapped|untapped|attacking|blocking|enchanted|equipped|saddled|monstrous)$/i
	);
	if (selfStateCond) {
		const neg = Boolean(selfStateCond[1]);
		const st = selfStateCond[2].toLowerCase();
		const baseCond: Condition =
			st === 'tapped'
				? { k: 'objectState', of: 'self', tapped: true }
				: st === 'untapped'
					? { k: 'objectState', of: 'self', tapped: false }
					: st === 'attacking'
						? { k: 'objectState', of: 'self', attacking: true }
						: st === 'blocking'
							? { k: 'objectState', of: 'self', blocking: true }
							: st === 'enchanted'
								? { k: 'objectState', of: 'self', enchanted: true }
								: st === 'equipped'
									? { k: 'objectState', of: 'self', equipped: true }
									: st === 'saddled'
										? { k: 'objectState', of: 'self', saddled: true }
										: { k: 'objectState', of: 'self', monstrous: true };
		return neg ? { k: 'not', of: baseCond } : baseCond;
	}
	const selfFilterCond = t.match(/^if (?:(?:~|it) is|it's) (not )?(?:a|an) (.+)$/i);
	if (selfFilterCond) {
		const neg = Boolean(selfFilterCond[1]);
		const f = parseExtendedObjectPhrase(selfFilterCond[2]);
		if (f) {
			const baseCond: Condition = { k: 'matchesFilter', target: { k: 'self' }, filter: f };
			return neg ? { k: 'not', of: baseCond } : baseCond;
		}
	}
	// --- End Track P13 ---
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
		const condition = parseCondition(`if ${ifFirst[1].trim()}`, { allowDungeonCompletion: true });
		if (!condition) return null;
		const extra = ifFirst[2]?.toLowerCase() as ActivatedExtraRestriction | undefined;
		return { condition, ...(extra ? { extra } : {}) };
	}
	const extraFirst = t.match(
		/^activate only (as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if (.+)$/i
	);
	if (extraFirst) {
		const condition = parseCondition(`if ${extraFirst[2].trim()}`, { allowDungeonCompletion: true });
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
		condition = parseCondition(body.slice(condStart, condEnd), { allowDungeonCompletion: true }) ?? undefined;
		if (!condition) unparsed.push({ start: offset + condStart, end: offset + condEnd });
		effectStart = condEnd + 1;
	}
	if (
		trigger &&
		condition &&
		(condition.k === 'graveyardAbove' ||
			(condition.k === 'selfInZone' && condition.zone === 'graveyard'))
	) {
		trigger.fromZone = 'graveyard';
	}

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
	'manaValue',
	// --- Track P10 ---
	'suspected',
	'allTypes',
	'notColors',
	'multicolored',
	'monocolored',
	// --- Track P13 ---
	'anyOf',
	'historic',
	'ofChosenName',
	'attachedToRef',
	'targetsSelf',
	'targetsFilter',
	'hasKeywords',
	'lacksKeywords',
	'hasCounters',
	'attacking',
	'blocking',
	'attackingOrBlocking',
	'dealtDamageThisTurn',
	'enteredThisTurn',
	'faceDown',
	'kickedSpell',
	'castNotFromHand',
	'castFromZoneFilter',
	'controllerRef'
	// --- End Track P13 ---
]);

/** EventFilter fields each event kind's matcher checks (runtime/triggers.ts). */
const RUNTIME_EVENT_FIELDS: Partial<Record<TriggerDef['event'], ReadonlySet<string>>> = {
	zoneChange: new Set([
		'object',
		'orSelf',
		'from',
		'to',
		'attachedFilter',
		'dealtDamageBySelfThisTurn',
		'oneOrMore'
	]),
	cast: new Set([
		'object',
		'player',
		'orCopy',
		'nthThisTurn',
		'targetsSelf',
		'duringOpponentTurn',
		'castFromNotHand',
		'castFromZone',
		'wasKicked'
	]),
	attacks: new Set(['object', 'orSelf', 'oneOrMore', 'player', 'saddled', 'alone', 'minAttackers', 'attachedFilter']),
	combatDamageBatchPlayer: new Set(['object', 'oneOrMore', 'player']),
	blocks: new Set(['object', 'orSelf', 'host', 'attachedFilter', 'blockedAttackerFilter']),
	becomesBlocked: new Set(['object', 'orSelf', 'host', 'attachedFilter']),
	dealsDamage: new Set(['object', 'orSelf', 'combat', 'damageTo', 'player']),
	dealtDamage: new Set(['object', 'orSelf']),
	phaseBegin: new Set([
		'phase',
		'enchantedControllerUpkeep',
		'enchantedPlayerUpkeep',
		'attachedFilter'
	]),
	counterPlaced: new Set(['object', 'counter']),
	becomesTarget: new Set(['object', 'orSelf', 'targetedBy', 'player', 'firstTimeTargetedByYouThisTurn']),
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
	counterRemoved: new Set(['object', 'counter', 'lastCounter']),
	// --- Track P10 ---
	attackedAndUnblocked: new Set(['object', 'orSelf', 'oneOrMore', 'attachedFilter']),
	becomesUntapped: new Set(['object', 'orSelf', 'attachedFilter']),
	scry: new Set(['player']),
	committedCrime: new Set(['player']),
	exploited: new Set(['object', 'orSelf']),
	expended: new Set(['player', 'expendThreshold']),
	sacrificed: new Set(['object', 'orSelf', 'player', 'oneOrMore']),
	blocksOrBecomesBlocked: new Set(['object', 'orSelf', 'host', 'attachedFilter']),
	graveyardLeaveBatch: new Set(['object', 'player', 'oneOrMore']),
	discover: new Set(['player']),
	forage: new Set(['player']),
	// --- Track P13 ---
	doorUnlocked: new Set(['object', 'player', 'thisDoorFaceIndex']),
	roomFullyUnlocked: new Set(['object', 'player']),
	ringTempted: new Set(['player']),
	dungeonRoomEntered: new Set(['player']),
	dungeonCompleted: new Set(['player']),
	tookInitiative: new Set(['player'])
	// --- End Track P13 ---
};

function objectFilterProblem(f: ObjectFilter | undefined): string | null {
	if (!f) return null;
	for (const key of Object.keys(f)) {
		if (!RUNTIME_OBJECT_FIELDS.has(key)) return `object filter field "${key}"`;
	}
	if (f.power && f.power.value.k !== 'const') return 'non-constant power filter';
	if (f.toughness && f.toughness.value.k !== 'const') return 'non-constant toughness filter';
	if (f.manaValue && f.manaValue.value.k !== 'const') return 'non-constant manaValue filter';
	// --- Track P13 ---
	if (f.anyOf) {
		for (const branch of f.anyOf) {
			const bp = objectFilterProblem(branch);
			if (bp) return bp;
		}
	}
	if (f.targetsFilter) {
		const tp = objectFilterProblem(f.targetsFilter);
		if (tp) return tp;
	}
	if (
		f.controllerRef &&
		f.controllerRef.k !== 'you' &&
		f.controllerRef.k !== 'activePlayer' &&
		!(f.controllerRef.k === 'controllerOf' && f.controllerRef.of.k === 'attachedTo')
	) {
		return `controllerRef "${f.controllerRef.k}"`;
	}
	// --- End Track P13 ---
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
		objectFilterProblem(f.attachedFilter) ??
		objectFilterProblem(f.blockedAttackerFilter);
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
			'becomesTapped',
			'attackedAndUnblocked',
			'becomesUntapped',
			'blocksOrBecomesBlocked'
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
function resolveDoorFaceTrigger(def: TriggerDef, faceIndex: number): TriggerDef {
	const needsSelf = def.filter.thisDoorFaceIndex === -1;
	const needsOr = def.or?.some((alt) => alt.filter.thisDoorFaceIndex === -1);
	if (!needsSelf && !needsOr) return def;
	return {
		...def,
		...(needsSelf ? { filter: { ...def.filter, thisDoorFaceIndex: faceIndex } } : {}),
		...(def.or ? { or: def.or.map((alt) => resolveDoorFaceTrigger(alt, faceIndex)) } : {})
	};
}

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
				trigger: resolveDoorFaceTrigger(ab.trigger, faceIndex),
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
				trigger: resolveDoorFaceTrigger(ab.trigger, faceIndex),
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
