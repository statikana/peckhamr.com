/**
 * Wave 8 Track P22d compiler helpers:
 * - Source-chosen damage prevention & prevented-damage riders (CR 615.4)
 * - Extended `dig` keep/rest clauses (`castFree`, `exile`, `untilFilter` -> `exileUntil`, dynamic MV caps)
 * - Non-P/T "in addition to its other types" animate predicates & follow-ups (CR 205.1b)
 * - Graveyard-to-battlefield Aura/Equipment re-attachment, destroyed-this-way riders, suspend grant, and impulse follow-ups
 *
 * Pure structured IR compilation: zero card-name branches or runtime state mutations.
 */
import type {
	Amount,
	Condition,
	DamagePreventionSpec,
	Duration,
	EffectParams,
	EffectStep,
	ObjectFilter,
	PlayerFilter,
	PlayerRef,
	Ref,
	Selector,
	Span
} from '../ir.ts';
import type { CounterType, ManaColor, ZoneType } from '../types.ts';

function asSelector(ref: Ref): Selector {
	if (ref.k === 'affected') return { k: 'self' };
	// --- Precon Bragos Spirit ---
	if (ref.k === 'linkedExile') return { k: 'all', filter: { zone: 'exile', exiledWithSelf: true } };
	// --- End Precon Bragos Spirit ---
	return ref;
}

export interface Wave8LastObject {
	ref: Ref;
	stepIndex: number;
}

export interface Wave8ParserLike {
	readonly steps: EffectStep[];
	lastObject?: Wave8LastObject;
	lastPlayer?: Selector;
	lastOptionalStep?: number;
	lastSentenceStepStart?: number;
	targets: Array<{ kind: string; filter: ObjectFilter }>;
	push(step: EffectStep, setsLastObject?: boolean): number;
	setLastObject(stepIndex: number): void;
	itRef?(): Ref | null;
	mark(): unknown;
	rollback(m: unknown): void;
}

export interface Wave8CompilerHelpers {
	objectFilter(phrase: string): ObjectFilter | null;
	objectPhrase(
		p: Wave8ParserLike,
		phrase: string
	): { selector: Selector; fromZone?: ZoneType; ref?: Ref; plural?: boolean } | null;
	playerPhrase(p: Wave8ParserLike, phrase: string): Selector | null;
	singlePlayer(sel: Selector): PlayerRef | null;
	amountWord(p: Wave8ParserLike, raw: string): Amount | null;
	equalTo(p: Wave8ParserLike, raw: string): Amount | null;
	damageRecipientSpec(
		p: Wave8ParserLike,
		phrase: string,
		src: Selector
	): { subject: Selector; alsoDamagePlayers?: PlayerFilter } | null;
	keywordList(raw: string): string[] | null;
	singularSubtype(raw: string): string | null;
	colorWord(word: string): ManaColor | null;
	clauses(p: Wave8ParserLike, text: string, offset: number): boolean;
	sentence(p: Wave8ParserLike, text: string, span: Span, allowConditioned?: boolean): boolean;
	counterName(raw: string): CounterType | null;
	parseDurationTail(raw: string): Duration | undefined;
}

const CARD_TYPE_WORDS: Readonly<Record<string, string>> = {
	artifact: 'Artifact',
	artifacts: 'Artifact',
	creature: 'Creature',
	creatures: 'Creature',
	enchantment: 'Enchantment',
	enchantments: 'Enchantment',
	land: 'Land',
	lands: 'Land',
	planeswalker: 'Planeswalker',
	planeswalkers: 'Planeswalker',
	battle: 'Battle',
	battles: 'Battle'
};

const n = (v: number): Amount => ({ k: 'const', n: v });

/**
 * Parses Wave 8 `objectFilter` extensions such as `"nonland permanent card with mana value 3 or less"`.
 */
export function parseExtendedFilterWave8(
	phrase: string,
	baseObjectFilter: (s: string) => ObjectFilter | null
): ObjectFilter | null {
	let rest = phrase.trim();
	let maxMvConst: number | undefined;
	let minMvConst: number | undefined;

	const mvLess = rest.match(/^(.+?)\s+with mana value (\d+) or less$/i);
	if (mvLess) {
		rest = mvLess[1].trim();
		maxMvConst = parseInt(mvLess[2], 10);
	} else {
		const mvGreater = rest.match(/^(.+?)\s+with mana value (\d+) or greater$/i);
		if (mvGreater) {
			rest = mvGreater[1].trim();
			minMvConst = parseInt(mvGreater[2], 10);
		}
	}

	let base: ObjectFilter | null = null;
	if (/^nonland permanent cards?$/i.test(rest)) {
		base = { notTypes: ['Instant', 'Sorcery', 'Land'] };
	} else if (/^permanent cards?$/i.test(rest)) {
		base = { notTypes: ['Instant', 'Sorcery'] };
	} else if (maxMvConst !== undefined || minMvConst !== undefined) {
		base = baseObjectFilter(rest);
	}
	if (!base) return null;
	if (maxMvConst !== undefined) {
		base = { ...base, manaValue: { op: '<=', value: n(maxMvConst) } };
	}
	if (minMvConst !== undefined) {
		base = { ...base, manaValue: { op: '>=', value: n(minMvConst) } };
	}
	return base;
}

/**
 * Parses `"noncreature"` / `"in addition to its other types"` animations that add card types or
 * subtypes without turning the permanent into a creature with fixed P/T (*Archangel Elspeth*, etc.).
 */
export function tryParseAnimateInAdditionWave8(
	p: Wave8ParserLike,
	subject: { selector: Selector; fromZone?: ZoneType; plural?: boolean },
	predText: string,
	duration: Duration | undefined,
	span: Span,
	helpers: Wave8CompilerHelpers
): boolean {
	if (subject.fromZone) return false;
	const m = predText.match(/^becomes?\s+(?:(?:a|an)\s+)?(.+)$/i);
	if (!m) return false;
	let rest = m[1].trim();
	let addKeywords: string[] | undefined;

	// Strip optional trailing "and has/gains <keywords>" or "with <keywords>"
	const gainsTail = rest.match(/^(.+?)\s+and\s+(?:gains?|has|have)\s+(.+)$/i);
	if (gainsTail) {
		const kws = helpers.keywordList(gainsTail[2].trim());
		if (!kws) return false;
		addKeywords = kws;
		rest = gainsTail[1].trim();
	} else {
		const withTail = rest.match(/^(.+?)\s+with\s+(.+)$/i);
		if (withTail && !/["“”']/.test(withTail[2])) {
			const kws = helpers.keywordList(withTail[2].trim());
			if (!kws) return false;
			addKeywords = kws;
			rest = withTail[1].trim();
		}
	}

	const inAdd = rest.match(/^(.+?)\s+in addition to (?:its|their) other types$/i);
	if (!inAdd) return false;
	const desc = inAdd[1].trim();
	// Let standard P/T / "creature" parser handle P/T animations.
	if (/(?:^|\s)creatures?$/i.test(desc) || /\b\d+\/\d+\b/.test(desc)) return false;

	const tokens = desc.replace(/,/g, ' , ').split(/\s+/).filter(Boolean);
	const addColors: ManaColor[] = [];
	const addTypes: string[] = [];
	const addSubtypes: string[] = [];

	for (const tok of tokens) {
		if (tok === ',' || tok === 'and' || tok === 'a' || tok === 'an') continue;
		const cw = helpers.colorWord(tok.toLowerCase());
		if (cw) {
			addColors.push(cw);
			continue;
		}
		const ct = CARD_TYPE_WORDS[tok.toLowerCase()];
		if (ct) {
			if (!addTypes.includes(ct)) addTypes.push(ct);
			continue;
		}
		if (/^[A-Z][A-Za-z'-]*$/.test(tok)) {
			const sub = helpers.singularSubtype(tok) ?? tok;
			if (!addSubtypes.includes(sub)) addSubtypes.push(sub);
			continue;
		}
		return false;
	}
	if (addTypes.length === 0 && addSubtypes.length === 0 && addColors.length === 0) return false;

	const params: NonNullable<EffectStep['params']> = {
		duration: duration ?? 'permanent',
		keepExistingTypes: true,
		...(addTypes.length > 0 ? { addTypes } : {}),
		...(addSubtypes.length > 0 ? { addSubtypes } : {}),
		...(addColors.length > 0 ? { addColors } : {}),
		...(addKeywords && addKeywords.length > 0 ? { addKeywords } : {})
	};
	p.push({ verb: 'animate', subject: subject.selector, params, span }, true);
	return true;
}

/**
 * Parses `"the next time a source of your choice would deal damage ..."` and
 * `"prevent the next N damage that a source of your choice would deal ..."`, plus inline riders.
 */
export function tryParsePreventWave8(
	p: Wave8ParserLike,
	text: string,
	span: Span,
	helpers: Wave8CompilerHelpers
): boolean {
	const t = text.trim();
	let mode: 'all' | 'next' = 'all';
	let nextDamageEventOnly = false;
	let chooseSource = false;
	let combatOnly = false;
	let amount: Amount | undefined;
	let targetRaw: string | undefined;

	// Pattern 1: "The next time [a source of your choice / damage] would deal [combat ]damage to <target> this turn, prevent that damage"
	const nextTimeM = t.match(
		/^the next time (a source of your choice|damage) would deal (combat )?damage to (.+?) this turn, prevent that damage$/i
	);
	if (nextTimeM) {
		chooseSource = nextTimeM[1].toLowerCase().includes('source of your choice');
		combatOnly = Boolean(nextTimeM[2]);
		targetRaw = nextTimeM[3].trim();
		mode = 'all';
		nextDamageEventOnly = true;
	}

	// Pattern 2: "Prevent the next N [combat ]damage that a source of your choice would deal to <target> this turn"
	if (!targetRaw) {
		const prevNextM = t.match(
			/^prevent the next (\S+) (combat )?damage that a source of your choice would deal to (.+?) this turn$/i
		);
		if (prevNextM) {
			const amt = helpers.amountWord(p, prevNextM[1]);
			if (!amt) return false;
			mode = 'next';
			amount = amt;
			chooseSource = true;
			combatOnly = Boolean(prevNextM[2]);
			targetRaw = prevNextM[3].trim();
		}
	}

	if (!targetRaw) return false;

	let scope: DamagePreventionSpec['scope'] = 'subject';
	let subject: Selector = { k: 'none' };
	if (/^you and\/or permanents you control$/i.test(targetRaw) || /^you and\/or creatures you control$/i.test(targetRaw)) {
		scope = 'youAndCreaturesYouControl';
		subject = { k: 'player', filter: { relation: 'you' } };
	} else if (/^any target$/i.test(targetRaw)) {
		const mark = p.mark();
		const rec = helpers.damageRecipientSpec(p, 'any target', { k: 'self' });
		if (!rec) {
			p.rollback(mark);
			return false;
		}
		scope = 'subject';
		subject = rec.subject;
	} else {
		const pl = helpers.playerPhrase(p, targetRaw);
		if (pl) {
			scope = 'subject';
			subject = pl;
		} else {
			const obj = helpers.objectPhrase(p, targetRaw);
			if (!obj || obj.fromZone) return false;
			scope = 'subject';
			subject = obj.selector;
		}
	}

	const preventSpec: DamagePreventionSpec = {
		mode,
		combatOnly,
		scope,
		...(chooseSource ? { chooseSource: true } : {}),
		...(nextDamageEventOnly ? { nextDamageEventOnly: true } : {})
	};
	p.push(
		{
			verb: 'preventDamage',
			subject,
			...(amount ? { amount } : {}),
			params: { preventSpec },
			span
		},
		subject.k === 'target' || scope === 'subject'
	);
	return true;
}

/**
 * Attaches prevented-damage follow-up sentences (*Cho-Arrim Alchemist*, *Refraction Trap*,
 * *Test of Faith*) onto the immediately preceding `preventDamage` step.
 */
export function tryPreventFollowUpWave8(
	p: Wave8ParserLike,
	prev: EffectStep | undefined,
	t: string,
	span: Span,
	helpers: Wave8CompilerHelpers
): boolean {
	if (!prev || prev.verb !== 'preventDamage' || !prev.params?.preventSpec) return false;
	const spec = prev.params.preventSpec;
	if (spec.onPrevented) return false;

	if (/^(?:if|when) damage is prevented this way, you gain that much life$/i.test(t) || /^you gain life equal to the damage prevented this way$/i.test(t)) {
		prev.params = {
			...prev.params,
			preventSpec: { ...spec, onPrevented: { kind: 'gainLifeEqual' } }
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	const dmgDealM = t.match(
		/^(?:if|when) damage is prevented this way,\s+~ deals that much damage to (.+)$/i
	);
	if (dmgDealM) {
		const mark = p.mark();
		const rec = helpers.damageRecipientSpec(p, dmgDealM[1].trim(), { k: 'self' });
		if (!rec) {
			p.rollback(mark);
			return false;
		}
		prev.params = {
			...prev.params,
			preventSpec: {
				...spec,
				onPrevented: { kind: 'dealDamageEqual', recipient: rec.subject }
			}
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	const ctrM = t.match(
		/^for each 1 damage prevented this way,\s+put (?:a|an|one) (.+?) counter on (?:it|that creature|that permanent)$/i
	);
	if (ctrM) {
		const counter = helpers.counterName(ctrM[1].trim());
		if (!counter) return false;
		prev.params = {
			...prev.params,
			preventSpec: {
				...spec,
				onPrevented: { kind: 'putCountersEqual', counter }
			}
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	if (/^(?:if|when) damage is prevented this way,\s+draw a card$/i.test(t)) {
		prev.params = {
			...prev.params,
			preventSpec: { ...spec, onPrevented: { kind: 'drawOne' } }
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}
	if (/^(?:if|when) damage is prevented this way,\s+draw that many cards$/i.test(t)) {
		prev.params = {
			...prev.params,
			preventSpec: { ...spec, onPrevented: { kind: 'drawEqual' } }
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	return false;
}

/**
 * Extended keep clauses inside `dig` (*Cosmic Cube*, *Sunbird's Invocation*, *Keldon Flamesage*,
 * *Party Thrasher*, *Tectonic Giant*).
 */
export function parseDigKeepClauseWave8(
	clauseStr: string,
	hasUntilFilter: boolean,
	helpers: Wave8CompilerHelpers,
	p: Wave8ParserLike
): {
	keep: number;
	upTo: boolean;
	keepFilter?: ObjectFilter;
	keepMaxManaValue?: Amount;
	keepLabel?: string;
	keepTo: NonNullable<EffectParams['dig']>['keepTo'];
	keepTapped?: true;
	keepAttacking?: true;
	keepAttackingPlayer?: PlayerRef;
	revealKept?: true;
} | null {
	const s = clauseStr.trim();
	const mayPrefix = /^you may\s+/i.test(s);
	const body = s.replace(/^you may\s+/i, '');

	// "You may cast <what> [with mana value <cap>] from among <pool> without paying its mana cost"
	// (*Sunbird's Invocation*, *Cosmic Cube*)
	const fromPoolRe = 'from among (?:them|those cards|cards revealed this way)';
	const castFreeM =
		body.match(
			new RegExp(
				`^cast (?:a |an )?(.+?)(?: with mana value (.+?))? ${fromPoolRe} without paying its mana cost$`,
				'i'
			)
		) ??
		body.match(
			new RegExp(
				`^cast (?:a |an )?(.+?) ${fromPoolRe} with mana value (.+?) without paying its mana cost$`,
				'i'
			)
		);
	if (castFreeM) {
		const rawCardDesc = castFreeM[1].trim();
		let keepFilter: ObjectFilter | undefined;
		if (!/^(?:card|spell)$/i.test(rawCardDesc)) {
			const f = helpers.objectFilter(rawCardDesc);
			if (!f) return null;
			keepFilter = f;
		}
		let keepMaxManaValue: Amount | undefined;
		if (castFreeM[2]) {
			const capRaw = castFreeM[2]
				.trim()
				.replace(/^less than or equal to\s+/i, '')
				.replace(/\s+or less$/i, '')
				.trim();
			const mvAmt = helpers.amountWord(p, capRaw) ?? helpers.equalTo(p, capRaw);
			if (!mvAmt) return null;
			keepMaxManaValue = mvAmt;
		}
		return {
			keep: 1,
			upTo: mayPrefix,
			...(keepFilter ? { keepFilter } : {}),
			...(keepMaxManaValue ? { keepMaxManaValue } : {}),
			keepTo: 'castFree'
		};
	}

	// "Exile one of them / <a/an filter [with mana value X or less]> from among them" (*Keldon Flamesage*)
	const exOfThem = body.match(/^exile (one|two|three|a|an) of (?:them|those cards)$/i);
	if (exOfThem) {
		const cnt = exOfThem[1].toLowerCase();
		const k = cnt === 'two' ? 2 : cnt === 'three' ? 3 : 1;
		return { keep: k, upTo: mayPrefix, keepTo: 'exile' };
	}
	const exFilterM = body.match(
		new RegExp(
			`^exile (?:a |an |one )(.+?)(?: with mana value (.+?))? ${fromPoolRe}$`,
			'i'
		)
	);
	if (exFilterM) {
		const keepFilter = helpers.objectFilter(exFilterM[1].trim());
		if (!keepFilter) return null;
		let keepMaxManaValue: Amount | undefined;
		if (exFilterM[2]) {
			const capRaw = exFilterM[2]
				.trim()
				.replace(/^less than or equal to\s+/i, '')
				.replace(/\s+or less$/i, '')
				.trim();
			const mvAmt = helpers.amountWord(p, capRaw) ?? helpers.equalTo(p, capRaw);
			if (!mvAmt) return null;
			keepMaxManaValue = mvAmt;
		}
		return {
			keep: 1,
			upTo: mayPrefix,
			keepFilter,
			...(keepMaxManaValue ? { keepMaxManaValue } : {}),
			keepTo: 'exile'
		};
	}

	// "Put that card / a <filter> card from among them onto the battlefield tapped and attacking that player" (*Owlbear Cub*)
	const attM = body.match(
		hasUntilFilter
			? /^put (?:that card|it) onto the battlefield tapped and attacking (that player|that opponent|them)$/i
			: /^put (?:a |an )?(.+?) from among (?:them|those cards) onto the battlefield tapped and attacking (that player|that opponent|them)$/i
	);
	if (attM) {
		const playerGroup = hasUntilFilter ? attM[1] : attM[2];
		const keepFilter = hasUntilFilter ? undefined : helpers.objectFilter(attM[1].trim());
		if (!hasUntilFilter && !keepFilter) return null;
		const pr = helpers.playerPhrase(p, playerGroup.toLowerCase());
		const ref = pr ? helpers.singlePlayer(pr) : null;
		return {
			keep: 1,
			upTo: mayPrefix,
			...(keepFilter ? { keepFilter } : {}),
			keepTo: 'battlefield',
			keepTapped: true,
			keepAttacking: true,
			...(ref ? { keepAttackingPlayer: ref } : {})
		};
	}

	return null;
}

/**
 * Sentence follow-ups handled cleanly for P22d multi-sentence patterns.
 */
export function tryParseFollowUpSentenceWave8(
	p: Wave8ParserLike,
	t: string,
	span: Span,
	helpers: Wave8CompilerHelpers
): boolean {
	// 1. Prevented damage riders on preceding preventDamage step
	const prev = p.steps[p.steps.length - 1];
	if (tryPreventFollowUpWave8(p, prev, t, span, helpers)) {
		return true;
	}

	// 2. "You have no maximum hand size for the rest of the game."
	if (/^you have no maximum hand size for the rest of the game$/i.test(t)) {
		p.push(
			{
				verb: 'grantPlayer',
				subject: { k: 'player', filter: { relation: 'you' } },
				params: { playerRules: ['noMaxHandSizeRestOfGame'] },
				span
			},
			false
		);
		return true;
	}

	// 3. "If it doesn't have suspend, it gains suspend." (*The Tenth Doctor*, *Jhoira*, etc.)
	if (/^if it (?:doesn't|does not) have suspend, it gains suspend$/i.test(t)) {
		const lastObj = p.lastObject;
		if (!lastObj) return false;
		p.push(
			{
				verb: 'grant',
				subject: asSelector(lastObj.ref),
				params: { duration: 'permanent', grantSuspendIfMissing: true },
				span
			},
			false
		);
		return true;
	}

	// 4. "You may return ~ [or <object>] from your graveyard to the battlefield attached to <target / that creature / that token>."
	const retAttach = t.match(
		/^(?:you may )?return (.+?) from your graveyard to the battlefield attached to (.+)$/i
	);
	if (retAttach) {
		const optional = /^you may\s+/i.test(t);
		const mark = p.mark();
		const whatRaw = retAttach[1].trim();
		let subject: Selector;
		if (/^~$/.test(whatRaw)) {
			subject = { k: 'self' };
		} else {
			const subObj = helpers.objectPhrase(p, `${whatRaw} from your graveyard`);
			if (!subObj) {
				p.rollback(mark);
				return false;
			}
			subject = subObj.selector;
		}
		const targetObj = helpers.objectPhrase(p, retAttach[2].trim());
		if (!targetObj || targetObj.fromZone) {
			p.rollback(mark);
			return false;
		}
		p.push(
			{
				verb: 'move',
				subject,
				...(optional ? { optional: { chooser: { k: 'you' } } } : {}),
				params: {
					from: 'graveyard',
					to: 'battlefield',
					underYourControl: true,
					attachedToSelector: targetObj.selector
				},
				span
			},
			true
		);
		return true;
	}

	// 5. "Destroy all Equipment / Auras attached to <that creature / target creature>."
	const destAttach = t.match(
		/^destroy all (equipment|auras|equipment and auras|auras and equipment) attached to (.+)$/i
	);
	if (destAttach) {
		const mark = p.mark();
		const hostObj = helpers.objectPhrase(p, destAttach[2].trim());
		if (!hostObj || !hostObj.ref || hostObj.fromZone || (hostObj.ref.k !== 'self' && hostObj.ref.k !== 'attachedTo')) {
			p.rollback(mark);
			return false;
		}
		const kind = destAttach[1].toLowerCase();
		const subtypes = kind.includes('equipment') && kind.includes('aura')
			? ['Equipment', 'Aura']
			: kind.includes('equipment')
				? ['Equipment']
				: ['Aura'];
		p.push(
			{
				verb: 'destroy',
				subject: {
					k: 'all',
					filter: { zone: 'battlefield', subtypes, attachedToRef: hostObj.ref.k }
				},
				span
			},
			false
		);
		return true;
	}

	// 6. Follow-up "It's a/an <Type/Subtype> in addition to its other types." (or "becomes a...")
	const itIsInAdd = t.match(/^(?:it's|they're|it is|they are) (.+?) in addition to (?:its|their) other types$/i);
	if (itIsInAdd && p.lastObject) {
		const dur = helpers.parseDurationTail(t);
		const mark = p.mark();
		if (
			tryParseAnimateInAdditionWave8(
				p,
				{ selector: asSelector(p.lastObject.ref) },
				`becomes ${itIsInAdd[1].trim()} in addition to its other types`,
				dur,
				span,
				helpers
			)
		) {
			return true;
		}
		p.rollback(mark);
	}

	// 7. Follow-up after `dig` with `keepTo: 'exile'`: "You may play/cast that card / those cards / it this turn / until the end of your next turn"
	//    OR "You may cast the exiled card without paying its mana cost" (*Keldon Flamesage*)
	const impCastFree = t.match(
		/^you may cast (?:it|that card|the exiled card|the exiled cards|them) without paying its mana cost$/i
	);
	if (impCastFree && prev?.verb === 'dig' && prev.params?.dig?.keepTo === 'exile' && p.lastObject) {
		p.push(
			{
				verb: 'castFree',
				subject: asSelector(p.lastObject.ref),
				optional: { chooser: { k: 'you' } },
				params: { castFreeSpec: { withoutPayingManaCost: true } },
				span
			},
			false
		);
		return true;
	}
	const impPlay = t.match(
		/^you may (?:play|cast) (it|them|that card|those cards|the exiled card|the exiled cards) (this turn|until (?:the )?end of your next turn)$/i
	);
	if (impPlay && prev?.verb === 'dig' && prev.params?.dig?.keepTo === 'exile') {
		const durRaw = impPlay[2].toLowerCase();
		const duration = durRaw.includes('next turn') ? 'untilEndOfYourNextTurn' : 'thisTurn';
		const spellsOnly = /^you may cast\b/i.test(t);
		prev.params = {
			...prev.params,
			dig: {
				...prev.params.dig,
				playFromExile: { duration, ...(spellsOnly ? { spellsOnly: true } : {}) }
			}
		};
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	// 8. "Otherwise, put it into your hand." / "If you don't cast it this way, put it into your hand."
	const otherwiseHand = t.match(
		/^(?:otherwise|if you (?:don't|do not) cast (?:it|that card|a spell) this way),\s+put (?:it|that card|that creature card) into your hand$/i
	);
	if (otherwiseHand && prev) {
		if (prev.verb === 'exileUntil' && prev.params?.exileUntilSpec?.hitAction === 'castFree') {
			prev.params = {
				...prev.params,
				exileUntilSpec: { ...prev.params.exileUntilSpec, fallbackToHand: true }
			};
			prev.span = { start: prev.span.start, end: span.end };
			return true;
		}
		if (prev.verb === 'dig' && prev.params?.dig?.keepTo === 'castFree' && p.lastObject) {
			const prevIdx = p.steps.length - 1;
			p.push(
				{
					verb: 'move',
					subject: asSelector(p.lastObject.ref),
					ifPrecedingDeclined: prevIdx,
					params: { from: 'exile', to: 'hand' },
					span
				},
				false
			);
			return true;
		}
	}

	// 9. "You may choose new targets for the copy / copies."
	if (
		/^(?:if you do,\s+)?you may choose new targets for (?:the|that|those) cop(?:y|ies)$/i.test(t) &&
		prev &&
		(prev.verb === 'copySpell' || prev.verb === 'delayedNextSpellCopy')
	) {
		prev.params = { ...prev.params, mayChooseNewTargets: true };
		prev.span = { start: prev.span.start, end: span.end };
		return true;
	}

	// 10. Spell mastery / conditional copy of a countered spell (*Psychic Rebuttal*, CR 707.10b)
	const copyCounteredM = t.match(
		/^(?:[a-z]+ mastery\s*—\s*)?(if there are (?:two|2) or more instant and\/or sorcery cards in your graveyard,\s+)?(you may\s+)?copy (?:that|the) spell(?: (?:if it(?:'s| is) )?countered this way)?$/i
	);
	if (copyCounteredM && prev?.verb === 'counterSpell' && p.lastObject) {
		const ref = p.itRef?.() ?? p.lastObject.ref;
		if (p.lastObject.stepIndex >= 0 && ref.k === 'binding' && p.steps[p.lastObject.stepIndex]) {
			p.steps[p.lastObject.stepIndex].bindAs = ref.name;
		}
		const cond: Condition | undefined = copyCounteredM[1]
			? {
					k: 'compare',
					left: {
						k: 'count',
						of: {
							types: ['Instant', 'Sorcery'],
							zone: 'graveyard',
							owner: 'you'
						}
					},
					op: '>=',
					right: { k: 'const', n: 2 }
				}
			: undefined;
		p.push(
			{
				verb: 'copySpell',
				subject: asSelector(ref),
				...(copyCounteredM[2] ? { optional: { chooser: { k: 'you' } } } : {}),
				...(cond ? { condition: cond } : {}),
				span
			},
			true
		);
		return true;
	}

	return false;
}

/**
 * Split sentences that end with a closing quote after sentence punctuation (`."`, `!"`, `?"`)
 * immediately followed by whitespace and a capitalized follow-up sentence (e.g.
 * `... with "During your turn, ~ has first strike." It's still a land.`), without altering
 * `compiler/normalize.ts`.
 */
export function splitQuotedSentenceEndingsWave8<T extends { text: string; span: Span }>(
	sentences: readonly T[]
): Array<{ text: string; span: Span }> {
	const out: Array<{ text: string; span: Span }> = [];
	for (const s of sentences) {
		if (!s.text.includes('"')) {
			out.push(s);
			continue;
		}
		let inQuotes = false;
		let segStart = 0;
		const txt = s.text;
		for (let i = 0; i < txt.length; i++) {
			const ch = txt[i];
			if (ch === '"') {
				if (!inQuotes) {
					inQuotes = true;
				} else {
					inQuotes = false;
					const prevCh = i > 0 ? txt[i - 1] : '';
					if (prevCh === '.' || prevCh === '!' || prevCh === '?') {
						// Look ahead past whitespace for an uppercase sentence start outside quotes.
						let j = i + 1;
						for (let guard = 0; guard < 16 && j < txt.length && /\s/.test(txt[j]); guard++) {
							j++;
						}
						if (j > i + 1 && j < txt.length && /[A-Z]/.test(txt[j])) {
							const leftRaw = txt.slice(segStart, i + 1);
							const leftLead = leftRaw.length - leftRaw.trimStart().length;
							const leftTrim = leftRaw.trim();
							if (leftTrim.length > 0) {
								out.push({
									text: leftTrim,
									span: {
										start: s.span.start + segStart + leftLead,
										end: s.span.start + i + 1
									}
								});
							}
							segStart = j;
						}
					}
				}
			}
		}
		if (segStart === 0) {
			out.push(s);
		} else {
			const tailRaw = txt.slice(segStart);
			const tailLead = tailRaw.length - tailRaw.trimStart().length;
			const tailTrim = tailRaw.trim();
			if (tailTrim.length > 0) {
				out.push({
					text: tailTrim,
					span: {
						start: s.span.start + segStart + tailLead,
						end: s.span.start + segStart + tailLead + tailTrim.length
					}
				});
			}
		}
	}
	return out;
}

