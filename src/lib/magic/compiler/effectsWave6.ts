/**
 * Wave 6 Track P16a compiler helper module:
 * - Universal counter-name normalization (`parseUniversalCounterName`, `CR 122.1`)
 * - Wave 6 dynamic `Amount` parsers (`countersRemovedThisWay`, `playerCounters`, `countersOn`)
 * - Generalized resolution-time inline conditional parser (`parseWave6EffectCondition`)
 * - Expanded durations (`untilEndOfCombat`, `forAsLongAsYouControlSelf`, `forAsLongAsSelfRemainsTapped`)
 * - P16a verb & clause parsers:
 *   - `pileSplit` (`CR 700.3` two-pile library split)
 *   - `castFree` (`CR 707.12` copy-card-and-cast & free-cast from exile/graveyard/hand/binding)
 *   - `putPlayerCounters` (`poison`, `experience`, `energy`, `rad`, `ticket` / `{TK}`)
 *   - `moveCounters` (`CR 122.5` generalized source/destination counter movement)
 *   - `putCounters` (`multiCounters` & `CR 122.8–9` LKI `copyCountersFrom`)
 *   - Selective non-targeted `bounce` / `move` / `exile` (`choiceCount`) & mass graveyard reanimation
 *   - Turn & next-spell `grantPlayer` permissions / cast bans / uncounterable grants
 *   - Choice grants (`chooseProtectionColor`, `chooseKeywordOptions`) & choice animations (`chooseCreatureType`, `chooseBasicLandType`)
 *   - Combat overrides (`mustAttackThisTurn`, `mustBeBlockedThisTurn`, `assignsNoCombatDamageThisTurn`, `removeFromCombat`)
 *   - Remaining `CR 701` keyword actions: `harness` (`CR 701.64`), `convert` (`CR 701.28`),
 *     `empowerJace` (`CR 701.71`), `assimilate` (`CR 701.72`), `recruit` (`CR 701.70`), `heal` (`CR 701.69`).
 */

import type {
	Amount,
	CastFreeSpec,
	Condition,
	Duration,
	EffectParams,
	EffectStep,
	ObjectFilter,
	PileSplitSpec,
	PlayerRef,
	Ref,
	Selector,
	Span,
	TargetSpec
} from '../ir.ts';
import { GRANTABLE_KEYWORDS } from '../keywords.ts';
import { normalizeCounterName, type CounterType, type ManaColor, type ZoneType } from '../types.ts';
import { COUNTERS, singularSubtype } from './costs.ts';
import { parseCondition } from './triggers.ts';

const NUMBER_WORDS: Readonly<Record<string, number>> = {
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
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	twenty: 20
};

function parseSmallNumber(raw: string): number | null {
	const low = raw.trim().toLowerCase();
	if (/^\d+$/.test(low)) return parseInt(low, 10);
	return NUMBER_WORDS[low] ?? null;
}

// ---- 1. Universal Counter Name Normalization (CR 122.1) -------------------------------------

const NON_COUNTER_WORDS = new Set<string>([
	'a',
	'an',
	'all',
	'another',
	'any',
	'each',
	'every',
	'many',
	'more',
	'much',
	'no',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
	'eleven',
	'twelve',
	'other',
	'target',
	'that',
	'the',
	'their',
	'them',
	'these',
	'this',
	'those',
	'up',
	'x',
	'your',
	'additional',
	'extra',
	'fewer',
	'less',
	'most',
	'same',
	'different',
	'card',
	'cards',
	'creature',
	'creatures',
	'permanent',
	'permanents',
	'player',
	'players',
	'spell',
	'spells',
	'of',
	'from',
	'on',
	'onto',
	'into',
	'to',
	'and',
	'or'
]);

const MULTI_WORD_COUNTERS = new Set<string>([
	'first strike',
	'double strike'
]);

/**
 * Normalizes any valid MTG counter name (`+1/+1`, `-0/-1`, `+2/+2`, `first strike`, `shadow`,
 * `exalted`, `decayed`, `storage`, `oil`, `filibuster`, `charge`, `rad`, `ticket`, etc.) into a
 * canonical `CounterType`. Rejects grammatical determiners so regex capture groups never misparse
 * `"all counters"` or `"two counters"` as counter names.
 */
export function parseUniversalCounterName(raw: string): CounterType | null {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[−–]/g, '-')
		.replace(/\s+/g, ' ');
	if (!cleaned || NON_COUNTER_WORDS.has(cleaned)) return null;
	if (COUNTERS[cleaned]) return COUNTERS[cleaned];
	if (/^[+-]\d+\/[+-]\d+$/.test(cleaned)) return normalizeCounterName(cleaned);
	if (MULTI_WORD_COUNTERS.has(cleaned)) return normalizeCounterName(cleaned);
	if (/^[a-z][a-z'-]{1,22}$/.test(cleaned)) return normalizeCounterName(cleaned);
	return null;
}

const PLAYER_COUNTER_MAP: Readonly<
	Record<string, 'poison' | 'experience' | 'energy' | 'rad' | 'ticket'>
> = {
	poison: 'poison',
	experience: 'experience',
	energy: 'energy',
	rad: 'rad',
	ticket: 'ticket'
};

export function parsePlayerCounterKind(
	raw: string
): 'poison' | 'experience' | 'energy' | 'rad' | 'ticket' | null {
	const low = raw.trim().toLowerCase();
	if (low === '{e}') return 'energy';
	if (low === '{tk}') return 'ticket';
	return PLAYER_COUNTER_MAP[low] ?? null;
}

// ---- 2. Wave 6 Dynamic Amounts --------------------------------------------------------------

export interface Wave6AmountHelpers {
	itRef: () => Ref | null;
	resolveObjectRef: (phrase: string) => Ref | null;
	resolvePlayerRef: (phrase: string) => PlayerRef | null;
}

export function parseWave6Amount(text: string, helpers: Wave6AmountHelpers): Amount | null {
	const t = text.trim().replace(/^the number of\s+/i, '').trim();

	// "counters removed this way" / "<counter> counters removed this way"
	const remWay = t.match(/^(?:(.+?)\s+)?counters? removed this way$/i);
	if (remWay) {
		if (!remWay[1] || parseUniversalCounterName(remWay[1]) !== null) {
			return { k: 'countersRemovedThisWay' };
		}
	}

	// "{TK} you have" / "<playerCounter> counters <player> has/have"
	if (/^\{tk\}\s+you have$/i.test(t)) {
		return { k: 'playerCounters', counter: 'ticket', player: { k: 'you' } };
	}
	const pCtr = t.match(
		/^(poison|experience|energy|rad|ticket) counters? (you|that player|target player|target opponent|they) ha(?:s|ve)$/i
	);
	if (pCtr) {
		const counter = PLAYER_COUNTER_MAP[pCtr[1].toLowerCase()];
		const pRef = helpers.resolvePlayerRef(pCtr[2]);
		if (counter && pRef) {
			return { k: 'playerCounters', counter, player: pRef };
		}
	}
	const pCtrOn = t.match(
		/^(poison|experience|energy|rad|ticket) counters? on (you|that player|target player|target opponent|them)$/i
	);
	if (pCtrOn) {
		const counter = PLAYER_COUNTER_MAP[pCtrOn[1].toLowerCase()];
		const whoPhrase = pCtrOn[2].toLowerCase() === 'them' ? 'they' : pCtrOn[2];
		const pRef = helpers.resolvePlayerRef(whoPhrase);
		if (counter && pRef) {
			return { k: 'playerCounters', counter, player: pRef };
		}
	}

	// "[<counter> ]counters on <object>"
	const onObj = t.match(/^(?:(.+?)\s+)?counters? on (.+)$/i);
	if (onObj) {
		const counter: CounterType | 'any' | null = onObj[1]
			? parseUniversalCounterName(onObj[1])
			: 'any';
		if (counter) {
			const objPhraseRaw = onObj[2].trim();
			const ref = helpers.resolveObjectRef(objPhraseRaw);
			if (ref) {
				return { k: 'countersOn', counter, of: ref };
			}
		}
	}

	// "cards in <player>'s hand / graveyard"
	const cardsInZone = t.match(
		/^cards in (your|that player's|their|target player's|target opponent's|its controller's|its owner's) (hand|graveyard)$/i
	);
	if (cardsInZone) {
		const poss = cardsInZone[1].toLowerCase();
		const whoPhrase =
			poss === 'your'
				? 'you'
				: poss === 'their'
					? 'they'
					: poss.replace(/'s$/i, '');
		const pRef = helpers.resolvePlayerRef(whoPhrase);
		if (pRef) {
			return {
				k: 'cardsIn',
				zone: cardsInZone[2].toLowerCase() as 'hand' | 'graveyard',
				of: pRef
			};
		}
	}

	// Domain: "basic land type(s) among lands you control"
	if (/^basic land types? among lands you control$/i.test(t)) {
		return { k: 'domain', player: { k: 'you' } };
	}

	// Combat count: "creature(s) blocking (~|it)"
	if (/^creatures? blocking (?:~|it)$/i.test(t)) {
		return { k: 'count', of: { zone: 'battlefield', types: ['Creature'], blocking: true } };
	}

	return null;
}

// ---- 3. Wave 6 Resolution-Time Inline Conditionals ------------------------------------------

export function isWave6ResolutionCondition(cond: Condition): boolean {
	if (cond.k === 'not') return isWave6ResolutionCondition(cond.of);
	if (cond.k === 'and' || cond.k === 'or') return cond.of.every(isWave6ResolutionCondition);
	return (
		cond.k === 'compare' ||
		cond.k === 'graveyardAbove' ||
		cond.k === 'isTurnOf' ||
		cond.k === 'controlCommander' ||
		cond.k === 'kicked' ||
		cond.k === 'evoked' ||
		cond.k === 'escaped' ||
		cond.k === 'isMonarch' ||
		cond.k === 'foretold' ||
		cond.k === 'saddled' ||
		cond.k === 'blitzed' ||
		cond.k === 'exertedThisTurn' ||
		cond.k === 'monstrous' ||
		cond.k === 'matchesFilter' ||
		cond.k === 'creatureDiedThisTurn' ||
		cond.k === 'attackedThisTurn' ||
		cond.k === 'permanentLeftBattlefieldThisTurn' ||
		cond.k === 'gainedLifeThisTurn' ||
		cond.k === 'wasCast' ||
		cond.k === 'objectState' ||
		cond.k === 'opponentCount' ||
		cond.k === 'anyPlayerLife' ||
		cond.k === 'distinctControlledCreaturePowers' ||
		cond.k === 'opponentLostLifeThisTurn' ||
		cond.k === 'descendedThisTurn' ||
		cond.k === 'hadCounterOnIt' ||
		cond.k === 'manaColorSpentToCast' ||
		cond.k === 'opponentComparison' ||
		cond.k === 'classLevelIs' ||
		cond.k === 'classLevelAtLeast' ||
		cond.k === 'caseSolved' ||
		cond.k === 'caseUnsolved' ||
		cond.k === 'isRenowned' ||
		cond.k === 'boastAttackedThisTurn' ||
		cond.k === 'creaturesAttackedCountThisTurn' ||
		cond.k === 'totalPowerControlled' ||
		cond.k === 'colorsAmongControlledPermanents' ||
		cond.k === 'sourcesDealtDamageThisTurn' ||
		cond.k === 'cardsPutIntoGraveyardFromAnywhereThisTurn' ||
		cond.k === 'spellsCastThisTurnCount' ||
		cond.k === 'selfInZone' ||
		cond.k === 'spellsCastLastTurn' ||
		cond.k === 'hasCompletedDungeon' ||
		cond.k === 'hasInitiative' ||
		cond.k === 'hasCitysBlessing' ||
		cond.k === 'hasMaxSpeed' ||
		cond.k === 'opponentPoisonAtLeast' ||
		cond.k === 'nonlandEnteredThisTurn' ||
		cond.k === 'voidThisTurn' ||
		cond.k === 'sameColorManaSpentAtLeast' ||
		cond.k === 'anyOpponentMetric' ||
		cond.k === 'cardsDrawnThisTurnAtLeast' ||
		cond.k === 'maxSpeed' ||
		cond.k === 'citysBlessing' ||
		cond.k === 'giftPromised' ||
		cond.k === 'isDay' ||
		cond.k === 'isNight' ||
		cond.k === 'isYourTurn' ||
		cond.k === 'selfPrepared' ||
		cond.k === 'isImpending' ||
		cond.k === 'enteredWithXAtLeast' ||
		cond.k === 'isPaired' ||
		cond.k === 'tributePaid' ||
		cond.k === 'hasEnduringStory' ||
		cond.k === 'isHarnessed' ||
		cond.k === 'diedThisWay'
	);
}

export interface Wave6ConditionHelpers {
	itRef: () => Ref | null;
	lastPlayerRef?: () => PlayerRef | null;
	ensureLastStepBound?: () => Ref | null;
	hasNonSelfPronounTarget?: boolean;
	definedX?: Amount;
	objectFilter: (phrase: string) => ObjectFilter | null;
	parseAmount: (phrase: string) => Amount | null;
}

function parseComparePhrase(
	raw: string,
	parseAmt: (s: string) => Amount | null
): { op: '>=' | '<=' | '=' | '>' | '<'; right: Amount } | null {
	const t = raw.trim();
	let m = t.match(/^(.+?) or (?:greater|more)$/i);
	if (m) {
		const nVal = parseSmallNumber(m[1]);
		const r = nVal !== null ? ({ k: 'const', n: nVal } as Amount) : parseAmt(m[1]);
		if (r) return { op: '>=', right: r };
	}
	m = t.match(/^(.+?) or (?:less|fewer)$/i);
	if (m) {
		const nVal = parseSmallNumber(m[1]);
		const r = nVal !== null ? ({ k: 'const', n: nVal } as Amount) : parseAmt(m[1]);
		if (r) return { op: '<=', right: r };
	}
	m = t.match(/^(?:(?:greater|more) than or equal to|at least) (.+)$/i);
	if (m) {
		const r = parseAmt(m[1]);
		if (r) return { op: '>=', right: r };
	}
	m = t.match(/^(?:(?:less|fewer) than or equal to|at most) (.+)$/i);
	if (m) {
		const r = parseAmt(m[1]);
		if (r) return { op: '<=', right: r };
	}
	m = t.match(/^(?:greater|more) than (.+)$/i);
	if (m) {
		const r = parseAmt(m[1]);
		if (r) return { op: '>', right: r };
	}
	m = t.match(/^(?:less|fewer) than (.+)$/i);
	if (m) {
		const r = parseAmt(m[1]);
		if (r) return { op: '<', right: r };
	}
	m = t.match(/^equal to (.+)$/i);
	if (m) {
		const r = parseAmt(m[1]);
		if (r) return { op: '=', right: r };
	}
	const exact = parseSmallNumber(t);
	if (exact !== null) return { op: '=', right: { k: 'const', n: exact } };
	return null;
}

export function parseWave6EffectCondition(
	rawIfText: string,
	helpers: Wave6ConditionHelpers,
	depth = 0
): Condition | null {
	if (depth > 2) return null;
	const raw = rawIfText.trim();
	if (!/^if\s+/i.test(raw)) return null;
	const body = raw.replace(/^if\s+/i, '').trim();
	if (!body) return null;

	// 1. Try existing triggers.ts condition parser first (unless a non-self pronoun refers to a bound/targeted object).
	const skipStdForPronoun =
		Boolean(helpers.hasNonSelfPronounTarget) &&
		/^(?:it\b|it's\b|its\b|that\b|the\b)/i.test(body) &&
		!/^(?:it's|it is)\s+(?:day|night|your turn|not your turn|an opponent's turn)$/i.test(body) &&
		!/^the gift was promised$/i.test(body);
	const std = !skipStdForPronoun
		? parseCondition(`if ${body}`, { allowDungeonCompletion: true })
		: null;
	if (std && isWave6ResolutionCondition(std)) return std;

	// 2. Effect-specific Wave 6 conditions:
	// Harnessed / prepared / tribute / paired / day / night
	if (/^(?:~|it|this (?:creature|permanent|artifact|vehicle)) is harnessed$/i.test(body)) {
		return { k: 'isHarnessed' };
	}
	if (/^(?:~|it|this (?:creature|permanent|artifact|vehicle)) (?:isn't|is not) harnessed$/i.test(body) || /^~ is unharnessed$/i.test(body)) {
		return { k: 'not', of: { k: 'isHarnessed' } };
	}
	if (/^(?:~|it|this creature) is prepared$/i.test(body)) {
		return { k: 'selfPrepared' };
	}
	if (/^(?:~|it|this creature) (?:isn't|is not) prepared$/i.test(body)) {
		return { k: 'not', of: { k: 'selfPrepared' } };
	}
	if (/^tribute was paid$/i.test(body)) {
		return { k: 'tributePaid' };
	}
	if (/^tribute (?:wasn't|was not) paid$/i.test(body)) {
		return { k: 'not', of: { k: 'tributePaid' } };
	}
	if (/^~ is paired(?: with (?:a|another) creature)?$/i.test(body)) {
		return { k: 'isPaired' };
	}
	if (/^(?:it's|it is) day$/i.test(body)) return { k: 'isDay' };
	if (/^(?:it's|it is) night$/i.test(body)) return { k: 'isNight' };
	if (/^(?:it's|it is) your turn$/i.test(body)) return { k: 'isYourTurn' };
	if (/^(?:it's|it is) not your turn$/i.test(body) || /^(?:it's|it is) an opponent's turn$/i.test(body)) {
		return { k: 'not', of: { k: 'isYourTurn' } };
	}
	if (/^the gift was promised$/i.test(body) || /^a gift was promised$/i.test(body)) {
		return { k: 'giftPromised' };
	}

	// "if it/that creature/a creature died this way"
	if (
		/^(?:it|that creature|that permanent|a creature|one or more creatures|a creature dealt damage this way) died this way$/i.test(
			body
		)
	) {
		const isPronoun = /^(?:it|that\b)/i.test(body);
		const ref = isPronoun ? (helpers.itRef() ?? undefined) : undefined;
		return { k: 'diedThisWay', ...(ref ? { ref } : {}) };
	}

	// Universal counter conditions on ~ or bound object:
	// "there are N or more <counter> counters on ~", "~ has a/N or more <counter> counter(s) on it",
	// "there are no <counter> counters on ~", "it had a <counter> counter on it"
	let m = body.match(/^there (?:is|are) (no|a|an|\S+)(?: or (more|fewer|less))? (?:(.+?) )?counters? on (~|it|that creature|that permanent)$/i);
	if (m) {
		const cntWord = m[1].toLowerCase();
		const cmpMod = m[2]?.toLowerCase();
		const counter: CounterType | 'any' | null = m[3] ? parseUniversalCounterName(m[3]) : 'any';
		const targetRef: Ref | null = m[4] === '~' ? { k: 'self' } : helpers.itRef();
		if (counter && targetRef) {
			if (cntWord === 'no') {
				return {
					k: 'compare',
					left: { k: 'countersOn', counter, of: targetRef },
					op: '=',
					right: { k: 'const', n: 0 }
				};
			}
			const baseN = parseSmallNumber(cntWord);
			if (baseN !== null) {
				const op = cmpMod === 'fewer' || cmpMod === 'less' ? '<=' : '>=';
				return {
					k: 'compare',
					left: { k: 'countersOn', counter, of: targetRef },
					op,
					right: { k: 'const', n: baseN }
				};
			}
		}
	}

	m = body.match(/^(~|it|that creature|that permanent) has (no|a|an|\S+)(?: or (more|fewer|less))? (?:(.+?) )?counters? on it$/i);
	if (m) {
		const subjWord = m[1].toLowerCase();
		const cntWord = m[2].toLowerCase();
		const cmpMod = m[3]?.toLowerCase();
		const counter: CounterType | 'any' | null = m[4] ? parseUniversalCounterName(m[4]) : 'any';
		const targetRef: Ref | null = subjWord === '~' ? { k: 'self' } : helpers.itRef();
		if (counter && targetRef) {
			if (cntWord === 'no') {
				return {
					k: 'compare',
					left: { k: 'countersOn', counter, of: targetRef },
					op: '=',
					right: { k: 'const', n: 0 }
				};
			}
			const baseN = parseSmallNumber(cntWord);
			if (baseN !== null) {
				const op = cmpMod === 'fewer' || cmpMod === 'less' ? '<=' : '>=';
				return {
					k: 'compare',
					left: { k: 'countersOn', counter, of: targetRef },
					op,
					right: { k: 'const', n: baseN }
				};
			}
		}
	}

	m = body.match(/^(?:it|~|that creature|that permanent) had (?:a|an|one or more) (?:(.+?) )?counters? on it$/i);
	if (m) {
		const counter: CounterType | 'any' | null = m[1] ? parseUniversalCounterName(m[1]) : 'any';
		if (counter) return { k: 'hadCounterOnIt', counter };
	}

	// "you control a/an/N or more <filter>" / "you don't control a <filter>" / "you control no <filter>" / "an opponent controls a <filter>"
	m = body.match(/^you (?:don't|do not) control (?:a|an|any) (.+)$/i);
	if (m) {
		const f = helpers.objectFilter(m[1].trim());
		if (f && !f.zone && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'you' } },
				op: '=',
				right: { k: 'const', n: 0 }
			};
		}
	}
	m = body.match(/^you control no (.+)$/i);
	if (m) {
		const f = helpers.objectFilter(m[1].trim());
		if (f && !f.zone && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'you' } },
				op: '=',
				right: { k: 'const', n: 0 }
			};
		}
	}
	m = body.match(/^you control (?:(a|an|one or more|(\S+) or (more|fewer)) )?(.+)$/i);
	if (m && !/^the monarch\b/i.test(m[4])) {
		const f = helpers.objectFilter(m[4].trim());
		if (f && !f.zone && !f.controller) {
			let op: '>=' | '<=' = '>=';
			let countVal = 1;
			if (m[2]) {
				const parsed = parseSmallNumber(m[2]);
				if (parsed === null) return null;
				countVal = parsed;
				if (m[3]?.toLowerCase() === 'fewer') op = '<=';
			}
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'you' } },
				op,
				right: { k: 'const', n: countVal }
			};
		}
	}
	m = body.match(/^an opponent controls (?:a|an|one or more) (.+)$/i);
	if (m) {
		const f = helpers.objectFilter(m[1].trim());
		if (f && !f.zone && !f.controller) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...f, zone: 'battlefield', controller: 'opponent' } },
				op: '>=',
				right: { k: 'const', n: 1 }
			};
		}
	}

	// Hand size / life total comparisons:
	// "you/that player/they have no cards in hand", "... have N or fewer/more cards in hand", "... have fewer/more than N cards in hand", "... have N or more/less life"
	m = body.match(/^(you|that player|they) (?:have|has) no cards in hand$/i);
	if (m) {
		const who = m[1].toLowerCase();
		const pRef: PlayerRef | null =
			who === 'you' ? { k: 'you' } : (helpers.lastPlayerRef?.() ?? null);
		if (pRef) {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'hand', of: pRef },
				op: '=',
				right: { k: 'const', n: 0 }
			};
		}
	}
	m = body.match(
		/^(you|that player|they) (?:have|has) (?:(fewer|less|more) than (\S+)|(\S+) or (more|fewer|less)|(\S+)) cards? in hand$/i
	);
	if (m) {
		const who = m[1].toLowerCase();
		const pRef: PlayerRef | null =
			who === 'you' ? { k: 'you' } : (helpers.lastPlayerRef?.() ?? null);
		if (pRef) {
			if (m[2] && m[3]) {
				const cnt = parseSmallNumber(m[3]);
				if (cnt !== null) {
					return {
						k: 'compare',
						left: { k: 'cardsIn', zone: 'hand', of: pRef },
						op: m[2].toLowerCase() === 'more' ? '>' : '<',
						right: { k: 'const', n: cnt }
					};
				}
			} else if (m[4] && m[5]) {
				const cnt = parseSmallNumber(m[4]);
				if (cnt !== null) {
					return {
						k: 'compare',
						left: { k: 'cardsIn', zone: 'hand', of: pRef },
						op: m[5].toLowerCase() === 'more' ? '>=' : '<=',
						right: { k: 'const', n: cnt }
					};
				}
			} else if (m[6]) {
				const cnt = parseSmallNumber(m[6]);
				if (cnt !== null) {
					return {
						k: 'compare',
						left: { k: 'cardsIn', zone: 'hand', of: pRef },
						op: '=',
						right: { k: 'const', n: cnt }
					};
				}
			}
		}
	}
	m = body.match(
		/^(you|that player|they) (?:have|has) (?:(less|fewer|more) than (\S+)|(\S+) or (more|less|fewer)) life$/i
	);
	if (m) {
		const who = m[1].toLowerCase();
		const pRef: PlayerRef | null =
			who === 'you' ? { k: 'you' } : (helpers.lastPlayerRef?.() ?? null);
		if (pRef) {
			if (m[2] && m[3]) {
				const cnt = parseSmallNumber(m[3]);
				if (cnt !== null) {
					return {
						k: 'compare',
						left: { k: 'life', of: pRef },
						op: m[2].toLowerCase() === 'more' ? '>' : '<',
						right: { k: 'const', n: cnt }
					};
				}
			} else if (m[4] && m[5]) {
				const cnt = parseSmallNumber(m[4]);
				if (cnt !== null) {
					return {
						k: 'compare',
						left: { k: 'life', of: pRef },
						op: m[5].toLowerCase() === 'more' ? '>=' : '<=',
						right: { k: 'const', n: cnt }
					};
				}
			}
		}
	}

	// Party, morbid, spell-cast, mana-spent, & LKI counter conditions:
	if (/^you have a full party$/i.test(body)) {
		return {
			k: 'compare',
			left: { k: 'partyCount', player: { k: 'you' } },
			op: '=',
			right: { k: 'const', n: 4 }
		};
	}
	if (/^(?:a|one or more) creatures? died(?: under your control)? this turn$/i.test(body)) {
		return { k: 'creatureDiedThisTurn' };
	}
	if (/^(?:you (?:haven't|have not) cast a spell|you cast no spells) this turn$/i.test(body)) {
		return { k: 'not', of: { k: 'spellsCastThisTurnCount', min: 1 } };
	}
	if (/^(?:it|~|that creature|that permanent) had (?:one or more )?counters on it$/i.test(body)) {
		return { k: 'hadCounterOnIt', counter: 'any' };
	}
	m = body.match(
		/^(?:it|~|that creature|that permanent) had (?:a|an|one or more) (.+?) counters? on it$/i
	);
	if (m) {
		const ctr = parseUniversalCounterName(m[1]);
		if (ctr) return { k: 'hadCounterOnIt', counter: ctr };
	}
	m = body.match(/^at least (\S+) mana was spent to cast (?:it|~|this spell)$/i);
	if (m) {
		const cnt = parseSmallNumber(m[1]);
		if (cnt !== null && cnt >= 1) return { k: 'manaColorSpentToCast', minTotal: cnt };
	}
	m = body.match(/^((?:\{[WUBRGC]\})+) was spent to cast (?:it|~|this spell)$/i);
	if (m) {
		const syms = (m[1].toUpperCase().match(/[WUBRGC]/g) ?? []) as ManaColor[];
		if (syms.length === 1) {
			return { k: 'manaColorSpentToCast', color: syms[0] };
		}
		if (syms.length >= 2 && syms.every((c) => c === syms[0])) {
			return { k: 'sameColorManaSpentAtLeast', min: syms.length, color: syms[0] };
		}
		if (syms.length >= 2 && new Set(syms).size === syms.length) {
			return {
				k: 'and',
				of: syms.map((c) => ({ k: 'manaColorSpentToCast' as const, color: c }))
			};
		}
	}
	m = body.match(
		/^(it|that card|that creature|that permanent) shares a (creature type|color) with ~$/i
	);
	if (m) {
		const ref = helpers.itRef();
		if (ref) {
			return {
				k: 'matchesFilter',
				target: ref,
				filter:
					m[2].toLowerCase() === 'creature type'
						? { sharesCreatureTypeWithSelf: true }
						: { sharesColorWithSelf: true }
			};
		}
	}

	// X comparison: "if X is N or more / at least N / ..."
	m = body.match(/^x is (.+)$/i);
	if (m) {
		const cmp = parseComparePhrase(m[1], helpers.parseAmount);
		if (cmp) {
			const left = helpers.definedX ?? { k: 'x' as const };
			return { k: 'compare', left, op: cmp.op, right: cmp.right };
		}
	}

	// Graveyard filtered count: "if there are N or more <filter> cards in your graveyard" / "if you have N or more <filter> cards in your graveyard"
	m = body.match(
		/^(?:there (?:is|are)|you have) (a|an|no|\S+)(?: or (more|fewer|less))? (.+? cards?) in your graveyard$/i
	);
	if (m) {
		const cntWord = m[1].toLowerCase();
		const cmpMod = m[2]?.toLowerCase();
		const f = helpers.objectFilter(m[3].trim());
		if (f && !f.zone && !f.controller) {
			if (cntWord === 'no') {
				return {
					k: 'compare',
					left: { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } },
					op: '=',
					right: { k: 'const', n: 0 }
				};
			}
			const cnt = parseSmallNumber(cntWord);
			if (cnt !== null) {
				const op = cmpMod === 'fewer' || cmpMod === 'less' ? '<=' : '>=';
				return {
					k: 'compare',
					left: { k: 'count', of: { ...f, zone: 'graveyard', owner: 'you' } },
					op,
					right: { k: 'const', n: cnt }
				};
			}
		}
	}

	// Batch result filter check: "if a/an/one or more/no <filter> was/were milled/revealed/discarded/exiled this way"
	m = body.match(
		/^(no|a|an|one or more) (.+?) (?:was|were|is|are) (?:milled|revealed|discarded|exiled) this way$/i
	);
	if (m) {
		const isNone = m[1].toLowerCase() === 'no';
		const pred = m[2].trim();
		const f =
			helpers.objectFilter(pred) ??
			(!/\bcards?$/i.test(pred) ? helpers.objectFilter(`${pred} card`) : null);
		const ref = helpers.itRef() ?? helpers.ensureLastStepBound?.() ?? null;
		if (f && Object.keys(f).length > 0 && ref && ref.k === 'binding') {
			const anyCond: Condition = { k: 'matchesFilter', target: ref, filter: f, any: true };
			return isNone ? { k: 'not', of: anyCond } : anyCond;
		}
	}

	// Object state check on ~ or bound/target object: "if it/that creature/~ is [not] tapped/untapped/attacking/blocking"
	m = body.match(
		/^(~|it|that creature|that permanent) (is|isn't|is not|was|wasn't|was not) (tapped|untapped|attacking or blocking|attacking|blocking)$/i
	);
	if (m) {
		const isSelf = m[1] === '~' || (m[1].toLowerCase() === 'it' && !helpers.itRef());
		const ref = isSelf ? ({ k: 'self' } as Ref) : helpers.itRef();
		if (ref) {
			const neg = /n't|not/i.test(m[2]);
			const stWord = m[3].toLowerCase();
			const stFilter: ObjectFilter =
				stWord === 'tapped'
					? { tapped: true }
					: stWord === 'untapped'
						? { tapped: false }
						: stWord === 'attacking'
							? { attacking: true }
							: stWord === 'blocking'
								? { blocking: true }
								: { attackingOrBlocking: true };
			const baseCond: Condition = { k: 'matchesFilter', target: ref, filter: stFilter };
			return neg ? { k: 'not', of: baseCond } : baseCond;
		}
	}

	// Bound / target object filter & stat checks:
	// "if it's / that creature is / that card was a <filter>"
	m = body.match(
		/^(~|it|equipped creature|enchanted creature|enchanted permanent|that card|that creature|that permanent|that spell|the discarded card|the sacrificed creature|the sacrificed permanent|the exiled card)(?:\s+(?:is|was)|'s)\s+(not\s+)?(?:a\s+|an\s+)?(.+)$/i
	);
	if (m) {
		const subjHead = m[1].toLowerCase();
		const ref: Ref | null =
			subjHead === '~'
				? { k: 'self' }
				: subjHead.startsWith('equipped ') || subjHead.startsWith('enchanted ')
					? { k: 'attachedTo' }
					: subjHead === 'it' && !helpers.itRef()
						? { k: 'self' }
						: helpers.itRef();
		if (ref) {
			const neg = Boolean(m[2]);
			const pred = m[3].trim();
			const f =
				helpers.objectFilter(pred) ??
				(!/\bcards?$/i.test(pred) ? helpers.objectFilter(`${pred} card`) : null);
			if (f && Object.keys(f).length > 0) {
				const baseCond: Condition = { k: 'matchesFilter', target: ref, filter: f };
				return neg ? { k: 'not', of: baseCond } : baseCond;
			}
		}
	}
	m = body.match(
		/^(~|it|equipped creature|enchanted creature|enchanted permanent|that card|that creature|that permanent|that spell|the discarded card|the sacrificed creature|the sacrificed permanent|the exiled card)\s+(?:isn't|is not|wasn't|was not)\s+(?:a\s+|an\s+)?(.+)$/i
	);
	if (m) {
		const subjHead = m[1].toLowerCase();
		const ref: Ref | null =
			subjHead === '~'
				? { k: 'self' }
				: subjHead.startsWith('equipped ') || subjHead.startsWith('enchanted ')
					? { k: 'attachedTo' }
					: subjHead === 'it' && !helpers.itRef()
						? { k: 'self' }
						: helpers.itRef();
		if (ref) {
			const pred = m[2].trim();
			const f =
				helpers.objectFilter(pred) ??
				(!/\bcards?$/i.test(pred) ? helpers.objectFilter(`${pred} card`) : null);
			if (f && Object.keys(f).length > 0) {
				return { k: 'not', of: { k: 'matchesFilter', target: ref, filter: f } };
			}
		}
	}

	// Stat comparison on ~ or bound object:
	// "if its / ~'s mana value / power / toughness is 3 or less" / "if ~'s power is 4 or greater"
	m = body.match(
		/^(~'s|its|that card's|that creature's|that permanent's|that spell's|the exiled card's|the sacrificed creature's|the discarded card's) (power|toughness|mana value) (?:is|was) (.+)$/i
	);
	if (m) {
		const isSelf = m[1] === "~'s";
		const ref = isSelf ? ({ k: 'self' } as Ref) : helpers.itRef();
		const cmp = ref ? parseComparePhrase(m[3], helpers.parseAmount) : null;
		if (ref && cmp) {
			const stat =
				m[2].toLowerCase() === 'mana value'
					? 'manaValue'
					: (m[2].toLowerCase() as 'power' | 'toughness');
			return {
				k: 'compare',
				left: { k: 'stat', of: ref, stat, ...(!isSelf ? { lki: true } : {}) },
				op: cmp.op,
				right: cmp.right
			};
		}
	}
	m = body.match(
		/^(~|it|that card|that creature|that permanent) (?:has|had) (power|toughness|mana value) (.+)$/i
	);
	if (m) {
		const isSelf = m[1] === '~';
		const ref = isSelf ? ({ k: 'self' } as Ref) : helpers.itRef();
		const cmp = ref ? parseComparePhrase(m[3], helpers.parseAmount) : null;
		if (ref && cmp) {
			const stat =
				m[2].toLowerCase() === 'mana value'
					? 'manaValue'
					: (m[2].toLowerCase() as 'power' | 'toughness');
			return {
				k: 'compare',
				left: { k: 'stat', of: ref, stat, ...(!isSelf ? { lki: true } : {}) },
				op: cmp.op,
				right: cmp.right
			};
		}
	}

	// 3. Compound "if <A> and <B>" / "if <A> or <B>" (bounded recursion).
	if (depth < 1) {
		const orIdx = body.indexOf(' or if ');
		if (orIdx > 0) {
			const left = parseWave6EffectCondition(`if ${body.slice(0, orIdx)}`, helpers, depth + 1);
			const right = parseWave6EffectCondition(`if ${body.slice(orIdx + ' or if '.length)}`, helpers, depth + 1);
			if (left && right) return { k: 'or', of: [left, right] };
		}
		const bareOrMatch = body.match(
			/^(.+?)\s+or\s+((?:there (?:is|are)|you (?:control|have|cast|attacked|gained|lost|are|'re)|an opponent|it\b|~\b|that (?:player|creature|card|permanent))\b.+)$/i
		);
		if (bareOrMatch) {
			const left = parseWave6EffectCondition(`if ${bareOrMatch[1]}`, helpers, depth + 1);
			const right = parseWave6EffectCondition(`if ${bareOrMatch[2]}`, helpers, depth + 1);
			if (left && right) return { k: 'or', of: [left, right] };
		}
		const andIdx = body.indexOf(' and ');
		if (andIdx > 0) {
			const left = parseWave6EffectCondition(`if ${body.slice(0, andIdx)}`, helpers, depth + 1);
			const right = parseWave6EffectCondition(
				`if ${body.slice(andIdx + ' and '.length).replace(/^if\s+/i, '')}`,
				helpers,
				depth + 1
			);
			if (left && right) return { k: 'and', of: [left, right] };
		}
	}

	return null;
}

// ---- 4. Wave 6 Sentence / Clause Parsers ----------------------------------------------------

export interface Wave6ClauseHelpers {
	addTarget: (spec: TargetSpec) => number;
	getTarget: (index: number) => TargetSpec | undefined;
	itRef: () => Ref | null;
	ensureLastStepBound?: () => Ref | null;
	isSpellContext?: boolean;
	subjectSelector: (phrase: string) => { sel: Selector; fromZone?: 'graveyard' | 'exile'; bind: boolean } | null;
	playerSubject: (phrase: string) => Selector | null;
	singlePlayer: (sel: Selector) => PlayerRef | null;
	objectFilter: (phrase: string) => ObjectFilter | null;
	parseAmount: (phrase: string) => Amount | null;
}

function parseSpellPermissionTypeFilter(
	raw: string
): { types?: string[]; notTypes?: string[] } | null | 'any' {
	const s = raw.trim().toLowerCase().replace(/^(?:a|an)\s+/, '');
	if (s === 'spell' || s === 'spells') return 'any';
	if (s === 'instant or sorcery spell' || s === 'instant or sorcery spells' || s === 'instant and sorcery spells') {
		return { types: ['Instant', 'Sorcery'] };
	}
	if (s === 'sorcery spell' || s === 'sorcery spells') return { types: ['Sorcery'] };
	if (s === 'instant spell' || s === 'instant spells') return { types: ['Instant'] };
	if (s === 'creature spell' || s === 'creature spells') return { types: ['Creature'] };
	if (s === 'artifact spell' || s === 'artifact spells') return { types: ['Artifact'] };
	if (s === 'enchantment spell' || s === 'enchantment spells') return { types: ['Enchantment'] };
	if (s === 'noncreature spell' || s === 'noncreature spells') return { notTypes: ['Creature'] };
	return null;
}

/**
 * Parses standalone Wave 6 clauses in imperative or player-subject form.
 * Steps returned with `bindAs: '__bind__'` instruct the caller `Parser` to bind the acted-on object (`actsOnObjects = true`).
 */
export function tryParseWave6Sentence(
	rawText: string,
	helpers: Wave6ClauseHelpers,
	span: Span
): EffectStep[] | null {
	const t = rawText.trim();
	const YOU: Selector = { k: 'player', filter: { relation: 'you' } };
	let m: RegExpMatchArray | null;

	// ---- A. CR 701 Keyword Actions (Harness, Convert, Empower Jace, Assimilate, Recruit, Heal, Remove from combat) ----

	// CR 701.64: "harness ~" / "harness target <permanent>"
	m = t.match(/^(?:you )?harness (.+)$/i);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (!subj || subj.fromZone) return null;
		return [{ verb: 'harness', subject: subj.sel, bindAs: '__bind__', span }];
	}

	// CR 701.28: "convert ~" / "convert target ..."
	m = t.match(/^(?:you )?convert (.+)$/i);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (!subj || subj.fromZone) return null;
		return [{ verb: 'convert', subject: subj.sel, bindAs: '__bind__', span }];
	}

	// CR 701.71: "empower Jace N"
	m = t.match(/^(?:you )?empower jace (that many|that much|\S+)$/i);
	if (m) {
		const amount = helpers.parseAmount(m[1]);
		if (!amount) return null;
		return [{ verb: 'empowerJace', subject: YOU, amount, bindAs: '__bind__', span }];
	}

	// CR 701.72: "assimilate <target creature / target creature card from a graveyard>"
	m = t.match(/^(?:you )?assimilate (.+)$/i);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (!subj) return null;
		return [{ verb: 'assimilate', subject: subj.sel, bindAs: '__bind__', span }];
	}

	// CR 701.70: "recruit" / "recruit N times"
	m = t.match(/^(?:you )?recruits?(?: (once|twice|(\S+) times?))?$/i);
	if (m) {
		let amount: Amount | null = { k: 'const', n: 1 };
		if (m[1]) {
			const low = m[1].toLowerCase();
			if (low === 'once') amount = { k: 'const', n: 1 };
			else if (low === 'twice') amount = { k: 'const', n: 2 };
			else if (m[2]) amount = helpers.parseAmount(m[2]);
		}
		if (!amount) return null;
		return [{ verb: 'recruit', subject: YOU, amount, bindAs: '__bind__', span }];
	}

	// CR 701.69: "heal N on <object>" / "heal <object>" / "heal N"
	m = t.match(/^(?:you )?heal (\S+) on (.+)$/i);
	if (m) {
		const amount = helpers.parseAmount(m[1]);
		const subj = amount ? helpers.subjectSelector(m[2].trim()) : null;
		if (!amount || !subj || subj.fromZone) return null;
		return [{ verb: 'heal', subject: subj.sel, amount, bindAs: '__bind__', span }];
	}
	m = t.match(/^(?:you )?heal (.+)$/i);
	if (m) {
		const rawRest = m[1].trim();
		const maybeAmt = helpers.parseAmount(rawRest);
		if (maybeAmt) {
			return [{ verb: 'heal', subject: { k: 'self' }, amount: maybeAmt, bindAs: '__bind__', span }];
		}
		const subj = helpers.subjectSelector(rawRest);
		if (subj && !subj.fromZone) {
			return [
				{ verb: 'heal', subject: subj.sel, amount: { k: 'const', n: 999 }, bindAs: '__bind__', span }
			];
		}
	}

	// CR 506.4: "remove <object> from combat"
	m = t.match(/^remove (.+?) from combat$/i);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (!subj || subj.fromZone) return null;
		return [{ verb: 'removeFromCombat', subject: subj.sel, bindAs: '__bind__', span }];
	}

	// ---- B. Turn & Next-Spell Cast Permissions / Cast Bans / Uncounterable Grants ----

	if (
		/^your opponents can't cast spells this turn$/i.test(t) ||
		/^opponents can't cast spells this turn$/i.test(t)
	) {
		return [
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['opponentsCantCastThisTurn'], duration: 'endOfTurn' },
				span
			}
		];
	}

	m = t.match(/^(each opponent|target player|target opponent|that player|they|you) can't cast spells this turn$/i);
	if (m) {
		const pSel = helpers.playerSubject(m[1]);
		if (!pSel) return null;
		return [
			{
				verb: 'grantPlayer',
				subject: pSel,
				params: { playerRules: ['cantCastSpellsThisTurn'], duration: 'endOfTurn' },
				span
			}
		];
	}

	// --- Precon Bragos Spirit: "That creature's owner can't cast spells with the same name as that creature until your next turn" ---
	m = t.match(
		/^(.+?) can't cast spells with the same name as (?:that (?:creature|permanent|card)|it) until your next turn$/i
	);
	if (m) {
		const pSel = helpers.playerSubject(m[1].trim());
		const nameRef = helpers.itRef();
		if (!pSel || !nameRef) return null;
		return [
			{
				verb: 'castNameLock',
				subject: pSel,
				params: { castNameLockRef: nameRef, duration: 'untilYourNextTurn' },
				span
			}
		];
	}
	// --- End Precon Bragos Spirit ---

	if (
		/^spells you control can't be countered this turn$/i.test(t) ||
		/^this spell can't be countered, and spells you control can't be countered this turn$/i.test(t)
	) {
		return [
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: { playerRules: ['spellsCantBeCounteredThisTurn'], duration: 'endOfTurn' },
				span
			}
		];
	}

	m = t.match(/^the next (.+?) you cast this turn can't be countered$/i);
	if (m) {
		const f = parseSpellPermissionTypeFilter(m[1]);
		if (!f) return null;
		return [
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: {
					playerRules: ['nextSpellCantBeCountered'],
					...(f !== 'any' ? { nextSpellFilter: f } : {}),
					duration: 'endOfTurn'
				},
				span
			}
		];
	}

	m = t.match(
		/^you may cast (?:the next (.+?) you cast this turn|(.+?) this turn) as though (?:it|they) had flash$/i
	);
	if (m) {
		const isNext = Boolean(m[1]);
		const rawSpec = (m[1] ?? m[2]).trim();
		const f = parseSpellPermissionTypeFilter(rawSpec);
		if (!f) return null;
		return [
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: {
					playerRules: [isNext ? 'nextSpellFlash' : 'castAsThoughFlashThisTurn'],
					...(f !== 'any' ? { nextSpellFilter: f } : {}),
					duration: 'endOfTurn'
				},
				span
			}
		];
	}

	m = t.match(/^the next (.+?) you cast this turn can be cast as though it had flash$/i);
	if (m) {
		const f = parseSpellPermissionTypeFilter(m[1]);
		if (!f) return null;
		return [
			{
				verb: 'grantPlayer',
				subject: YOU,
				params: {
					playerRules: ['nextSpellFlash'],
					...(f !== 'any' ? { nextSpellFilter: f } : {}),
					duration: 'endOfTurn'
				},
				span
			}
		];
	}

	// ---- C. Player Counters (`poison`, `experience`, `rad`, `ticket` / `{TK}`) ----

	m = t.match(
		/^(you|each opponent|each player|target player|target opponent|that player|they) gets? (that many|that much|\S+) (poison|experience|rad|ticket) counters?$/i
	);
	if (m) {
		const pSel = helpers.playerSubject(m[1]);
		const amount = helpers.parseAmount(m[2]);
		const playerCounter = parsePlayerCounterKind(m[3]);
		if (!pSel || !amount || !playerCounter) return null;
		return [
			{
				verb: 'putPlayerCounters',
				subject: pSel,
				amount,
				params: { playerCounter },
				span
			}
		];
	}

	m = t.match(/^(you|each opponent|each player|target player|target opponent|that player|they) gets? ((?:\{tk\}\s*)+)$/i);
	if (m) {
		const pSel = helpers.playerSubject(m[1]);
		const tkCount = (m[2].match(/\{tk\}/gi) ?? []).length;
		if (!pSel || tkCount <= 0) return null;
		return [
			{
				verb: 'putPlayerCounters',
				subject: pSel,
				amount: { k: 'const', n: tkCount },
				params: { playerCounter: 'ticket' },
				span
			}
		];
	}

	m = t.match(/^(you|each opponent|each player|target player|target opponent|that player|they) gets? (that many|\S+)\s*\{tk\}$/i);
	if (m) {
		const pSel = helpers.playerSubject(m[1]);
		const amount = helpers.parseAmount(m[2]);
		if (!pSel || !amount) return null;
		return [
			{
				verb: 'putPlayerCounters',
				subject: pSel,
				amount,
				params: { playerCounter: 'ticket' },
				span
			}
		];
	}

	// ---- D. Counter Movement (`CR 122.5`), Multi-Counter Placement, & LKI Counter Copy (`CR 122.8–9`) ----

	// "put its counters on <dst>" / "put those counters on <dst>" (CR 122.8–9)
	m = t.match(/^put (?:its|that creature's|that permanent's) counters on (.+)$/i);
	if (m) {
		const it = helpers.itRef();
		const dst = it ? helpers.subjectSelector(m[1].trim()) : null;
		if (!it || !dst || dst.fromZone) return null;
		const fromSel: Selector =
			it.k === 'binding'
				? { k: 'binding', name: it.name }
				: it.k === 'target'
					? { k: 'target', index: it.index }
					: it.k === 'eventObject'
						? { k: 'eventObject' }
						: it.k === 'attachedTo'
							? { k: 'attachedTo' }
							: { k: 'self' };
		return [
			{
				verb: 'putCounters',
				subject: dst.sel,
				params: { copyCountersFrom: fromSel },
				bindAs: '__bind__',
				span
			}
		];
	}

	// "put a <c1> counter and a <c2> counter on <obj>"
	m = t.match(
		/^put (a|an|one|two|three|\d+) (.+?) counters? and (a|an|one|two|three|\d+) (.+?) counters? on (.+)$/i
	);
	if (m) {
		const n1 = parseSmallNumber(m[1]);
		const c1 = parseUniversalCounterName(m[2]);
		const n2 = parseSmallNumber(m[3]);
		const c2 = parseUniversalCounterName(m[4]);
		const obj = n1 && c1 && n2 && c2 ? helpers.subjectSelector(m[5].trim()) : null;
		if (!n1 || !c1 || !n2 || !c2 || !obj || obj.fromZone) return null;
		return [
			{
				verb: 'putCounters',
				subject: obj.sel,
				params: {
					multiCounters: [
						{ counter: c1, count: { k: 'const', n: n1 } },
						{ counter: c2, count: { k: 'const', n: n2 } }
					]
				},
				bindAs: '__bind__',
				span
			}
		];
	}

	// Generalized `moveCounters` (CR 122.5):
	// "move [a / N / up to N / all] [<counter> ]counter[s] from <src> onto <dst>"
	m = t.match(
		/^move (all|up to \S+|\S+)(?: (.+?))? counters? from (.+?) onto (.+)$/i
	);
	if (m) {
		const qtyRaw = m[1].trim().toLowerCase();
		const isAll = qtyRaw === 'all';
		const isUpTo = qtyRaw.startsWith('up to ');
		const amtWord = isAll ? '1' : isUpTo ? qtyRaw.slice('up to '.length).trim() : qtyRaw;
		const amount = isAll ? { k: 'const' as const, n: 999 } : helpers.parseAmount(amtWord);
		const counter: CounterType | 'any' | null = m[2] ? parseUniversalCounterName(m[2]) : 'any';
		if (amount && counter) {
			const src = helpers.subjectSelector(m[3].trim());
			const dst = src ? helpers.subjectSelector(m[4].trim()) : null;
			if (src && !src.fromZone && dst && !dst.fromZone) {
				// Enforce `otherTarget` when both `src` and `dst` are target specs ("onto another target creature").
				if (
					src.sel.k === 'target' &&
					dst.sel.k === 'target' &&
					dst.sel.index > src.sel.index &&
					/^another target\b/i.test(m[4].trim())
				) {
					const dstSpec = helpers.getTarget(dst.sel.index);
					if (dstSpec) {
						delete dstSpec.filter.other;
						dstSpec.otherTarget = true;
					}
				}
				return [
					{
						verb: 'moveCounters',
						subject: dst.sel,
						amount,
						params: {
							moveCounterSpec: {
								from: src.sel,
								counter,
								...(isAll ? { all: true } : {}),
								...(isUpTo ? { upTo: true } : {})
							}
						},
						bindAs: '__bind__',
						span
					}
				];
			}
		}
	}

	// ---- E. Selective Non-Targeted Bounce / Return / Exile (`choiceCount`) & Mass Graveyard Reanimation ----

	// Mass graveyard return:
	// "(return|put) all [<filter> ]cards from (your graveyard|all graveyards) (to|onto) (the battlefield[ tapped][ under your control]|your hand|their owners' hands)"
	m = t.match(
		/^(?:return|put) all (.+?) from (your graveyard|all graveyards) (?:to|onto) (the battlefield(?: tapped)?(?: under your control)?|your hand|their owners' hands)$/i
	);
	if (m) {
		const rawCardPhrase = m[1].trim();
		const filter = /^cards$/i.test(rawCardPhrase) ? {} : helpers.objectFilter(rawCardPhrase);
		if (filter && !filter.zone && !filter.controller) {
			const fromYour = m[2].toLowerCase() === 'your graveyard';
			const destRaw = m[3].toLowerCase();
			if (!fromYour && destRaw === 'your hand') return null;
			const toBattlefield = destRaw.startsWith('the battlefield');
			if (toBattlefield && (filter.types?.includes('Instant') || filter.types?.includes('Sorcery'))) {
				return null;
			}
			const fullFilter: ObjectFilter = {
				...filter,
				...(toBattlefield && !filter.types && !filter.notTypes
					? { notTypes: ['Instant', 'Sorcery'] }
					: {}),
				zone: 'graveyard',
				...(fromYour ? { owner: 'you' } : {})
			};
			const params: EffectParams = {
				from: 'graveyard',
				to: toBattlefield ? 'battlefield' : 'hand',
				...(destRaw.includes('tapped') ? { tapped: true } : {}),
				...(destRaw.includes('under your control') ? { underYourControl: true } : {})
			};
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: fullFilter },
					params,
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Selective non-targeted graveyard return/put (`choiceCount`):
	// "(return|put) (up to )?(a|an|one|two|\d+) <filter> card(s)? from (your|a|an opponent's) graveyard (to|onto) (your hand|the battlefield[ tapped][ under your control][ with N <counter> counters on it])"
	m = t.match(
		/^(?:return|put) (up to )?(a|an|one|two|three|\d+) (.+? cards?) from (your|a|an opponent's) graveyard (?:to|onto) (your hand|the battlefield(?: tapped)?(?: under your control)?(?: with (a|an|one|two|three|four|\d+) (.+?) counters? on (?:it|them))?)$/i
	);
	if (m && !/\btarget\b/i.test(m[3]) && !/\bat random\b/i.test(t)) {
		const upTo = Boolean(m[1]);
		const nVal = parseSmallNumber(m[2]);
		const filter = nVal !== null ? helpers.objectFilter(m[3].trim()) : null;
		const whoGy = m[4].toLowerCase();
		const destRaw = m[5].toLowerCase();
		const toBattlefield = destRaw.startsWith('the battlefield');
		const withCtrCount = m[6] ? parseSmallNumber(m[6]) : null;
		const withCtrName = m[7] ? parseUniversalCounterName(m[7]) : null;
		if (
			nVal !== null &&
			filter &&
			!filter.zone &&
			!filter.controller &&
			(toBattlefield || whoGy === 'your') &&
			(!m[6] || (withCtrCount !== null && withCtrName !== null))
		) {
			const owner: ObjectFilter['owner'] =
				whoGy === 'your' ? 'you' : whoGy === 'a' ? 'any' : 'opponent';
			const underYourControl =
				toBattlefield && (owner !== 'you' || destRaw.includes('under your control'));
			const params: EffectParams = {
				from: 'graveyard',
				to: toBattlefield ? 'battlefield' : 'hand',
				choiceCount: { k: 'const', n: nVal },
				...(upTo ? { upTo: true } : {}),
				...(destRaw.includes('tapped') ? { tapped: true } : {}),
				...(underYourControl ? { underYourControl: true } : {}),
				...(withCtrCount !== null && withCtrName !== null
					? { withCounters: { counter: withCtrName, count: withCtrCount } }
					: {})
			};
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { ...filter, zone: 'graveyard', owner } },
					params,
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Pick from milled / exiled / revealed cards (`choiceCount` + `moveFilter`):
	// "put (up to )?(a|an|one|two|three|\d+) <filter> from among (them|those cards|the cards milled this way|cards milled this way|the exiled cards|cards exiled this way) (into your hand|onto the battlefield[ tapped])"
	m = t.match(
		/^put (up to )?(a|an|one|two|three|\d+) (.+?) from among (?:them|those cards|the cards milled this way|cards milled this way|the exiled cards|cards exiled this way) (into your hand|onto the battlefield(?: tapped)?)$/i
	);
	if (m && !/\btarget\b/i.test(m[3])) {
		const upTo = Boolean(m[1]);
		const nVal = parseSmallNumber(m[2]);
		const rawFilter = m[3].trim();
		const filter =
			/^cards?$/i.test(rawFilter) ? {} : nVal !== null ? helpers.objectFilter(rawFilter) : null;
		const boundRef = helpers.ensureLastStepBound?.() ?? helpers.itRef();
		if (
			nVal !== null &&
			filter &&
			!filter.zone &&
			!filter.controller &&
			boundRef &&
			boundRef.k === 'binding'
		) {
			const destRaw = m[4].toLowerCase();
			const toBattlefield = destRaw.startsWith('onto the battlefield');
			return [
				{
					verb: 'move',
					subject: { k: 'binding', name: boundRef.name },
					params: {
						to: toBattlefield ? 'battlefield' : 'hand',
						...(destRaw.includes('tapped') ? { tapped: true } : {}),
						...(Object.keys(filter).length > 0 ? { moveFilter: filter } : {}),
						choiceCount: { k: 'const', n: nVal },
						...(upTo ? { upTo: true } : {})
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Selective non-targeted graveyard exile (`choiceCount`):
	// "[<player> ]exiles? (up to )?(a|an|one|two|three|\d+) <filter> from (your|a|an opponent's|their|that player's) graveyard"
	m = t.match(
		/^(?:(you|target player|target opponent|that player|they)\s+)?exiles? (up to )?(a|an|one|two|three|\d+) (.+?) from (your|a|an opponent's|their|that player's) graveyard$/i
	);
	if (m && !/\btarget\b/i.test(m[4]) && !/\bat random\b/i.test(t)) {
		const actorRaw = m[1]?.trim().toLowerCase();
		const actorSel = actorRaw ? helpers.playerSubject(actorRaw) : null;
		const actorRef = actorSel ? helpers.singlePlayer(actorSel) : ({ k: 'you' } as PlayerRef);
		const upTo = Boolean(m[2]);
		const nVal = parseSmallNumber(m[3]);
		const rawWhat = m[4].trim();
		const filter =
			/^cards?$/i.test(rawWhat) ? {} : nVal !== null ? helpers.objectFilter(rawWhat) : null;
		const gyRaw = m[5].toLowerCase();
		if (nVal !== null && filter && !filter.zone && !filter.controller && actorRef) {
			let gyOwner: ObjectFilter['owner'];
			let gyOwnerRef: PlayerRef | undefined;
			if (gyRaw === 'your') gyOwner = 'you';
			else if (gyRaw === 'a') gyOwner = 'any';
			else if (gyRaw === "an opponent's") gyOwner = 'opponent';
			else {
				const pSel = helpers.playerSubject('that player');
				const pRef = pSel ? helpers.singlePlayer(pSel) : null;
				if (!pRef) gyOwner = undefined;
				else gyOwnerRef = pRef;
			}
			if (gyOwner || gyOwnerRef) {
				return [
					{
						verb: 'exile',
						subject: {
							k: 'all',
							filter: {
								...filter,
								zone: 'graveyard',
								...(gyOwner ? { owner: gyOwner } : {}),
								...(gyOwnerRef ? { controllerRef: gyOwnerRef } : {})
							}
						},
						...(actorRef.k !== 'you' ? { actor: actorRef } : {}),
						params: {
							choiceCount: { k: 'const', n: nVal },
							...(upTo ? { upTo: true } : {})
						},
						bindAs: '__bind__',
						span
					}
				];
			}
		}
	}

	// Eldrazi Processor: "put (up to )?(a|an|one|two|three|\d+) card(s) an opponent owns from exile into that player's graveyard"
	m = t.match(
		/^put (up to )?(a|an|one|two|three|\d+) cards? an opponent owns from exile into (?:that player's|their|their owners') graveyards?$/i
	);
	if (m) {
		const upTo = Boolean(m[1]);
		const nVal = parseSmallNumber(m[2]);
		if (nVal !== null && nVal >= 1) {
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { zone: 'exile', owner: 'opponent' } },
					params: {
						from: 'exile',
						to: 'graveyard',
						choiceCount: { k: 'const', n: nVal },
						...(upTo ? { upTo: true } : {})
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// "discard up to N card(s)"
	m = t.match(/^discards? up to (a|an|one|two|three|four|\d+) cards?$/i);
	if (m) {
		const nVal = parseSmallNumber(m[1]);
		if (nVal !== null && nVal >= 1) {
			return [
				{
					verb: 'discard',
					subject: { k: 'player', filter: { relation: 'you' } },
					amount: { k: 'const', n: nVal },
					params: { upTo: true },
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// "all creatures able to block <subject> this turn do so" (Lure)
	m = t.match(/^all creatures able to block (.+?) this turn do so$/i);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (subj && !subj.fromZone) {
			return [
				{
					verb: 'grant',
					subject: subj.sel,
					params: { mustBeBlockedThisTurn: true, duration: 'endOfTurn' },
					...(subj.bind ? { bindAs: '__bind__' } : {}),
					span
				}
			];
		}
	}

	// "exile <subject> with N <counter> counter(s) on it/them"
	m = t.match(
		/^exile (.+?) with (a|an|one|two|three|four|five|six|\d+) (.+?) counters? on (?:it|them)$/i
	);
	if (m && !/^the top\b/i.test(m[1])) {
		const cVal = parseSmallNumber(m[2]);
		const cName = parseUniversalCounterName(m[3]);
		const subj = cVal !== null && cName ? helpers.subjectSelector(m[1].trim()) : null;
		if (subj && cVal !== null && cName) {
			return [
				{
					verb: 'exile',
					subject: subj.sel,
					params: { exileWithCounters: { counter: cName, count: cVal } },
					...(subj.bind && !(subj.sel.k === 'self' && helpers.isSpellContext)
						? { bindAs: '__bind__' }
						: {}),
					span
				}
			];
		}
	}

	// "<player> exiles (up to )?(a|an|one|two|three|\d+) <filter> from their hand"
	m = t.match(
		/^(target player|target opponent|each opponent|that player|they)\s+exiles? (up to )?(a|an|one|two|three|\d+) (.+?) from their hands?$/i
	);
	if (m) {
		const whoRaw = m[1].trim().toLowerCase();
		const upTo = Boolean(m[2]);
		const nVal = parseSmallNumber(m[3]);
		const rawWhat = m[4].trim();
		const filter =
			/^cards?$/i.test(rawWhat) ? {} : nVal !== null ? helpers.objectFilter(rawWhat) : null;
		const pSel = helpers.playerSubject(whoRaw);
		if (nVal !== null && filter && !filter.zone && !filter.controller && pSel) {
			const pRef = helpers.singlePlayer(pSel);
			const isEachOpp = pSel.k === 'player' && pSel.filter.relation === 'each_opponent';
			if (pRef || isEachOpp) {
				return [
					{
						verb: 'exile',
						subject: {
							k: 'all',
							filter: {
								...filter,
								zone: 'hand',
								...(isEachOpp ? { owner: 'opponent' } : {})
							}
						},
						...(pRef && pRef.k !== 'you' ? { actor: pRef } : {}),
						amount: { k: 'const', n: nVal },
						...(upTo ? { params: { upTo: true } } : {}),
						bindAs: '__bind__',
						span
					}
				];
			}
		}
	}

	// Multi-recipient burn: "(~|it) deals M damage to <recA> and N damage to <recB>"
	m = t.match(/^(~|it) deals (\d+|x) damage to (.+?) and (\d+|x) damage to (.+)$/i);
	if (m) {
		const srcSubj =
			m[1].toLowerCase() === 'it'
				? helpers.subjectSelector('it') ?? { sel: { k: 'self' } as Selector, bind: false }
				: { sel: { k: 'self' } as Selector, bind: false };
		const amt1: Amount = /^x$/i.test(m[2]) ? { k: 'x' } : { k: 'const', n: parseInt(m[2], 10) };
		const amt2: Amount = /^x$/i.test(m[4]) ? { k: 'x' } : { k: 'const', n: parseInt(m[4], 10) };
		const parseDmgRecipient = (rawRec: string): Selector | null => {
			const r = rawRec.trim();
			if (/^any target$/i.test(r)) {
				const idx = helpers.addTarget({
					kind: 'objectOrPlayer',
					min: 1,
					max: 1,
					filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
					player: { relation: 'any' }
				});
				return { k: 'target', index: idx };
			}
			if (/^(?:any other target|another target)$/i.test(r)) {
				const idx = helpers.addTarget({
					kind: 'objectOrPlayer',
					min: 1,
					max: 1,
					otherTarget: true,
					filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
					player: { relation: 'any' }
				});
				return { k: 'target', index: idx };
			}
			if (/^up to one other target$/i.test(r)) {
				const idx = helpers.addTarget({
					kind: 'objectOrPlayer',
					min: 0,
					max: 1,
					otherTarget: true,
					filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] },
					player: { relation: 'any' }
				});
				return { k: 'target', index: idx };
			}
			const pSel = helpers.playerSubject(r);
			if (pSel) return pSel;
			const oSel = helpers.subjectSelector(r);
			if (oSel && !oSel.fromZone) return oSel.sel;
			return null;
		};
		const rec1 = parseDmgRecipient(m[3]);
		const rec2 = rec1 ? parseDmgRecipient(m[5]) : null;
		if (rec1 && rec2) {
			const dmgParams: EffectParams =
				srcSubj.sel.k !== 'self' ? { damageSource: srcSubj.sel } : {};
			return [
				{
					verb: 'damage',
					subject: rec1,
					amount: amt1,
					...(Object.keys(dmgParams).length > 0 ? { params: { ...dmgParams } } : {}),
					span
				},
				{
					verb: 'damage',
					subject: rec2,
					amount: amt2,
					...(Object.keys(dmgParams).length > 0 ? { params: { ...dmgParams } } : {}),
					span
				}
			];
		}
	}

	// Selective non-targeted self-bounce (`choiceCount`):
	// "return (up to )?(a|an|another|one|two|\d+) <filter> you control to its owner's hand / their owners' hands"
	m = t.match(
		/^return (up to )?(another|a|an|one|two|three|\d+) (.+?) you control to (?:its owner's|their owners'|your) hands?$/i
	);
	if (m && !/\btarget\b/i.test(m[3])) {
		const upTo = Boolean(m[1]);
		const isAnother = m[2].toLowerCase() === 'another';
		const nVal = isAnother ? 1 : parseSmallNumber(m[2]);
		const filter = nVal !== null ? helpers.objectFilter(m[3].trim()) : null;
		if (nVal !== null && filter && !filter.zone && !filter.controller) {
			return [
				{
					verb: 'bounce',
					subject: {
						k: 'all',
						filter: {
							...filter,
							...(isAnother ? { other: true } : {}),
							zone: 'battlefield',
							controller: 'you'
						}
					},
					params: {
						choiceCount: { k: 'const', n: nVal },
						...(upTo ? { upTo: true } : {})
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Selective non-targeted counter placement (`choiceCount`):
	// "put (that many|X|a|an|one|two|\d+) <counter> counters? on (up to )?(another|a|an|one|two|three|\d+) <filter> you control"
	m = t.match(
		/^put (that many|that much|\S+) (.+?) counters? on (up to )?(another|a|an|one|two|three|\d+) (.+?) you control$/i
	);
	if (m && !/\btarget\b/i.test(m[5])) {
		const amount = helpers.parseAmount(m[1]);
		const counter = parseUniversalCounterName(m[2]);
		const upTo = Boolean(m[3]);
		const isAnother = m[4].toLowerCase() === 'another';
		const pickN = isAnother ? 1 : parseSmallNumber(m[4]);
		const filter = amount && counter && pickN !== null ? helpers.objectFilter(m[5].trim()) : null;
		if (amount && counter && pickN !== null && filter && !filter.zone && !filter.controller) {
			return [
				{
					verb: 'putCounters',
					subject: {
						k: 'all',
						filter: {
							...filter,
							...(isAnother ? { other: true } : {}),
							zone: 'battlefield',
							controller: 'you'
						}
					},
					amount,
					params: {
						counter,
						choiceCount: { k: 'const', n: pickN },
						...(upTo ? { upTo: true } : {})
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Selective non-targeted tap / untap (`choiceCount`):
	// "(tap|untap) (any number of|up to ...|another|a|an|one|two|three|four|five|six|\d+) <filter>( you control)?"
	m = t.match(
		/^(tap|untap) (?:(any number of)|(up to )?(another|a|an|one|two|three|four|five|six|\d+)) (.+?)( you control)?$/i
	);
	if (m && !/\btarget\b/i.test(m[5])) {
		const verb: 'tap' | 'untap' = m[1].toLowerCase() === 'tap' ? 'tap' : 'untap';
		const isAnyNumber = Boolean(m[2]);
		const upTo = isAnyNumber || Boolean(m[3]);
		const isAnother = !isAnyNumber && m[4].toLowerCase() === 'another';
		const pickN = isAnyNumber ? 99 : isAnother ? 1 : parseSmallNumber(m[4]);
		const filter = pickN !== null ? helpers.objectFilter(m[5].trim()) : null;
		if (pickN !== null && filter && !filter.zone && !filter.controller) {
			return [
				{
					verb,
					subject: {
						k: 'all',
						filter: {
							...filter,
							...(isAnother ? { other: true } : {}),
							zone: 'battlefield',
							...(m[6] ? { controller: 'you' } : {})
						}
					},
					params: {
						choiceCount: { k: 'const', n: pickN },
						...(upTo ? { upTo: true } : {})
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// Self-exile cast permission ("You may cast ~ for as long as it remains exiled / this turn"):
	m = t.match(
		/^you may (play|cast) ~ (this turn|until end of turn|until (?:the )?end of your next turn|until your next end step|for as long as it remains exiled)$/i
	);
	if (m) {
		const dRaw = m[2].toLowerCase();
		const duration: NonNullable<EffectParams['playFromExile']>['duration'] =
			dRaw === 'this turn' || dRaw === 'until end of turn'
				? 'thisTurn'
				: dRaw === 'until your next end step'
					? 'untilYourNextEndStep'
					: dRaw.endsWith('exiled')
						? 'asLongAsExiled'
						: 'untilEndOfYourNextTurn';
		return [
			{
				verb: 'grantPlayFromExile',
				subject: { k: 'self' },
				params: {
					playFromExile: {
						duration,
						...(m[1].toLowerCase() === 'cast' ? { spellsOnly: true } : {})
					}
				},
				span
			}
		];
	}

	// Reveal top card of library and put it into your hand (single-sentence dig=1):
	if (
		/^(?:you )?reveals? the top card of your library and puts? (?:that card|it) into your hand$/i.test(
			t
		)
	) {
		return [
			{
				verb: 'dig',
				subject: YOU,
				amount: { k: 'const', n: 1 },
				params: {
					dig: {
						keep: 1,
						upTo: false,
						keepTo: 'hand',
						rest: 'libraryBottom',
						revealAll: true
					}
				},
				bindAs: '__bind__',
				span
			}
		];
	}

	// Shuffle zones or objects into library (`CR 701.20`):
	// "<player> shuffles their (hand and graveyard|graveyard and hand|graveyard|hand) into their library"
	m = t.match(
		/^(you|each player|each opponent|target player|target opponent|that player|they) shuffles? (their|your) (hand and graveyard|graveyard and hand|graveyard|hand) into (their|your) librar(?:y|ies)$/i
	);
	if (m) {
		const whoRaw = m[1].toLowerCase();
		const possRaw = m[2].toLowerCase();
		const zonesRaw = m[3].toLowerCase();
		if (whoRaw === 'you' && possRaw !== 'your') return null;
		const zoneField: ZoneType | ZoneType[] =
			zonesRaw === 'graveyard'
				? 'graveyard'
				: zonesRaw === 'hand'
					? 'hand'
					: ['hand', 'graveyard'];
		if (whoRaw === 'you') {
			helpers.playerSubject('you');
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { zone: zoneField, owner: 'you' } },
					params: { to: 'library', mayShuffle: true },
					span
				}
			];
		}
		if (whoRaw === 'each player') {
			if (zonesRaw === 'hand') return null;
			helpers.playerSubject('each player');
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { zone: zoneField } },
					params: { to: 'library', mayShuffle: true },
					span
				}
			];
		}
		if (whoRaw === 'each opponent') {
			helpers.playerSubject('each opponent');
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { zone: zoneField, owner: 'opponent' } },
					params: { to: 'library', mayShuffle: true },
					span
				}
			];
		}
		const pSel = helpers.playerSubject(m[1]);
		const pRef = pSel ? helpers.singlePlayer(pSel) : null;
		if (pRef) {
			return [
				{
					verb: 'move',
					subject: { k: 'all', filter: { zone: zoneField, controllerRef: pRef } },
					actor: pRef,
					params: { to: 'library', mayShuffle: true },
					span
				}
			];
		}
	}

	// Imperative "shuffle your (hand and graveyard|graveyard|hand) into your library"
	m = t.match(
		/^shuffle your (hand and graveyard|graveyard and hand|graveyard|hand) into your library$/i
	);
	if (m) {
		const zonesRaw = m[1].toLowerCase();
		const zoneField: ZoneType | ZoneType[] =
			zonesRaw === 'graveyard'
				? 'graveyard'
				: zonesRaw === 'hand'
					? 'hand'
					: ['hand', 'graveyard'];
		return [
			{
				verb: 'move',
				subject: { k: 'all', filter: { zone: zoneField, owner: 'you' } },
				params: { to: 'library', mayShuffle: true },
				span
			}
		];
	}

	// Imperative "shuffle <object> into its owner's / their owners' / your library"
	m = t.match(
		/^shuffle (.+?) into (its owner's|their owner's|their owners'|your) librar(?:y|ies)$/i
	);
	if (m) {
		const subj = helpers.subjectSelector(m[1].trim());
		if (subj) {
			if (m[2].toLowerCase() === 'your') {
				const okYour =
					subj.sel.k === 'self' ||
					subj.sel.k === 'binding' ||
					(subj.sel.k === 'target' &&
						(helpers.getTarget(subj.sel.index)?.filter.owner === 'you' ||
							helpers.getTarget(subj.sel.index)?.filter.controller === 'you')) ||
					(subj.sel.k === 'all' &&
						(subj.sel.filter.owner === 'you' || subj.sel.filter.controller === 'you'));
				if (!okYour) return null;
			}
			return [
				{
					verb: 'move',
					subject: subj.sel,
					params: { to: 'library', mayShuffle: true },
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// ---- F. Free-Cast & Copy-Card-and-Cast (`castFree`, CR 707.12) ----

	// Cast from your hand without paying its mana cost:
	// "cast (?:up to )?(?:a|an|one) <filter>[ with mana value <N|X> or less] from your hand[ with mana value <N|X> or less] without paying its mana cost"
	m = t.match(
		/^cast (?:up to )?(?:a|an|one) (.+?) from your hand(?: with mana value (\S+) or less)? without paying its mana cost$/i
	);
	if (m) {
		let rawPhrase = m[1].trim();
		let mvWord: string | undefined = m[2];
		const midMv = rawPhrase.match(/^(.+?) with mana value (\S+) or less$/i);
		if (midMv && !mvWord) {
			rawPhrase = midMv[1].trim();
			mvWord = midMv[2];
		}
		let mvFilter: ObjectFilter | undefined;
		if (mvWord) {
			if (/^x$/i.test(mvWord)) {
				mvFilter = { manaValue: { op: '<=', value: { k: 'x' } } };
			} else {
				const mvCap = parseSmallNumber(mvWord);
				if (mvCap === null) return null;
				mvFilter = { manaValue: { op: '<=', value: { k: 'const', n: mvCap } } };
			}
		}
		const parsed = /^spells?$|^cards?$/i.test(rawPhrase)
			? { notTypes: ['Land'] }
			: (helpers.objectFilter(rawPhrase) ??
				helpers.objectFilter(`${rawPhrase.replace(/\s+spells?$/i, '')} card`));
		if (parsed && !parsed.zone && !parsed.controller) {
			return [
				{
					verb: 'castFree',
					subject: {
						k: 'all',
						filter: { ...parsed, ...(mvFilter ?? {}), zone: 'hand', owner: 'you' }
					},
					params: {
						castFreeSpec: {
							withoutPayingManaCost: true,
							upToCount: 1
						}
					},
					bindAs: '__bind__',
					span
				}
			];
		}
	}

	// "cast (it|that card|the copy|a spell from among them|...) without paying its mana cost"
	m = t.match(
		/^cast (it|that card|the exiled card|the copy|that copy|(?:(?:up to )?(?:a|an|one) )?.+? (?:from among (?:them|those cards|the exiled cards)|exiled with ~|from (?:your|a|an opponent's|that player's|their) graveyard))(?: with mana value (?:less than or equal to (~'s power)|(\S+) or less))? without paying (?:its|their) mana costs?$/i
	);
	if (m) {
		let what = m[1].trim();
		let mvFilter: ObjectFilter | undefined;
		const inlineSelfPow = what.match(
			/^(.+?) with mana value less than or equal to ~'s power( from .+)$/i
		);
		if (inlineSelfPow && !m[2] && !m[3]) {
			what = `${inlineSelfPow[1].trim()}${inlineSelfPow[2]}`;
			mvFilter = {
				manaValue: { op: '<=', value: { k: 'stat', of: { k: 'self' }, stat: 'power' } }
			};
		}
		const inlineMvCap = !mvFilter
			? what.match(/^(.+?) with mana value (\S+) or less( from .+)$/i)
			: null;
		if (inlineMvCap && !m[2] && !m[3]) {
			what = `${inlineMvCap[1].trim()}${inlineMvCap[3]}`;
			if (/^x$/i.test(inlineMvCap[2])) {
				mvFilter = { manaValue: { op: '<=', value: { k: 'x' } } };
			} else {
				const cap = parseSmallNumber(inlineMvCap[2]);
				if (cap === null) return null;
				mvFilter = { manaValue: { op: '<=', value: { k: 'const', n: cap } } };
			}
		}
		if (m[2]) {
			mvFilter = {
				manaValue: { op: '<=', value: { k: 'stat', of: { k: 'self' }, stat: 'power' } }
			};
		} else if (m[3]) {
			if (/^x$/i.test(m[3])) {
				mvFilter = { manaValue: { op: '<=', value: { k: 'x' } } };
			} else {
				const mvCap = parseSmallNumber(m[3]);
				if (mvCap === null) return null;
				mvFilter = { manaValue: { op: '<=', value: { k: 'const', n: mvCap } } };
			}
		}

		let subjSel: Selector | null = null;
		let extraFilter: ObjectFilter | undefined;
		if (/^(?:it|that card|the exiled card|the copy|that copy)$/i.test(what)) {
			const it = helpers.itRef();
			if (!it) return null;
			subjSel =
				it.k === 'binding'
					? { k: 'binding', name: it.name }
					: it.k === 'target'
						? { k: 'target', index: it.index }
						: it.k === 'eventObject'
							? { k: 'eventObject' }
							: { k: 'self' };
		} else {
			const fromAmong = what.match(
				/^(?:up to )?(?:a|an|one) (.+?) from among (?:them|those cards|the exiled cards)$/i
			);
			const nonTargetedGy = !fromAmong && !/\btarget\b/i.test(what)
				? what.match(
						/^(?:up to )?(?:a|an|one) (.+?) from (your|a|an opponent's|that player's|their) graveyard$/i
					)
				: null;
			if (fromAmong) {
				const it = helpers.itRef();
				if (!it) return null;
				const subPhrase = fromAmong[1].trim();
				if (!/^spells?$/i.test(subPhrase) && !/^cards?$/i.test(subPhrase)) {
					const parsed =
						helpers.objectFilter(subPhrase) ??
						helpers.objectFilter(`${subPhrase.replace(/\s+spells?$/i, '')} card`);
					if (!parsed) return null;
					extraFilter = parsed;
				}
				subjSel =
					it.k === 'binding'
						? { k: 'binding', name: it.name }
						: it.k === 'target'
							? { k: 'target', index: it.index }
							: { k: 'eventObject' };
			} else if (nonTargetedGy) {
				const subPhrase = nonTargetedGy[1].trim();
				const gyWho = nonTargetedGy[2].toLowerCase();
				const parsed =
					/^cards?$|^spells?$/i.test(subPhrase)
						? { notTypes: ['Land'] }
						: (helpers.objectFilter(subPhrase) ??
							helpers.objectFilter(`${subPhrase.replace(/\s+spells?$/i, '')} card`));
				if (!parsed) return null;
				const gyFilter: ObjectFilter = { ...parsed, zone: 'graveyard' };
				if (gyWho === 'your') gyFilter.owner = 'you';
				else if (gyWho === "an opponent's") gyFilter.owner = 'opponent';
				else if (gyWho === "that player's" || gyWho === 'their') {
					const pSel = helpers.playerSubject(gyWho === 'their' ? 'they' : 'that player');
					const pRef = pSel ? helpers.singlePlayer(pSel) : null;
					if (!pRef) return null;
					gyFilter.controllerRef = pRef;
				}
				subjSel = { k: 'all', filter: gyFilter };
			} else if (/\bexiled with ~$/i.test(what)) {
				const subPhrase = what
					.replace(/\s+exiled with ~$/i, '')
					.replace(/^(?:up to )?(?:a|an|one)\s+/i, '')
					.trim();
				const parsed =
					/^cards?$|^spells?$/i.test(subPhrase)
						? {}
						: (helpers.objectFilter(subPhrase) ??
							helpers.objectFilter(`${subPhrase.replace(/\s+spells?$/i, '')} card`));
				if (!parsed) return null;
				subjSel = { k: 'all', filter: { ...parsed, zone: 'exile', exiledWithSelf: true } };
			} else {
				const parsedSubj = helpers.subjectSelector(what);
				if (!parsedSubj) return null;
				if (mvFilter && parsedSubj.sel.k === 'target') {
					const tSpec = helpers.getTarget(parsedSubj.sel.index);
					if (tSpec) tSpec.filter = { ...tSpec.filter, ...mvFilter };
					mvFilter = undefined;
				}
				subjSel = parsedSubj.sel;
			}
		}

		if (!subjSel) return null;
		const mergedFilter =
			extraFilter || mvFilter ? { ...(extraFilter ?? {}), ...(mvFilter ?? {}) } : undefined;
		const castFreeSpec: CastFreeSpec = {
			withoutPayingManaCost: true,
			...(mergedFilter ? { filter: mergedFilter } : {}),
			upToCount: 1
		};
		return [
			{
				verb: 'castFree',
				subject: subjSel,
				params: { castFreeSpec },
				bindAs: '__bind__',
				span
			}
		];
	}

	return null;
}

/**
 * Parses two-pile library split effects (`CR 700.3`), either as a single combined sentence or
 * across adjacent sentences ("Reveal/Look at the top N cards of your library. An opponent separates
 * those cards into two piles. Put one pile into your hand and the other into your graveyard.").
 */
export function tryParsePileSplitFollowUp(
	pendingSteps: EffectStep[],
	text: string
): boolean {
	const prev = pendingSteps[pendingSteps.length - 1];
	if (!prev) return false;
	const t = text.trim();

	// Step 1 -> Step 2: previous step was `dig` (with no keep/rest yet) from "Reveal/Look at the top N cards of your library."
	if (prev.verb === 'dig' && !prev.params?.dig) {
		const sep = t.match(
			/^(?:(an opponent|target opponent|you) separates?|separate) (?:those cards|them) into two piles$/i
		);
		if (sep) {
			const rawWho = sep[1]?.toLowerCase() ?? 'you';
			const maker: 'you' | 'opponent' = rawWho === 'you' ? 'you' : 'opponent';
			prev.verb = 'pileSplit';
			prev.params = {
				...prev.params,
				pileSplit: {
					reveal: true,
					pileMaker: maker,
					pileChooser: maker === 'opponent' ? 'you' : 'opponent',
					chosenTo: 'hand',
					otherTo: 'graveyard'
				}
			};
			return true;
		}
	}

	// Step 2 -> Step 3: previous step is `pileSplit`, refine chooser / destinations
	if (prev.verb === 'pileSplit' && prev.params?.pileSplit) {
		const ps = prev.params.pileSplit;
		if (
			/^(?:an opponent|target opponent|that opponent|that player|they) chooses? one of (?:those|the) piles$/i.test(
				t
			)
		) {
			prev.params = {
				...prev.params,
				pileSplit: { ...ps, pileChooser: 'opponent' }
			};
			return true;
		}
		let m = t.match(
			/^put (one|that) pile (into your hand|onto the battlefield) and the other (into your graveyard|on the bottom of your library(?: in a random order| in any order)?|into exile)$/i
		);
		if (m) {
			const isThatPile = m[1].toLowerCase() === 'that';
			const chosenTo: PileSplitSpec['chosenTo'] =
				m[2].toLowerCase() === 'onto the battlefield' ? 'battlefield' : 'hand';
			const otherRaw = m[3].toLowerCase();
			const otherTo: PileSplitSpec['otherTo'] = otherRaw.startsWith('on the bottom')
				? 'libraryBottom'
				: otherRaw === 'into exile'
					? 'exile'
					: 'graveyard';
			const otherRandomOrder = otherRaw.includes('random order');
			prev.params = {
				...prev.params,
				pileSplit: {
					...ps,
					pileChooser: isThatPile ? ps.pileChooser : 'you',
					chosenTo,
					otherTo,
					...(otherRandomOrder ? { otherRandomOrder: true } : {})
				}
			};
			return true;
		}
		m = t.match(
			/^(?:an opponent|that opponent|that player|they) chooses? one of those piles\.?\s*put that pile (into your hand|onto the battlefield) and the other (into your graveyard|on the bottom of your library(?: in a random order| in any order)?)$/i
		);
		if (m) {
			const chosenTo: PileSplitSpec['chosenTo'] =
				m[1].toLowerCase() === 'onto the battlefield' ? 'battlefield' : 'hand';
			const otherRaw = m[2].toLowerCase();
			const otherTo: PileSplitSpec['otherTo'] = otherRaw.startsWith('on the bottom')
				? 'libraryBottom'
				: 'graveyard';
			prev.params = {
				...prev.params,
				pileSplit: {
					...ps,
					pileChooser: 'opponent',
					chosenTo,
					otherTo,
					...(otherRaw.includes('random order') ? { otherRandomOrder: true } : {})
				}
			};
			return true;
		}
	}

	return false;
}

// ---- 5. Wave 6 Object Predicates (Choice Grants, Choice Animations, Combat Overrides) -------

export function tryParseWave6ObjectPredicate(
	subjectSelector: Selector,
	validBattlefieldObjectSubject: boolean,
	predText: string,
	eot: boolean,
	duration: Duration | undefined,
	span: Span
): EffectStep[] | null {
	if (!validBattlefieldObjectSubject) return null;
	const effDuration: Duration = duration ?? 'endOfTurn';

	// CR 701.64 / 701.28: "<subj> becomes harnessed" / "<subj> converts"
	if (!eot && /^becomes? harnessed$/i.test(predText)) {
		return [{ verb: 'harness', subject: subjectSelector, span }];
	}
	if (!eot && /^converts?$/i.test(predText)) {
		return [{ verb: 'convert', subject: subjectSelector, span }];
	}

	// Choice grants:
	// "gains protection from the color of your choice [until end of turn]"
	if (eot && /^gains? protection from the color of your choice$/i.test(predText)) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { chooseProtectionColor: true, duration: effDuration },
				span
			}
		];
	}

	// "gains your choice of <kw1>, <kw2>, or <kw3> [until end of turn / permanently on binding]"
	const choiceKw = predText.match(/^gains? your choice of (.+)$/i);
	if (choiceKw && (eot || subjectSelector.k === 'binding')) {
		const parts = choiceKw[1]
			.split(/,\s*or\s+|\s+or\s+|,\s*/i)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (
			parts.length >= 2 &&
			parts.every((k) => GRANTABLE_KEYWORDS.includes(k) || k === 'changeling')
		) {
			const formatted = parts.map((k) => k.charAt(0).toUpperCase() + k.slice(1));
			return [
				{
					verb: 'grant',
					subject: subjectSelector,
					params: {
						chooseKeywordOptions: formatted,
						duration: duration ?? 'permanent'
					},
					span
				}
			];
		}
	}

	// Choice animations:
	// "becomes the creature type of your choice [in addition to its other types] until end of turn"
	if (
		eot &&
		/^becomes? the creature type of your choice( in addition to (?:its|their) other types)?$/i.test(
			predText
		)
	) {
		const additive = /\bin addition to\b/i.test(predText);
		return [
			{
				verb: 'animate',
				subject: subjectSelector,
				params: {
					chooseCreatureType: true,
					...(additive ? { keepExistingTypes: true } : {}),
					duration: effDuration
				},
				span
			}
		];
	}

	// "becomes a (Plains|Island|Swamp|Mountain|Forest) [in addition to its other types] until end of turn" (CR 305.7)
	const explicitLandShift = predText.match(
		/^becomes? (?:a|an) (Plains|Island|Swamp|Mountain|Forest)( in addition to (?:its|their) other types)?$/i
	);
	if (eot && explicitLandShift) {
		const landSub =
			explicitLandShift[1].charAt(0).toUpperCase() +
			explicitLandShift[1].slice(1).toLowerCase();
		const additive = Boolean(explicitLandShift[2]);
		return [
			{
				verb: 'animate',
				subject: subjectSelector,
				params: {
					keepExistingTypes: true,
					...(additive ? { addSubtypes: [landSub] } : { setSubtypes: [landSub] }),
					duration: effDuration
				},
				span
			}
		];
	}

	// "gets +M/+N [until end of turn] and can attack this turn as though it didn't have defender"
	const pumpNoDef = predText.match(
		/^gets? ([+-]\d+)\/([+-]\d+)(?: until end of turn)?,?\s+and can attack this turn as though (?:it|they) didn't have defender$/i
	);
	if ((eot || !duration) && pumpNoDef) {
		const pDelta = parseInt(pumpNoDef[1], 10);
		const tDelta = parseInt(pumpNoDef[2], 10);
		return [
			{
				verb: 'pump',
				subject: subjectSelector,
				amount: { k: 'const', n: pDelta },
				params: { toughness: { k: 'const', n: tDelta }, duration: effDuration },
				span
			},
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { canAttackNoDefender: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	// "becomes the basic land type of your choice [in addition to its other types] until end of turn"
	if (
		eot &&
		/^becomes? the basic land type of your choice( in addition to (?:its|their) other types)?$/i.test(
			predText
		)
	) {
		const additive = /\bin addition to\b/i.test(predText);
		return [
			{
				verb: 'animate',
				subject: subjectSelector,
				params: {
					chooseBasicLandType: true,
					...(additive ? { keepExistingTypes: true } : {}),
					duration: effDuration
				},
				span
			}
		];
	}

	// Combat overrides (this turn / until end of turn / until end of combat):
	if (
		(!duration && /^attacks?(?: each combat)? this turn if able$/i.test(predText)) ||
		(duration === 'endOfTurn' && /^attacks?(?: each combat)? if able$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { mustAttackThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	if (
		(!duration && /^must be blocked this turn if able$/i.test(predText)) ||
		(duration === 'endOfTurn' && /^must be blocked if able$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { mustBeBlockedThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	if (
		(!duration && /^blocks? ~ this turn if able$/i.test(predText)) ||
		(duration === 'endOfTurn' && /^blocks? ~ if able$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { mustBlockSelfThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	if (
		(!duration && /^blocks?(?: each combat)? this turn if able$/i.test(predText)) ||
		(duration === 'endOfTurn' && /^blocks?(?: each combat)? if able$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { mustBlockThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	if (
		(!duration && /^can't block ~ this turn$/i.test(predText)) ||
		(duration === 'endOfTurn' && /^can't block ~$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { cantBlockSelfThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	if (
		(!duration && /^assigns? no combat damage this turn$/i.test(predText)) ||
		((duration === 'endOfTurn' || duration === 'untilEndOfCombat') &&
			/^assigns? no combat damage$/i.test(predText))
	) {
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { assignsNoCombatDamageThisTurn: true, duration: 'endOfTurn' },
				span
			}
		];
	}

	// Layer 6 ability removal & Layer 7b base P/T setting (`CR 613.1f`, `CR 613.4b`):
	// "loses all abilities [and has base power and toughness P/T] until end of turn"
	const loseAllM = predText.match(
		/^loses? all abilities(?:,? and (?:has|have) base power and toughness (\d+|X)\/(\d+|X))?$/i
	);
	if (eot && loseAllM) {
		if (loseAllM[1] && loseAllM[2]) {
			const sp: Amount = /^x$/i.test(loseAllM[1])
				? { k: 'x' }
				: { k: 'const', n: parseInt(loseAllM[1], 10) };
			const st: Amount = /^x$/i.test(loseAllM[2])
				? { k: 'x' }
				: { k: 'const', n: parseInt(loseAllM[2], 10) };
			return [
				{
					verb: 'animate',
					subject: subjectSelector,
					params: {
						keepExistingTypes: true,
						removeAllAbilities: true,
						setPower: sp,
						setToughness: st,
						duration: effDuration
					},
					span
				}
			];
		}
		return [
			{
				verb: 'grant',
				subject: subjectSelector,
				params: { removeAllAbilities: true, duration: effDuration },
				span
			}
		];
	}

	// "(has|have) base power and toughness P/T [and loses all abilities] until end of turn"
	const basePtM = predText.match(
		/^(?:has|have) base power and toughness (\d+|X)\/(\d+|X)(?:,? and loses? all abilities)?$/i
	);
	if (eot && basePtM) {
		const sp: Amount = /^x$/i.test(basePtM[1])
			? { k: 'x' }
			: { k: 'const', n: parseInt(basePtM[1], 10) };
		const st: Amount = /^x$/i.test(basePtM[2])
			? { k: 'x' }
			: { k: 'const', n: parseInt(basePtM[2], 10) };
		const loseAll = /\bloses? all abilities$/i.test(predText);
		return [
			{
				verb: 'animate',
				subject: subjectSelector,
				params: {
					keepExistingTypes: true,
					...(loseAll ? { removeAllAbilities: true } : {}),
					setPower: sp,
					setToughness: st,
					duration: effDuration
				},
				span
			}
		];
	}

	// Layer 5 color setting / addition (`CR 613.1e`):
	// "becomes colorless / <colors> [in addition to its other colors] until end of turn"
	const colorShiftM = predText.match(
		/^becomes? (colorless|(?:(?:white|blue|black|red|green)(?:,\s*|\s+and\s+))*(?:white|blue|black|red|green))( in addition to (?:its|their) other colors)?$/i
	);
	if (eot && colorShiftM) {
		const rawCols = colorShiftM[1].toLowerCase();
		if (rawCols === 'colorless' && !colorShiftM[2]) {
			return [
				{
					verb: 'animate',
					subject: subjectSelector,
					params: { keepExistingTypes: true, setColors: [], duration: effDuration },
					span
				}
			];
		}
		const colMap: Record<string, ManaColor> = {
			white: 'W',
			blue: 'U',
			black: 'B',
			red: 'R',
			green: 'G'
		};
		const cols = rawCols
			.split(/,\s*(?:and\s+)?|\s+and\s+/)
			.map((w) => colMap[w.trim()])
			.filter(Boolean);
		if (cols.length > 0) {
			return [
				{
					verb: 'animate',
					subject: subjectSelector,
					params: {
						keepExistingTypes: true,
						...(colorShiftM[2] ? { addColors: cols } : { setColors: cols }),
						duration: effDuration
					},
					span
				}
			];
		}
	}

	// CR 701.28: "<subject> converts"
	if (!duration && /^converts?$/i.test(predText)) {
		return [{ verb: 'convert', subject: subjectSelector, span }];
	}

	return null;
}
