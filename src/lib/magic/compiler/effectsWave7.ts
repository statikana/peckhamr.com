/**
 * Wave 7 — Track P19a Effect Compiler Module (`effectsWave7.ts`)
 *
 * Pure compiler grammar rules for:
 * - Slice P19a.1: Triggered-mana `addMana` completions (`CR 605.1b`, `CR 106.7`) —
 *   `eventProducedTypes`, `eventProducedColors`, `controlledLandProducedTypes`, `controlledLandProducedColors`,
 *   `opponentLandColors`, dynamic `"mana of any color for each ..."`, and delayed tap-for-mana triggers (*High Tide*).
 * - Slice P19a.2: Multi-sentence coercive hand/graveyard selection, partial/random hand reveal,
 *   mass discard by chosen name / sacrificed colors, choice-based pump (`pumpChoices`), choice-based
 *   lose-keyword (`chooseLoseKeywordOptions`), choice-based color animation (`chooseColorForAnimate`),
 *   and `CR 119.5` `"<player>'s life total becomes N"`.
 * - Slice P19a.3: Sacrificed-cost LKI `Amount`s (`sacrificedCostStat`), `leastStatAmong`, multi-zone
 *   `greatestStatAmong`, `countedThisWay`, `difference`, and Wave 7 resolution conditions.
 * - Slice P19a.4: `CR 115.7` stack target redirection (`redirectTargets`), `CR 115.9` single-target stack
 *   qualifiers, `CR 614.10` `skipTurn`, `exileUntil`, delayed next-spell copy (`delayedNextSpellCopy`),
 *   triggered/dynamic `counterSpell`, named & dynamic (`X/X`, `tapped and attacking`, `legendary`) tokens,
 *   and `CR 609.4b` top-of-library any-color mana spending.
 */

import type {
	Amount,
	Condition,
	Duration,
	EffectParams,
	EffectStep,
	ExileUntilSpec,
	ObjectFilter,
	PlayerFilter,
	PlayerRef,
	Ref,
	Selector,
	Span,
	TargetSpec,
	TokenSpec
} from '../ir.ts';
import { GRANTABLE_KEYWORDS } from '../keywords.ts';
import { buildTokenSpec, PREDEFINED_TOKEN_DEFS } from '../oracle.ts';
import type { ManaColor } from '../types.ts';

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
	twenty: 20,
	thirty: 30,
	forty: 40
};

const ORDINAL_WORDS: Record<string, number> = {
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	'2nd': 2,
	'3rd': 3,
	'4th': 4,
	'5th': 5
};

const COLOR_WORDS: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};

const n = (value: number): Amount => ({ k: 'const', n: value });

function parseConstOrX(word: string): Amount | null {
	const low = word.trim().toLowerCase();
	if (low === 'x') return { k: 'x' };
	if (/^\d+$/.test(low)) return n(parseInt(low, 10));
	const v = NUMBER_WORDS[low];
	return v === undefined ? null : n(v);
}

// ---- Stack Target Qualifiers (CR 115.9c, CR 115.7) ------------------------------------------

export interface Wave7StackTargetQualifierResult {
	phrase: string;
	withSingleTarget?: boolean;
	targetsSelf?: boolean;
	singleTargetFilter?: ObjectFilter;
	singleTargetPlayer?: PlayerFilter;
	targetsFilter?: ObjectFilter;
	targetsPlayerFilter?: PlayerFilter;
}

function parseQualifiedBattlefieldFilter(
	raw: string,
	objectFilterFn: (phrase: string) => ObjectFilter | null
): ObjectFilter | null {
	let phrase = raw.trim();
	let controller: ObjectFilter['controller'];
	if (/\s+you control$/i.test(phrase)) {
		controller = 'you';
		phrase = phrase.replace(/\s+you control$/i, '').trim();
	} else if (/\s+(?:an opponent controls|opponents control|you don't control)$/i.test(phrase)) {
		controller = 'opponent';
		phrase = phrase.replace(/\s+(?:an opponent controls|opponents control|you don't control)$/i, '').trim();
	}
	if (/^(?:permanent|permanents)$/i.test(phrase)) {
		return { zone: 'battlefield', ...(controller ? { controller } : {}) };
	}
	const f = objectFilterFn(phrase);
	if (!f) return null;
	return { ...f, zone: 'battlefield', ...(controller ? { controller } : {}) };
}

export function parseWave7StackTargetQualifiers(
	rawPhrase: string,
	objectFilterFn: (phrase: string) => ObjectFilter | null
): Wave7StackTargetQualifierResult | null {
	const trimmed = rawPhrase.trim();
	const isStackHead = (head: string) => /\b(?:spells?|abilit(?:y|ies))\b/i.test(head);

	const singleM = trimmed.match(/^(.+?)\s+with a single target$/i);
	if (singleM && isStackHead(singleM[1])) {
		return { phrase: singleM[1].trim(), withSingleTarget: true };
	}

	const onlyM = trimmed.match(/^(.+?)\s+that targets only (.+)$/i);
	if (onlyM && isStackHead(onlyM[1])) {
		const head = onlyM[1].trim();
		const rhs = onlyM[2].trim();
		if (rhs === '~') {
			return { phrase: head, withSingleTarget: true, targetsSelf: true };
		}
		if (/^(?:you|yourself)$/i.test(rhs)) {
			return {
				phrase: head,
				withSingleTarget: true,
				singleTargetPlayer: { relation: 'you' }
			};
		}
		if (/^(?:a single )?(?:opponent|an opponent)$/i.test(rhs)) {
			return {
				phrase: head,
				withSingleTarget: true,
				singleTargetPlayer: { relation: 'opponent' }
			};
		}
		if (/^(?:a single )?(?:player|a player)$/i.test(rhs)) {
			return {
				phrase: head,
				withSingleTarget: true,
				singleTargetPlayer: { relation: 'any' }
			};
		}
		const strippedSingle = rhs.replace(/^(?:a single|a|an)\s+/i, '').trim();
		const objF = parseQualifiedBattlefieldFilter(strippedSingle, objectFilterFn);
		if (objF) {
			return {
				phrase: head,
				withSingleTarget: true,
				singleTargetFilter: objF
			};
		}
		return null;
	}

	const targetsM = trimmed.match(/^(.+?)\s+that targets (.+)$/i);
	if (targetsM && isStackHead(targetsM[1])) {
		const head = targetsM[1].trim();
		const rhs = targetsM[2].trim();
		if (rhs === '~') {
			return { phrase: head, targetsSelf: true };
		}
		if (/^you$/i.test(rhs)) {
			return { phrase: head, targetsPlayerFilter: { relation: 'you' } };
		}
		if (/^(?:an opponent|opponents)$/i.test(rhs)) {
			return { phrase: head, targetsPlayerFilter: { relation: 'opponent' } };
		}
		if (/^(?:a player|players)$/i.test(rhs)) {
			return { phrase: head, targetsPlayerFilter: { relation: 'any' } };
		}
		if (/^you or a permanent you control$/i.test(rhs)) {
			// Wait: keep strict if union of player + permanent isn't a single filter; let's check object-only below.
			return null;
		}
		const strippedArt = rhs.replace(/^(?:one or more|a|an)\s+/i, '').trim();
		const objF = parseQualifiedBattlefieldFilter(strippedArt, objectFilterFn);
		if (objF) {
			return { phrase: head, targetsFilter: objF };
		}
		return null;
	}

	return null;
}

// ---- Slice P19a.1: Triggered-Mana & Land-Produced `addMana` ---------------------------------

export interface Wave7AddManaHelpers {
	amountWord: (word: string) => Amount | null;
	equalTo: (text: string) => Amount | null;
	numberOf: (text: string) => Amount | null;
}

export function parseWave7AddMana(
	rawText: string,
	helpers: Wave7AddManaHelpers,
	span: Span
): EffectStep | null {
	const t = rawText.trim().replace(/^an additional\s+/i, '');

	// "one mana of any type/color that (land|permanent|artifact|creature) produced" (CR 605.1b / CR 106.7)
	let m = t.match(
		/^(that much|that many|\S+) mana of any (type|color) that (?:land|permanent|artifact|creature) produced$/i
	);
	if (m) {
		const amount = helpers.amountWord(m[1].toLowerCase()) ?? parseConstOrX(m[1]);
		if (!amount) return null;
		const manaChoice: NonNullable<EffectParams['manaChoice']> =
			m[2].toLowerCase() === 'type' ? 'eventProducedTypes' : 'eventProducedColors';
		return { verb: 'addMana', subject: { k: 'none' }, amount, params: { manaChoice }, span };
	}

	// "one mana of any type/color that a land you control could produce" (*Reflecting Pool*, *Exotic Orchard* self)
	m = t.match(
		/^(that much|that many|\S+) mana of any (type|color) that a land you control could produce$/i
	);
	if (m) {
		const amount = helpers.amountWord(m[1].toLowerCase()) ?? parseConstOrX(m[1]);
		if (!amount) return null;
		const manaChoice: NonNullable<EffectParams['manaChoice']> =
			m[2].toLowerCase() === 'type' ? 'controlledLandProducedTypes' : 'controlledLandProducedColors';
		return { verb: 'addMana', subject: { k: 'none' }, amount, params: { manaChoice }, span };
	}

	// "one/two mana of any type/color that a land an opponent controls could produce" (*Fellwar Stone*, *Exotic Orchard*)
	m = t.match(
		/^(that much|that many|\S+) mana of any (?:type|color) that a land (?:an opponent controls|opponents control) could produce$/i
	);
	if (m) {
		const amount = helpers.amountWord(m[1].toLowerCase()) ?? parseConstOrX(m[1]);
		if (!amount) return null;
		return {
			verb: 'addMana',
			subject: { k: 'none' },
			amount,
			params: { manaChoice: 'opponentLandColors' },
			span
		};
	}

	// "one mana of any [one] color for each <filter>"
	m = t.match(/^(\S+) mana of any (?:one )?color for each (.+)$/i);
	if (m) {
		const baseAmt = parseConstOrX(m[1]);
		const eachRaw = m[2].trim();
		const normEach = eachRaw
			.replace(/\bcounter\b/i, 'counters')
			.replace(/^card in /i, 'cards in ')
			.replace(/\s+on the battlefield$/i, '');
		const perCount = helpers.numberOf(eachRaw) ?? helpers.numberOf(normEach);
		if (!baseAmt || baseAmt.k !== 'const' || baseAmt.n < 1 || !perCount) return null;
		const scaled: Amount = baseAmt.n === 1 ? perCount : { k: 'mul', factor: baseAmt.n, of: perCount };
		return {
			verb: 'addMana',
			subject: { k: 'none' },
			amount: scaled,
			params: { manaChoice: 'any' },
			span
		};
	}

	// "an amount of mana of any [one] color equal to <expr>" / "X mana of any [one] color" (X already handled, equalTo here)
	m = t.match(/^an amount of mana of any (?:one )?color equal to (.+)$/i);
	if (m) {
		const amount = helpers.equalTo(m[1].trim());
		if (!amount) return null;
		return {
			verb: 'addMana',
			subject: { k: 'none' },
			amount,
			params: { manaChoice: 'any' },
			span
		};
	}

	// "an amount of mana in any combination of colors equal to <expr>"
	m = t.match(/^an amount of mana in any combination of colors equal to (.+)$/i);
	if (m) {
		const amount = helpers.equalTo(m[1].trim());
		if (!amount) return null;
		return {
			verb: 'addMana',
			subject: { k: 'none' },
			amount,
			params: { manaCombinationColors: 'any' },
			span
		};
	}

	// "{R}{R} for each <filter>" (same symbol repeated)
	m = t.match(/^((?:\{[WUBRGC]\}){2,4}) for each (.+)$/i);
	if (m) {
		const syms = (m[1].match(/\{([WUBRGC])\}/gi) ?? []).map((x) => x[1].toUpperCase() as ManaColor);
		if (syms.length >= 2 && syms.every((c) => c === syms[0])) {
			const eachRaw = m[2].trim();
			const normEach = eachRaw
				.replace(/\bcounter\b/i, 'counters')
				.replace(/^card in /i, 'cards in ')
				.replace(/\s+on the battlefield$/i, '');
			const perCount = helpers.numberOf(eachRaw) ?? helpers.numberOf(normEach);
			if (perCount) {
				return {
					verb: 'addMana',
					subject: { k: 'none' },
					amount: { k: 'mul', factor: syms.length, of: perCount },
					params: { mana: [syms[0]] },
					span
				};
			}
		}
	}

	return null;
}

// ---- Slice P19a.3: Sacrificed-Cost LKI & Aggregate `Amount`s --------------------------------

export interface Wave7AmountHelpers {
	hasBoundObject: boolean;
	objectFilter: (phrase: string) => ObjectFilter | null;
	parseSubAmount?: (sub: string) => Amount | null;
}

function parseMultiZoneFilterForAggregate(
	rawGroup: string,
	objectFilterFn: (phrase: string) => ObjectFilter | null
): ObjectFilter | null {
	const g = rawGroup.trim();
	const gyM = g.match(/^(.+?) in (your|all|an opponent's|opponents') graveyards?$/i);
	if (gyM) {
		const sub = gyM[1].trim();
		const f = /^cards?$/i.test(sub) ? {} : objectFilterFn(sub);
		if (!f) return null;
		const who = gyM[2].toLowerCase();
		return {
			...f,
			zone: 'graveyard',
			...(who === 'your'
				? { owner: 'you' as const }
				: who === "an opponent's" || who === "opponents'"
					? { owner: 'opponent' as const }
					: {})
		};
	}
	const handM = g.match(/^(.+?) in your hand$/i);
	if (handM) {
		const sub = handM[1].trim();
		const f = /^cards?$/i.test(sub) ? {} : objectFilterFn(sub);
		if (!f) return null;
		return { ...f, zone: 'hand', owner: 'you' };
	}
	const exSelfM = g.match(/^(.+?) exiled with ~$/i);
	if (exSelfM) {
		const sub = exSelfM[1].trim();
		const f = /^cards?$/i.test(sub) ? {} : objectFilterFn(sub);
		if (!f) return null;
		return { ...f, zone: 'exile', exiledWithSelf: true };
	}
	let bfPhrase = g.replace(/\s+on the battlefield$/i, '').trim();
	let controller: ObjectFilter['controller'];
	if (/\s+you control$/i.test(bfPhrase)) {
		controller = 'you';
		bfPhrase = bfPhrase.replace(/\s+you control$/i, '').trim();
	} else if (/\s+(?:an opponent controls|opponents control|you don't control)$/i.test(bfPhrase)) {
		controller = 'opponent';
		bfPhrase = bfPhrase
			.replace(/\s+(?:an opponent controls|opponents control|you don't control)$/i, '')
			.trim();
	}
	const f = /^permanents?$/i.test(bfPhrase) ? {} : objectFilterFn(bfPhrase);
	if (!f) return null;
	return { ...f, zone: 'battlefield', ...(controller ? { controller } : {}) };
}

export function parseWave7Amount(rawText: string, helpers: Wave7AmountHelpers): Amount | null {
	const t = rawText.trim();

	// 1. Sacrificed-cost LKI (`CR 608.2h`, `CR 707.10`) when no earlier effect step bound a sacrificed object:
	if (!helpers.hasBoundObject) {
		const sacPoss = t.match(
			/^the sacrificed (?:creature|permanent|artifact|enchantment|land|planeswalker|battle|token)'s (power|toughness|mana value)$/i
		);
		if (sacPoss) {
			const rawStat = sacPoss[1].toLowerCase();
			const stat = rawStat === 'mana value' ? 'manaValue' : (rawStat as 'power' | 'toughness');
			return { k: 'sacrificedCostStat', stat };
		}
		const sacOf = t.match(
			/^the (power|toughness|mana value) of the sacrificed (?:creature|permanent|artifact|enchantment|land|planeswalker|battle|token)$/i
		);
		if (sacOf) {
			const rawStat = sacOf[1].toLowerCase();
			const stat = rawStat === 'mana value' ? 'manaValue' : (rawStat as 'power' | 'toughness');
			return { k: 'sacrificedCostStat', stat };
		}
		if (
			/^(?:the number of )?colors (?:the sacrificed (?:creature|permanent|artifact|enchantment|token) was|among permanents sacrificed this way)$/i.test(
				t
			)
		) {
			return { k: 'sacrificedCostStat', stat: 'colorsCount' };
		}
	}

	// 2. `leastStatAmong` ("the least power among creatures you control", "the least mana value among ...")
	const leastM = t.match(/^(?:the )?least (power|toughness|mana value) among (.+)$/i);
	if (leastM) {
		const rawStat = leastM[1].toLowerCase();
		const stat = rawStat === 'mana value' ? 'manaValue' : (rawStat as 'power' | 'toughness');
		const filter = parseMultiZoneFilterForAggregate(leastM[2], helpers.objectFilter);
		if (filter) return { k: 'leastStatAmong', filter, stat };
	}

	// 3. Multi-zone `greatestStatAmong` ("the greatest mana value among cards in your graveyard / exiled with ~")
	const greatestM = t.match(/^(?:the )?greatest (power|toughness|mana value) among (.+)$/i);
	if (greatestM) {
		if (/^cards discarded this way$/i.test(greatestM[2].trim()) && greatestM[1].toLowerCase() === 'mana value') {
			return { k: 'countedThisWay', kind: 'greatestDiscarded' };
		}
		const rawStat = greatestM[1].toLowerCase();
		const stat = rawStat === 'mana value' ? 'manaValue' : (rawStat as 'power' | 'toughness');
		const filter = parseMultiZoneFilterForAggregate(greatestM[2], helpers.objectFilter);
		if (filter && filter.zone && filter.zone !== 'battlefield') {
			return { k: 'greatestStatAmong', filter, stat };
		}
	}

	// 4. `countedThisWay`
	if (/^(?:the (?:amount of )?)?damage prevented this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'damagePrevented' };
	}
	if (/^(?:the number of )?(?:cards|creatures|permanents) exiled from (?:your|their|a player's|target player's|target opponent's) hand this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'exiledFromHand' };
	}
	if (/^(?:the number of )?(?:creatures|permanents|lands|artifacts|tokens) tapped this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'tappedThisWay' };
	}
	if (/^(?:the number of )?(?:creatures|permanents|artifacts|lands|enchantments|tokens) destroyed this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'destroyedThisWay' };
	}
	if (/^(?:the number of )?(?:creatures|permanents|artifacts|lands|enchantments|tokens) sacrificed this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'sacrificedThisWay' };
	}
	if (/^(?:the number of )?cards discarded this way$/i.test(t)) {
		return { k: 'countedThisWay', kind: 'discardedThisWay' };
	}

	// 5. `difference` ("<left> minus <right>") & `sum` ("<left> plus <right>")
	if (helpers.parseSubAmount && /\s+minus\s+/i.test(t)) {
		const minusIdx = t.toLowerCase().indexOf(' minus ');
		if (minusIdx > 0) {
			const leftRaw = t.slice(0, minusIdx).trim();
			const rightRaw = t.slice(minusIdx + ' minus '.length).trim();
			const left = parseConstOrX(leftRaw) ?? helpers.parseSubAmount(leftRaw);
			const right = parseConstOrX(rightRaw) ?? helpers.parseSubAmount(rightRaw);
			if (left && right) {
				return { k: 'difference', left, right };
			}
		}
	}
	if (helpers.parseSubAmount && /\s+plus\s+/i.test(t)) {
		const plusIdx = t.toLowerCase().indexOf(' plus ');
		if (plusIdx > 0) {
			const leftRaw = t.slice(0, plusIdx).trim();
			const rightRaw = t.slice(plusIdx + ' plus '.length).trim();
			const left = parseConstOrX(leftRaw) ?? helpers.parseSubAmount(leftRaw);
			const right = parseConstOrX(rightRaw) ?? helpers.parseSubAmount(rightRaw);
			if (left && right) {
				return { k: 'sum', args: [left, right] };
			}
		}
	}

	return null;
}

// ---- Slice P19a.3: Wave 7 Resolution Conditions ---------------------------------------------

export function parseWave7Condition(
	rawCondText: string,
	targetRef?: Ref | null
): Condition | null {
	const t = rawCondText.trim();

	// "if a graveyard has twenty or more cards in it" / "if there are twenty or more cards in a single graveyard"
	const gyAtLeast =
		t.match(/^if (?:a|any|a single) graveyard has (\S+) or more cards in it$/i) ??
		t.match(/^if there are (\S+) or more cards in (?:a|any|a single) graveyard$/i);
	if (gyAtLeast) {
		const c = parseConstOrX(gyAtLeast[1]);
		if (c && c.k === 'const' && c.n >= 1) {
			return { k: 'anyGraveyardAtLeast', min: c.n };
		}
	}

	// "if you controlled that creature/permanent" / "if you control that creature/permanent"
	if (
		targetRef?.k === 'target' &&
		/^if you control(?:led)? (?:that (?:creature|permanent|artifact|enchantment|land|planeswalker)|it)$/i.test(
			t
		)
	) {
		return { k: 'controlledTargetAtResolution', targetIndex: targetRef.index };
	}

	// "if this is the second/third/fourth time this ability has resolved this turn"
	const actCount = t.match(
		/^if this is the (second|third|fourth|fifth|2nd|3rd|4th|5th) time this ability has resolved this turn$/i
	);
	if (actCount) {
		const min = ORDINAL_WORDS[actCount[1].toLowerCase()];
		if (min) return { k: 'abilityActivatedCountThisTurn', min };
	}

	return null;
}

// ---- Slice P19a.4: Named & Dynamic (`X/X`, `tapped and attacking`, `legendary`) Tokens ------

function isSupportedTokenKeyword(k: string): boolean {
	return (
		GRANTABLE_KEYWORDS.includes(k) ||
		k === 'changeling' ||
		/^toxic \d+$/.test(k) ||
		/^protection from (?:[a-z]+|everything)$/.test(k) ||
		/^ward (?:\{[^}]+\})+$/.test(k)
	);
}

function parseTokenWithClause(
	rawWith: string,
	isSupportedQuoted: (q: string) => boolean
): { keywords: string[]; plainWithClause: string; quotedAbilities?: string[] } | null {
	let withClause = rawWith.trim();
	if (!withClause) return { keywords: [], plainWithClause: '' };

	const quotedAbilities: string[] = [];
	const twoQuotes = withClause.match(
		/^(?:([a-z0-9{},\- ]+?)(?:,? and )?)?[“"]([^”"]+)[”"](?:,? and )?[“"]([^”"]+)[”"]$/
	);
	if (twoQuotes) {
		const q1 = twoQuotes[2].trim();
		const q2 = twoQuotes[3].trim();
		if (!isSupportedQuoted(q1) || !isSupportedQuoted(q2)) return null;
		quotedAbilities.push(q1, q2);
		withClause = (twoQuotes[1] ?? '').trim();
	} else {
		const oneQuote = withClause.match(/^(?:([a-z0-9{},\- ]+?)(?:,? and )?)?[“"]([^”"]+)[”"]$/);
		if (oneQuote) {
			const q1 = oneQuote[2].trim();
			if (!isSupportedQuoted(q1)) return null;
			quotedAbilities.push(q1);
			withClause = (oneQuote[1] ?? '').trim();
		} else if (/[“"]/.test(withClause)) {
			return null;
		}
	}

	const rawParts = withClause
		? withClause
				.split(/,? and |, /)
				.map((k) => k.trim().toLowerCase())
				.filter(Boolean)
		: [];
	if (rawParts.some((k) => !isSupportedTokenKeyword(k))) {
		return null;
	}
	const plainParts = rawParts.filter((k) => GRANTABLE_KEYWORDS.includes(k));
	const keywords = rawParts.map((k) =>
		(k.charAt(0).toUpperCase() + k.slice(1)).replace(/\{([^}]+)\}/g, (_, sym: string) => `{${sym.toUpperCase()}}`)
	);
	return {
		keywords,
		plainWithClause: plainParts.join(', '),
		...(quotedAbilities.length > 0 ? { quotedAbilities } : {})
	};
}

export interface Wave7TokenParseResult {
	amount: Amount;
	token: TokenSpec;
	dynamicTokenPT?: { power: Amount; toughness: Amount };
	tappedAndAttacking?: boolean;
}

export function parseWave7TokenPhrase(
	rawText: string,
	helpers: {
		amountWord: (word: string) => Amount | null;
		equalTo: (text: string) => Amount | null;
		isSupportedTokenQuotedAbility: (q: string) => boolean;
	}
): Wave7TokenParseResult | null {
	let t = rawText.trim();

	// "a number of <tokens> equal to <expr>"
	const numEqual = t.match(/^(?:a|the) number of (.+?\btokens?(?: tapped)?) equal to (.+)$/i);
	if (numEqual) {
		const amount = helpers.equalTo(numEqual[2].trim());
		if (!amount) return null;
		const sub = parseWave7TokenPhrase(`two ${numEqual[1].trim()}`, helpers);
		if (!sub) return null;
		return { ...sub, amount };
	}

	// Trailing ", that's tapped and attacking" / "that are tapped and attacking" / "tapped and attacking"
	let trailingTapped = false;
	let trailingTappedAndAttacking = false;
	const taTrail = t.match(/^(.+?)(?:,?\s+that(?:'s| are))?\s+tapped and attacking$/i);
	if (taTrail && /\btokens?\b/i.test(taTrail[1])) {
		trailingTapped = true;
		trailingTappedAndAttacking = true;
		t = taTrail[1].trim();
	} else {
		const tTrail = t.match(/^(.+?)\s+tapped$/i);
		if (tTrail && /\btokens?\b/i.test(tTrail[1])) {
			trailingTapped = true;
			t = tTrail[1].trim();
		}
	}

	// Predefined tokens with `tapped and attacking` ("a tapped and attacking Treasure/Soldier? No, predefined like Junk/Map/Food/Clue/Treasure/Shard/Blood/Powerstone/Lander or tapped")
	const preTA = t.match(/^(that many|\S+) tapped and attacking ([a-z]+(?: [a-z]+)?) tokens?$/i);
	if (preTA) {
		const def = PREDEFINED_TOKEN_DEFS[preTA[2].toLowerCase() as keyof typeof PREDEFINED_TOKEN_DEFS];
		const amount = def ? helpers.amountWord(preTA[1].toLowerCase()) : null;
		if (def && amount) {
			return {
				amount,
				token: {
					name: def.name,
					power: def.power,
					toughness: def.toughness,
					colors: [...def.colors],
					typeLine: def.typeLine,
					keywords: [...def.keywords],
					tapped: true
				},
				tappedAndAttacking: true
			};
		}
	}

	// General creature token:
	// "<count> [tapped and attacking | tapped] [legendary] (<N|X|*>/<M|X|*>) <colors> <Subtypes> [artifact | enchantment] creature token(s) [named <Name>] [with <keywords and/or "quoted">]"
	const cm = t.match(
		/^(that many|\S+)\s+(?:(tapped and attacking|tapped)\s+)?(?:(legendary)\s+)?(\d+|X|\*)\/(\d+|X|\*)\s+((?:(?:white|blue|black|red|green|colorless|all colors)(?:,? and |, | ))*)([A-Z][A-Za-z' -]*?)\s+(?:(artifact|enchantment)\s+)?creature tokens?(?:\s+named ([A-Z][A-Za-z0-9', -]+?))?(?:\s+with (.+))?$/
	);
	if (!cm) {
		// Noncreature artifact / enchantment token:
		// "<count> [tapped] [legendary] <colors> [<Subtype>] (artifact|enchantment) token(s) [named <Name>] [with <keywords and/or "quoted">]"
		const ncm = t.match(
			/^(that many|\S+)\s+(?:(tapped)\s+)?(?:(legendary)\s+)?((?:(?:white|blue|black|red|green|colorless|all colors)(?:,? and |, | ))*)(?:([A-Z][A-Za-z' -]*?)\s+)?(artifact|enchantment) tokens?(?:\s+named ([A-Z][A-Za-z0-9', -]+?))?(?:\s+with (.+))?$/
		);
		if (!ncm || trailingTappedAndAttacking) return null;
		const amount = helpers.amountWord(ncm[1].toLowerCase());
		if (!amount) return null;
		const tapped = trailingTapped || Boolean(ncm[2]);
		const isLegendary = Boolean(ncm[3]);
		const colorStr = (ncm[4] ?? '').trim();
		const subtype = ncm[5]?.trim();
		const capCardType = ncm[6].toLowerCase() === 'artifact' ? 'Artifact' : 'Enchantment';
		const explicitName = ncm[7]?.trim();
		const parsedWith = parseTokenWithClause(ncm[8] ?? '', helpers.isSupportedTokenQuotedAbility);
		if (!parsedWith) return null;

		const allColors = /\ball colors\b/i.test(colorStr);
		const colors: ManaColor[] = allColors
			? ['W', 'U', 'B', 'R', 'G']
			: Array.from(
					new Set(
						(colorStr.toLowerCase().match(/\b(white|blue|black|red|green)\b/g) ?? []).map(
							(w) => COLOR_WORDS[w]
						)
					)
				);
		const typeLine = `Token ${isLegendary ? 'Legendary ' : ''}${capCardType}${subtype ? ` — ${subtype}` : ''}`;
		const name = explicitName || subtype || capCardType;
		return {
			amount,
			token: {
				name,
				colors,
				typeLine,
				keywords: parsedWith.keywords,
				...(parsedWith.quotedAbilities ? { quotedAbilities: parsedWith.quotedAbilities } : {}),
				...(tapped ? { tapped: true } : {})
			}
		};
	}

	const amount = helpers.amountWord(cm[1].toLowerCase());
	if (!amount) return null;

	const leadTapKind = cm[2]?.toLowerCase();
	const tapped =
		trailingTapped || leadTapKind === 'tapped' || leadTapKind === 'tapped and attacking';
	const tappedAndAttacking =
		trailingTappedAndAttacking || leadTapKind === 'tapped and attacking';
	const isLegendary = Boolean(cm[3]);

	const rawP = cm[4].toUpperCase();
	const rawT = cm[5].toUpperCase();
	if (rawP === '*' || rawT === '*') return null; // characteristic-defining * / * requires CDA clause

	const fixedP = /^\d+$/.test(rawP) ? parseInt(rawP, 10) : 0;
	const fixedT = /^\d+$/.test(rawT) ? parseInt(rawT, 10) : 0;
	const hasDynamicPT = rawP === 'X' || rawT === 'X';
	const dynamicTokenPT = hasDynamicPT
		? {
				power: rawP === 'X' ? ({ k: 'x' } as Amount) : n(fixedP),
				toughness: rawT === 'X' ? ({ k: 'x' } as Amount) : n(fixedT)
			}
		: undefined;

	const colorStr = (cm[6] ?? '').trim();
	const subtypeStr = cm[7].trim();
	const extraCardType = cm[8]?.toLowerCase();
	const explicitName = cm[9]?.trim();
	const parsedWith = parseTokenWithClause(cm[10] ?? '', helpers.isSupportedTokenQuotedAbility);
	if (!parsedWith) return null;

	const allColors = /\ball colors\b/i.test(colorStr);
	const cleanColorStr = allColors ? 'white blue black red green ' : colorStr ? `${colorStr} ` : '';
	const baseSpec = buildTokenSpec(
		fixedP,
		fixedT,
		`${cleanColorStr}${subtypeStr}${extraCardType === 'artifact' ? ' artifact' : ''}`.trim(),
		parsedWith.plainWithClause
	);
	let typeLine = baseSpec.typeLine;
	if (extraCardType === 'enchantment' && !typeLine.includes('Enchantment')) {
		typeLine = typeLine.replace(/^Token /, 'Token Enchantment ');
	}
	if (isLegendary && !typeLine.includes('Legendary')) {
		typeLine = typeLine.replace(/^Token /, 'Token Legendary ');
	}

	const tokenKeywords = [...baseSpec.keywords];
	for (const cap of parsedWith.keywords) {
		if (!tokenKeywords.some((existing) => existing.toLowerCase() === cap.toLowerCase())) {
			tokenKeywords.push(cap);
		}
	}

	return {
		amount,
		token: {
			...baseSpec,
			name: explicitName || baseSpec.name,
			colors: allColors ? ['W', 'U', 'B', 'R', 'G'] : [...baseSpec.colors],
			typeLine,
			keywords: tokenKeywords,
			...(parsedWith.quotedAbilities ? { quotedAbilities: parsedWith.quotedAbilities } : {}),
			...(tapped ? { tapped: true } : {})
		},
		...(dynamicTokenPT ? { dynamicTokenPT } : {}),
		...(tappedAndAttacking ? { tappedAndAttacking: true } : {})
	};
}

// ---- Slice P19a.2: Object Predicate Extensions ----------------------------------------------

export function tryParseWave7ObjectPredicate(
	subjectSelector: Selector,
	validBattlefieldObjectSubject: boolean,
	predText: string,
	eot: boolean,
	duration: Duration | undefined,
	span: Span,
	helpers: {
		equalTo: (text: string) => Amount | null;
	}
): EffectStep[] | null {
	if (!validBattlefieldObjectSubject) return null;
	const t = predText.trim();
	const dur: Duration = duration ?? 'endOfTurn';

	// 1. Choice-based pump: "gets +2/+0 or +0/+2 [until end of turn]" / "gets +1/+0 or -1/-0"
	if (eot) {
		const pumpOr = t.match(
			/^gets? ([+-−]\d+)\/([+-−]\d+) or ([+-−]\d+)\/([+-−]\d+)(?: of your choice)?$/i
		);
		if (pumpOr) {
			const parseSigned = (s: string) => parseInt(s.replace('−', '-'), 10);
			return [
				{
					verb: 'pump',
					subject: subjectSelector,
					params: {
						pumpChoices: [
							{ power: parseSigned(pumpOr[1]), toughness: parseSigned(pumpOr[2]) },
							{ power: parseSigned(pumpOr[3]), toughness: parseSigned(pumpOr[4]) }
						],
						duration: dur
					},
					span
				}
			];
		}

		// 2. Choice-based lose keyword: "loses flying or first strike [until end of turn]" / "loses your choice of flying, first strike, or trample"
		const loseOr = t.match(/^loses? (?:your choice of )?([a-z ,]+?,? or [a-z ]+?)(?: of your choice)?$/i);
		if (loseOr) {
			const opts = loseOr[1]
				.split(/,? or |, /)
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			if (
				opts.length >= 2 &&
				new Set(opts).size === opts.length &&
				opts.every((k) => GRANTABLE_KEYWORDS.includes(k))
			) {
				const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
				return [
					{
						verb: 'grant',
						subject: subjectSelector,
						params: {
							chooseLoseKeywordOptions: opts.map(cap),
							duration: dur
						},
						span
					}
				];
			}
		}
	}

	// 3. Choice-based color animation: "becomes the color [or colors] of your choice [until end of turn]"
	const colorChoice = t.match(/^becomes? the (color|color or colors) of your choice$/i);
	if (colorChoice) {
		return [
			{
				verb: 'animate',
				subject: subjectSelector,
				params: {
					keepExistingTypes: true,
					chooseColorForAnimate:
						colorChoice[1].toLowerCase() === 'color or colors' ? 'oneOrMore' : 'single',
					duration: eot ? dur : 'permanent'
				},
				span
			}
		];
	}

	// 4. Dynamic base P/T setting: "has base power and toughness each equal to <expr> [until end of turn]"
	if (eot) {
		const baseEq = t.match(/^(?:has|have|with) base power and toughness each equal to (.+)$/i);
		if (baseEq) {
			const amt = helpers.equalTo(baseEq[1].trim());
			if (amt) {
				return [
					{
						verb: 'animate',
						subject: subjectSelector,
						params: {
							keepExistingTypes: true,
							setPower: amt,
							setToughness: amt,
							duration: dur
						},
						span
					}
				];
			}
		}
	}

	return null;
}

// ---- Slice P19a.4: Sentence & Imperative Clause Parsers -------------------------------------

export interface Wave7SentenceHelpers {
	context: 'spell' | 'activated' | 'triggered';
	addTarget: (spec: TargetSpec) => number;
	getTarget: (index: number) => TargetSpec | undefined;
	itRef: () => Ref | undefined;
	subjectSelector: (phrase: string) => { sel: Selector; fromZone?: string; bind: boolean } | null;
	playerSubject: (phrase: string) => Selector | null;
	singlePlayer: (sel: Selector) => PlayerRef | null;
	objectFilter: (phrase: string) => ObjectFilter | null;
	parseAmount: (amtText: string) => Amount | null;
	numberOf: (text: string) => Amount | null;
}

function parseSpellTypeQualifiers(raw: string): {
	types?: string[];
	notTypes?: string[];
	colors?: ManaColor[];
} | null {
	const s = raw.trim().toLowerCase();
	if (!s) return {};
	if (s === 'instant or sorcery') return { types: ['Instant', 'Sorcery'] };
	if (s === 'instant') return { types: ['Instant'] };
	if (s === 'sorcery') return { types: ['Sorcery'] };
	if (s === 'creature') return { types: ['Creature'] };
	if (s === 'noncreature') return { notTypes: ['Creature'] };
	if (COLOR_WORDS[s]) return { colors: [COLOR_WORDS[s]] };
	const colAndType = s.match(/^(white|blue|black|red|green) (instant or sorcery|instant|sorcery|creature)$/);
	if (colAndType) {
		const sub = parseSpellTypeQualifiers(colAndType[2]);
		if (sub) return { ...sub, colors: [COLOR_WORDS[colAndType[1]]] };
	}
	return null;
}

export function tryParseWave7Sentence(
	rawText: string,
	helpers: Wave7SentenceHelpers,
	span: Span
): EffectStep[] | null {
	const t = rawText.trim();

	// 1. CR 115.7a Mandatory Single-Target Stack Redirection ("Change the target of target spell or ability [with a single target] [to ~]")
	const changeSingleM = t.match(/^change (?:the|a) target of (.+?)(?:\s+to (~))?$/i);
	if (changeSingleM) {
		const rawStackObj = changeSingleM[1].trim();
		const forceTargetSelf = Boolean(changeSingleM[2]);
		let stackSel: Selector | null = null;
		if (
			helpers.context === 'triggered' &&
			/^(?:that spell|that ability|that spell or ability|it)$/i.test(rawStackObj)
		) {
			stackSel = { k: 'eventObject' };
		} else {
			const parsed = helpers.subjectSelector(rawStackObj);
			if (parsed && parsed.sel.k === 'target') {
				const tSpec = helpers.getTarget(parsed.sel.index);
				if (tSpec && tSpec.filter.zone === 'stack') {
					tSpec.withSingleTarget = true;
					tSpec.filter.withSingleTarget = true;
					stackSel = parsed.sel;
				}
			}
		}
		if (stackSel) {
			return [
				{
					verb: 'redirectTargets',
					subject: stackSel,
					params: {
						redirectSpec: {
							mode: 'changeSingleTarget',
							...(forceTargetSelf ? { forceTargetSelf: true } : {})
						}
					},
					span
				}
			];
		}
		return null;
	}

	// 2. CR 115.7d–e Optional / Multi-Target Stack Redirection ("You may choose new targets for target spell [or ability]" / "Choose new targets for target ...")
	const chooseNewTargetsM = t.match(/^(?:you may )?choose new targets for (.+)$/i);
	if (
		chooseNewTargetsM &&
		!/^(?:the|that|those|each|any|any of the) cop(?:y|ies)$/i.test(chooseNewTargetsM[1].trim())
	) {
		const rawStackObj = chooseNewTargetsM[1].trim();
		let stackSel: Selector | null = null;
		if (
			helpers.context === 'triggered' &&
			/^(?:that spell|that ability|that spell or ability|it)$/i.test(rawStackObj)
		) {
			stackSel = { k: 'eventObject' };
		} else if (/^(?:any number of )?target spells? and\/or abilit(?:y|ies)$/i.test(rawStackObj)) {
			const isAnyNum = /^any number of/i.test(rawStackObj);
			const idx = helpers.addTarget({
				kind: 'object',
				filter: { zone: 'stack', stackKind: 'spellOrAbility' },
				min: isAnyNum ? 0 : 1,
				max: isAnyNum ? 99 : 1
			});
			stackSel = { k: 'target', index: idx };
		} else {
			const parsed = helpers.subjectSelector(rawStackObj);
			if (
				parsed &&
				parsed.sel.k === 'target' &&
				helpers.getTarget(parsed.sel.index)?.filter.zone === 'stack'
			) {
				stackSel = parsed.sel;
			} else if (parsed && parsed.sel.k === 'binding') {
				stackSel = parsed.sel;
			}
		}
		if (stackSel) {
			return [
				{
					verb: 'redirectTargets',
					subject: stackSel,
					params: {
						redirectSpec: {
							mode: 'chooseNewTargets'
						}
					},
					span
				}
			];
		}
	}

	// 3. Delayed Until-End-Of-Turn Tap-For-Mana Trigger (*High Tide*, *Bubbling Muck*, *Gauntlet*-style spell)
	const highTideM = t.match(
		/^until end of turn, whenever (a player|you) taps? (?:a|an) (land|Plains|Island|Swamp|Mountain|Forest) for mana, (that player|you) adds? (?:an additional )?((?:\{[WUBRGC]\})+)$/i
	);
	if (highTideM) {
		const who: 'any' | 'you' = highTideM[1].toLowerCase() === 'you' ? 'you' : 'any';
		const rawLand = highTideM[2];
		const landSubtype =
			/^land$/i.test(rawLand)
				? undefined
				: rawLand.charAt(0).toUpperCase() + rawLand.slice(1).toLowerCase();
		const recipient: 'tappingPlayer' | 'controller' =
			highTideM[3].toLowerCase() === 'you' ? 'controller' : 'tappingPlayer';
		const mana = (highTideM[4].match(/\{([WUBRGC])\}/gi) ?? []).map(
			(s) => s[1].toUpperCase() as ManaColor
		);
		if (mana.length > 0) {
			return [
				{
					verb: 'delayedTapManaTrigger',
					subject: { k: 'none' },
					params: {
						delayedTapManaSpec: {
							who,
							...(landSubtype ? { landSubtype } : {}),
							mana,
							recipient
						}
					},
					span
				}
			];
		}
	}

	// 4. Delayed Next-Spell Copy (*Teach by Example*, *Doublecast*, *Galvanic Iteration*, *Howl of the Horde*)
	const nextCopyM =
		t.match(
			/^when you (?:next )?cast (?:your next |an? )(?:(.+?) )?spell this turn, copy (?:that spell|it)(?: (twice|(?:one|two|three|\d+) times))?(?:[.,]?\s*(?:and )?you may choose new targets for the cop(?:y|ies))?$/i
		) ??
		t.match(
			/^copy the next (?:(.+?) )?spell you cast this turn(?: when you cast it)?(?: (twice|(?:one|two|three|\d+) times))?(?:[.,]?\s*(?:and )?you may choose new targets for the cop(?:y|ies))?$/i
		);
	if (nextCopyM) {
		const qual = parseSpellTypeQualifiers(nextCopyM[1] ?? '');
		if (qual) {
			let copyCount = 1;
			if (nextCopyM[2]) {
				if (/^twice$/i.test(nextCopyM[2])) copyCount = 2;
				else {
					const cw = nextCopyM[2].replace(/\s+times$/i, '').trim();
					const ca = parseConstOrX(cw);
					if (!ca || ca.k !== 'const' || ca.n < 1) return null;
					copyCount = ca.n;
				}
			}
			const mayChooseNewTargets = /choose new targets for the cop/i.test(t);
			return [
				{
					verb: 'delayedNextSpellCopy',
					subject: { k: 'none' },
					params: {
						delayedNextSpellCopySpec: {
							...qual,
							copyCount,
							mayChooseNewTargets
						}
					},
					span
				}
			];
		}
	}

	// 5. CR 614.10 Skip Next Turn ("You skip your next turn", "Skip your next turn", "Target player skips their next turn")
	const skipM = t.match(
		/^(?:(you|target player|target opponent|that player|they|each opponent|each player)\s+)?skips? (?:your|their) next (?:(two|three|four|\d+) )?turns?$/i
	);
	if (skipM) {
		const whoStr = (skipM[1] ?? 'you').toLowerCase();
		const pSel = helpers.playerSubject(whoStr);
		if (pSel) {
			const amt = skipM[2] ? parseConstOrX(skipM[2]) : n(1);
			if (amt) {
				return [{ verb: 'skipTurn', subject: pSel, amount: amt, span }];
			}
		}
	}

	// 6. CR 119.5 Set Life Total ("Your life total becomes 20", "Target player's life total becomes 10", "Each player's life total becomes ...")
	const setLifeM = t.match(
		/^(your|target player's|target opponent's|that player's|their|each player's|each opponent's) life total becomes (.+)$/i
	);
	if (setLifeM) {
		const rawWho = setLifeM[1].toLowerCase();
		const whoNom =
			rawWho === 'your'
				? 'you'
				: rawWho === 'their'
					? 'they'
					: rawWho.replace(/'s$/i, '');
		const pSel = helpers.playerSubject(whoNom);
		const amt = parseConstOrX(setLifeM[2].trim()) ?? helpers.parseAmount(setLifeM[2].trim());
		if (pSel && amt) {
			return [
				{
					verb: 'gainLife',
					subject: pSel,
					amount: amt,
					params: { setLifeTotal: true },
					span
				}
			];
		}
	}

	// 7. Triggered & Dynamic `counterSpell` ("Counter that spell [unless its controller pays {2}]", "Counter target spell unless its controller pays {X} / {1} for each ...")
	const counterUnlessM = t.match(
		/^counter (.+?)(?:\s+unless its controller pays \{(\d+|X)\}(?: for each (.+))?)?$/i
	);
	if (counterUnlessM) {
		const rawSubj = counterUnlessM[1].trim();
		const paySym = counterUnlessM[2];
		const perEach = counterUnlessM[3]?.trim();

		let stackSel: Selector | null = null;
		if (
			helpers.context === 'triggered' &&
			/^(?:that spell|that ability|that activated ability|that triggered ability|that spell or ability|it)$/i.test(
				rawSubj
			)
		) {
			stackSel = { k: 'eventObject' };
		} else if (paySym && (paySym.toUpperCase() === 'X' || perEach)) {
			// Dynamic `unlessPaysGenericAmount` on targeted or triggered stack items!
			const parsed = helpers.subjectSelector(rawSubj);
			if (
				parsed &&
				parsed.sel.k === 'target' &&
				helpers.getTarget(parsed.sel.index)?.filter.zone === 'stack'
			) {
				stackSel = parsed.sel;
			}
		}

		if (stackSel) {
			if (!paySym) {
				return [{ verb: 'counterSpell', subject: stackSel, bindAs: 'obj', span }];
			}
			let genericAmt: Amount | null = parseConstOrX(paySym);
			if (genericAmt && perEach) {
				const normEach = perEach
					.replace(/\bcounter\b/i, 'counters')
					.replace(/^card in /i, 'cards in ')
					.replace(/\s+on the battlefield$/i, '');
				const countPer = helpers.numberOf(perEach) ?? helpers.numberOf(normEach);
				if (!countPer || genericAmt.k !== 'const') return null;
				genericAmt =
					genericAmt.n === 1 ? countPer : { k: 'mul', factor: genericAmt.n, of: countPer };
			}
			if (genericAmt) {
				return [
					{
						verb: 'counterSpell',
						subject: stackSel,
						params: { unlessPaysGenericAmount: genericAmt },
						bindAs: 'obj',
						span
					}
				];
			}
		}
	}

	// 8. CR 609.4b Top-Of-Library Any-Color Mana Spending
	if (
		/^until end of turn, you may spend mana as though it were mana of any (?:color|type) to cast spells from the top of your library$/i.test(
			t
		)
	) {
		return [
			{
				verb: 'grantPlayer',
				subject: { k: 'player', filter: { relation: 'you' } },
				params: {
					spendManaAsAnyColorTopOfLibraryThisTurn: true,
					duration: 'endOfTurn'
				},
				span
			}
		];
	}

	// 9. Extended Single-Sentence Coercive / Hand Reveal
	const revChosenName = t.match(
		/^(.+?) reveals? their hand and discards? all cards (?:with that name|with the chosen name)$/i
	);
	if (revChosenName) {
		const pSel = helpers.playerSubject(revChosenName[1].trim());
		if (pSel) {
			return [
				{
					verb: 'revealAndDiscard',
					subject: pSel,
					params: { discardAllWithChosenName: true },
					bindAs: 'obj',
					span
				}
			];
		}
	}

	const revSacColors = t.match(
		/^(.+?) reveals? their hand and discards? all cards of each of the sacrificed (?:creature|permanent)'s colors$/i
	);
	if (revSacColors) {
		const pSel = helpers.playerSubject(revSacColors[1].trim());
		if (pSel) {
			return [
				{
					verb: 'revealAndDiscard',
					subject: pSel,
					params: { discardAllMatchingSacrificedColors: true },
					bindAs: 'obj',
					span
				}
			];
		}
	}

	const revRandom = t.match(/^(.+?) reveals? a card at random from their hand$/i);
	if (revRandom) {
		const pSel = helpers.playerSubject(revRandom[1].trim());
		if (pSel) {
			return [
				{
					verb: 'revealAndDiscard',
					subject: pSel,
					params: { partialRevealCount: 'randomOne' },
					bindAs: 'obj',
					span
				}
			];
		}
	}

	return null;
}

// ---- Slice P19a.2 & P19a.4: Multi-Sentence Stitchers (`exileUntil`, excess damage, coercive) -

export function convertDigStepToExileUntil(
	untilFilter: ObjectFilter | undefined,
	followUpText: string
): ExileUntilSpec | null {
	if (!untilFilter) return null;
	const t = followUpText.trim();

	// Cascade / free-cast follow-up:
	// "You may cast it without paying its mana cost. Put the exiled cards not cast this way on the bottom of your library in a random order."
	if (
		/^you may cast (?:it|that card)(?: this turn)? without paying its mana cost(?:[.,]?\s*(?:then )?put (?:the exiled cards(?: not cast this way)?|the rest|all other cards exiled this way) on the bottom of your library in a random order)?$/i.test(
			t
		)
	) {
		const hasBottomRest = /on the bottom of your library/i.test(t);
		return {
			filter: untilFilter,
			hitAction: 'castFree',
			restDestination: hasBottomRest ? 'libraryBottomRandom' : 'exile'
		};
	}

	const condFreeM = t.match(
		/^you may cast (?:it|that card)(?: this turn)? without paying its mana cost if (?:it|that spell|that card) has mana value (\S+) or less$/i
	);
	if (condFreeM) {
		const mv = parseConstOrX(condFreeM[1]);
		if (mv) {
			return {
				filter: untilFilter,
				hitAction: 'castFree',
				castFreeCondition: {
					k: 'compare',
					left: { k: 'stat', of: { k: 'self' }, stat: 'manaValue' },
					op: '<=',
					right: mv
				},
				restDestination: 'exile'
			};
		}
	}

	// Impulse exile-until: "You may play that card this turn" / "Until end of turn, you may cast that card..."
	if (
		/^(?:you may (play|cast) (?:it|that card) this turn|until (?:the )?end of turn, you may (play|cast) (?:it|that card))(?:,?\s*and you may spend mana as though it were mana of any (?:color|type) to cast (?:it|that spell))?$/i.test(
			t
		)
	) {
		const spellsOnly = /\bmay cast\b/i.test(t);
		const spendAny = /spend mana as though/i.test(t);
		return {
			filter: untilFilter,
			hitAction: 'playThisTurn',
			...(spellsOnly ? { spellsOnly: true } : {}),
			...(spendAny ? { spendManaAsAnyColor: true } : {}),
			restDestination: 'exile'
		};
	}
	if (
		/^until (?:the )?end of your next turn, you may (play|cast) (?:it|that card)(?:,?\s*and you may spend mana as though it were mana of any (?:color|type) to cast (?:it|that spell))?$/i.test(
			t
		)
	) {
		const spellsOnly = /\bmay cast\b/i.test(t);
		const spendAny = /spend mana as though/i.test(t);
		return {
			filter: untilFilter,
			hitAction: 'playUntilEndOfNextTurn',
			...(spellsOnly ? { spellsOnly: true } : {}),
			...(spendAny ? { spendManaAsAnyColor: true } : {}),
			restDestination: 'exile'
		};
	}
	if (/^put (?:it|that card) onto the battlefield or into your hand$/i.test(t)) {
		return {
			filter: untilFilter,
			hitAction: 'battlefieldOrHand',
			restDestination: 'exile'
		};
	}

	return null;
}

export function tryStitchExileUntilFollowUp(prevStep: EffectStep, followUpText: string): boolean {
	if (prevStep.verb !== 'exileUntil' || !prevStep.params?.exileUntilSpec) return false;
	const spec = prevStep.params.exileUntilSpec;
	const t = followUpText.trim();

	if (
		/^(?:then )?put (?:the exiled cards(?: not cast this way)?|the rest|the other exiled cards|all other cards exiled this way|each other card exiled this way) on the bottom of (?:your|their) library in a random order$/i.test(
			t
		)
	) {
		prevStep.params = {
			...prevStep.params,
			exileUntilSpec: { ...spec, restDestination: 'libraryBottomRandom' }
		};
		return true;
	}
	if (
		/^(?:then )?put (?:the rest|all other cards exiled this way|each other card exiled this way) into (?:your|their) graveyard$/i.test(
			t
		)
	) {
		prevStep.params = {
			...prevStep.params,
			exileUntilSpec: { ...spec, restDestination: 'graveyard' }
		};
		return true;
	}
	if (
		/^if you don't(?: cast it)?, put (?:that card|it) into your hand$/i.test(t) &&
		spec.hitAction === 'castFree'
	) {
		prevStep.params = {
			...prevStep.params,
			exileUntilSpec: { ...spec, fallbackToHand: true }
		};
		return true;
	}
	if (
		/^(?:if you cast a spell this way, )?you may spend mana as though it were mana of any (?:color|type) to cast (?:it|that spell|spells this way)$/i.test(
			t
		)
	) {
		prevStep.params = {
			...prevStep.params,
			exileUntilSpec: { ...spec, spendManaAsAnyColor: true }
		};
		return true;
	}

	return false;
}
