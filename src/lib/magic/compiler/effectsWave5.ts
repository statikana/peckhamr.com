/**
 * Wave 5 Track P13 compiler helper module:
 * - Extended disjunctive, relational, and turn-history `ObjectFilter` grammar (`parseExtendedObjectPhrase`),
 *   shared across `compiler/effects.ts` and `compiler/triggers.ts` with zero circular imports.
 * - P13 dynamic `Amount` parsers (`devotion`, `unlockedDoorsCount`, `excessDamage`, `lastEffectAmount`,
 *   `colorsAmongPermanents`, `half`, `dungeonsCompleted`, `greatestStatAmong`, `totalStatAmong`).
 * - P13 verb sentence parsers:
 *   - `createEmblem` (`CR 114`)
 *   - `createRoleToken` (`CR 111.10k–r`)
 *   - `doubleOrTriple` (`CR 701.10–11`)
 *   - `exchange` (`CR 701.12`)
 *   - `turnFace` (`CR 708`)
 *   - `chooseDesignation`
 *   - `grantGraveyardCast`
 *   - `ventureIntoDungeon` (`CR 309, 701.49`), `takeInitiative` (`CR 727`), `temptWithRing` (`CR 701.54`)
 *   - `earthbend` (`CR 701.66`), `airbend` (`CR 701.65`), `learn` (`CR 701.48`),
 *     `villainousChoice` (`CR 701.55`), `vote` (`CR 701.38`).
 */

import type {
	Amount,
	DoubleOrTripleSpec,
	Duration,
	EffectStep,
	ExchangeSpec,
	GraveyardCastGrantSpec,
	ObjectFilter,
	PlayerRef,
	RoleTokenKind,
	Selector,
	TargetSpec,
	VoteSpec
} from '../ir.ts';
import type { CounterType, ManaColor } from '../types.ts';
import { COUNTERS, parseObjectPhrase, singularSubtype } from './costs.ts';

const COLOR_MAP: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G',
	colorless: 'C'
};

const ROLE_KIND_MAP: Record<string, RoleTokenKind> = {
	cursed: 'cursed',
	monster: 'monster',
	royal: 'royal',
	sorcerer: 'sorcerer',
	virtuous: 'virtuous',
	wicked: 'wicked',
	'young hero': 'young_hero'
};

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
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	twenty: 20
};

function parseSmallNumber(word: string): number | null {
	const low = word.trim().toLowerCase();
	if (/^\d+$/.test(low)) return parseInt(low, 10);
	return NUMBER_WORDS[low] ?? null;
}

// ---- 1. Disjunctive & Relational ObjectFilter Grammar ---------------------------------------

export interface ExtendedObjectPhraseOptions {
	allowSpellNoun?: boolean;
	depth?: number;
}

function mergeObjectFilters(base: ObjectFilter, extra: ObjectFilter): ObjectFilter {
	const out: ObjectFilter = { ...base };
	for (const [k, v] of Object.entries(extra) as Array<[keyof ObjectFilter, unknown]>) {
		if (v === undefined) continue;
		const existing = out[k];
		if (Array.isArray(existing) && Array.isArray(v)) {
			const existingArr = existing as unknown[];
			(out as Record<string, unknown>)[k] = [
				...existingArr,
				...v.filter((item) => !existingArr.includes(item))
			];
		} else {
			(out as Record<string, unknown>)[k] = v;
		}
	}
	return out;
}

function splitTopLevelDisjunction(text: string): string[] | null {
	if (!/\b(?:or|and\/or)\b/i.test(text)) return null;
	// Do not split "power N or greater/less/more/fewer" or "one or more".
	const masked = text
		.replace(/\b(?:one|two|three|four|five|\d+)\s+or\s+(?:more|fewer|less|greater)\b/gi, (m) =>
			m.replace(/\bor\b/gi, '__OR__')
		)
		.replace(/\b(?:power|toughness|mana value)\s+\S+\s+or\s+(?:greater|more|less|fewer)\b/gi, (m) =>
			m.replace(/\bor\b/gi, '__OR__')
		)
		.replace(/\battacking\s+or\s+blocking\b/gi, 'attacking __OR__ blocking');
	if (!/\b(?:or|and\/or)\b/i.test(masked)) return null;

	const rawParts = masked
		.split(/\s*(?:,\s*(?:or|and\/or)\s+|\s+(?:or|and\/or)\s+|,\s*)\s*/i)
		.map((s) => s.replace(/__OR__/g, 'or').trim().replace(/^(?:a|an)\s+/i, ''))
		.filter(Boolean);
	return rawParts.length >= 2 ? rawParts : null;
}

function isPureTypesBranch(f: ObjectFilter): f is { types: string[] } {
	const keys = Object.keys(f);
	return keys.length === 1 && keys[0] === 'types' && Array.isArray(f.types) && f.types.length > 0;
}

function isPureSubtypesBranch(f: ObjectFilter): f is { subtypes: string[] } {
	const keys = Object.keys(f);
	return (
		keys.length === 1 &&
		keys[0] === 'subtypes' &&
		Array.isArray(f.subtypes) &&
		f.subtypes.length > 0
	);
}

/**
 * Extended `ObjectFilter` parser wrapping `parseObjectPhrase` from `./costs.ts`.
 * Supports:
 * - Disjunctions across types, subtypes, tokens, and compound branches (`anyOf`)
 * - Color disjunctions (`"white or blue creature"`, `"black, red, or green permanent"`)
 * - Multi-negated subtypes (`"non-Human, non-Elf creature"`, `"non-Time-Lord creature"`)
 * - Turn-history & state modifiers (`attackingOrBlocking`, `enteredThisTurn`, `dealtDamageThisTurn`,
 *   `faceDown`, `kickedSpell`, `suspected`, `castNotFromHand`, `castFromZoneFilter`)
 * - Relational qualifiers (`an opponent controls`, `defending player controls`, `that targets ...`,
 *   `with power less than ~'s power`).
 */
export function parseExtendedObjectPhrase(
	phrase: string,
	opts?: ExtendedObjectPhraseOptions
): ObjectFilter | null {
	const depth = opts?.depth ?? 0;
	if (depth > 3) return null;

	let rest = phrase.trim();
	if (!rest) return null;

	// Fast path if standard cost/filter grammar already understands the whole phrase.
	const direct = parseObjectPhrase(rest);
	if (direct) return direct;

	const outer: ObjectFilter = {};
	let sawSpellQualifier = Boolean(opts?.allowSpellNoun);

	// 1. Strip trailing qualifiers in any order (bounded).
	for (let guard = 0; guard < 24; guard++) {
		const oppControls = rest.match(/^(.+?)\s+(?:an opponent controls|opponents control|you don't control)$/i);
		if (oppControls && !outer.controller && !outer.controllerRef) {
			outer.controller = 'opponent';
			rest = oppControls[1].trim();
			continue;
		}
		const youControl = rest.match(/^(.+?)\s+you control$/i);
		if (youControl && !outer.controller && !outer.controllerRef) {
			outer.controller = 'you';
			rest = youControl[1].trim();
			continue;
		}
		const oppOwns = rest.match(/^(.+?)\s+(?:an opponent owns|opponents own|you don't own)$/i);
		if (oppOwns && !outer.owner) {
			outer.owner = 'opponent';
			rest = oppOwns[1].trim();
			continue;
		}
		const youOwn = rest.match(/^(.+?)\s+you own$/i);
		if (youOwn && !outer.owner) {
			outer.owner = 'you';
			rest = youOwn[1].trim();
			continue;
		}
		const defControls = rest.match(/^(.+?)\s+defending player controls$/i);
		if (defControls && !outer.controller && !outer.controllerRef) {
			outer.controllerRef = { k: 'defendingPlayer' };
			rest = defControls[1].trim();
			continue;
		}
		const activeControls = rest.match(/^(.+?)\s+active player controls$/i);
		if (activeControls && !outer.controller && !outer.controllerRef) {
			outer.controllerRef = { k: 'activePlayer' };
			rest = activeControls[1].trim();
			continue;
		}
		const enchCtrlControls = rest.match(
			/^(.+?)\s+(?:enchanted|equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker)'s controller controls$/i
		);
		if (enchCtrlControls && !outer.controller && !outer.controllerRef) {
			outer.controllerRef = { k: 'controllerOf', of: { k: 'attachedTo' } };
			rest = enchCtrlControls[1].trim();
			continue;
		}
		const enteredTurn = rest.match(
			/^(.+?)\s+that entered (?:the battlefield )?(under your control )?this turn$/i
		);
		if (enteredTurn && outer.enteredThisTurn === undefined) {
			outer.enteredThisTurn = true;
			if (enteredTurn[2] && !outer.controller && !outer.controllerRef) {
				outer.controller = 'you';
			}
			rest = enteredTurn[1].trim();
			continue;
		}
		const dealtDmgTurn = rest.match(/^(.+?)\s+(?:that was |that were )?dealt damage this turn$/i);
		if (dealtDmgTurn && outer.dealtDamageThisTurn === undefined) {
			outer.dealtDamageThisTurn = true;
			rest = dealtDmgTurn[1].trim();
			continue;
		}
		const targetsSelf = rest.match(/^(.+?)\s+that targets ~$/i);
		if (targetsSelf && outer.targetsSelf === undefined) {
			outer.targetsSelf = true;
			rest = targetsSelf[1].trim();
			continue;
		}
		const targetsSub = rest.match(/^(.+?)\s+that targets (?:a|an|one or more)\s+(.+)$/i);
		if (targetsSub && !outer.targetsFilter && depth < 2) {
			const subFilter = parseExtendedObjectPhrase(targetsSub[2], { depth: depth + 1 });
			if (subFilter) {
				outer.targetsFilter = subFilter;
				rest = targetsSub[1].trim();
				continue;
			}
		}
		const pwrLessSelf = rest.match(/^(.+?)\s+with power less than ~'s power$/i);
		if (pwrLessSelf && outer.powerLessThanSource === undefined) {
			outer.powerLessThanSource = true;
			rest = pwrLessSelf[1].trim();
			continue;
		}
		const notFromHand = rest.match(/^(.+?)\s+from anywhere other than (?:your|their|its owner's) hand$/i);
		if (notFromHand && outer.castNotFromHand === undefined) {
			outer.castNotFromHand = true;
			rest = notFromHand[1].trim();
			continue;
		}
		if (sawSpellQualifier || /\bspells?\b/i.test(rest)) {
			const fromGy = rest.match(/^(.+?)\s+from (?:your|a) graveyard$/i);
			if (fromGy && outer.castFromZoneFilter === undefined) {
				outer.castFromZoneFilter = 'graveyard';
				rest = fromGy[1].trim();
				continue;
			}
			const fromExile = rest.match(/^(.+?)\s+from exile$/i);
			if (fromExile && outer.castFromZoneFilter === undefined) {
				outer.castFromZoneFilter = 'exile';
				rest = fromExile[1].trim();
				continue;
			}
		}
		// Delegate standard trailing modifiers ("with flying", "with power 3 or less", "with a +1/+1 counter on it", etc.)
		// by probing parseObjectPhrase on a synthetic "creature <suffix>" probe!
		const stdTrailing = rest.match(
			/^(.+?)\s+(exiled with ~|of the chosen (?:type|color|name)|with the chosen name|attached to (?:~|it|(?:enchanted|equipped) (?:creature|permanent|land|artifact|enchantment|planeswalker))|with (?:power|toughness|mana value) \S+(?: or (?:greater|more|less|fewer))?|with (?:(?:a|an|one or more)\s+)?(?:[+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+ )?counters? on (?:it|them)|without [a-z ,/]+|with [a-z ,]+)$/i
		);
		if (stdTrailing) {
			const probe = parseObjectPhrase(`creature ${stdTrailing[2]}`);
			if (probe) {
				const { types: _dropTypes, ...extracted } = probe;
				Object.assign(outer, mergeObjectFilters(outer, extracted));
				rest = stdTrailing[1].trim();
				continue;
			}
		}
		break;
	}

	// Re-check direct parse after stripping extended trailing qualifiers.
	const afterTrailing = parseObjectPhrase(rest);
	if (afterTrailing) return mergeObjectFilters(afterTrailing, outer);

	// 2. Strip leading modifiers in bounded order.
	for (let guard = 0; guard < 24; guard++) {
		const otherM = rest.match(/^(?:another|other)\s+(.+)$/i);
		if (otherM) {
			outer.other = true;
			rest = otherM[1].trim();
			continue;
		}
		const atkBlkM = rest.match(/^attacking or blocking\s+(.+)$/i);
		if (atkBlkM) {
			outer.attackingOrBlocking = true;
			rest = atkBlkM[1].trim();
			continue;
		}
		const faceDownM = rest.match(/^face-down\s+(.+)$/i);
		if (faceDownM) {
			outer.faceDown = true;
			rest = faceDownM[1].trim();
			continue;
		}
		const faceUpM = rest.match(/^face-up\s+(.+)$/i);
		if (faceUpM) {
			outer.faceDown = false;
			rest = faceUpM[1].trim();
			continue;
		}
		const kickedM = rest.match(/^kicked\s+(.+)$/i);
		if (kickedM) {
			outer.kickedSpell = true;
			rest = kickedM[1].trim();
			continue;
		}
		const suspectedM = rest.match(/^suspected\s+(.+)$/i);
		if (suspectedM) {
			outer.suspected = true;
			rest = suspectedM[1].trim();
			continue;
		}
		// Color disjunction: "white or blue <rest>" / "black, red, or green <rest>"
		const colorDisj = rest.match(
			/^((?:white|blue|black|red|green|colorless)(?:\s*,\s*(?:white|blue|black|red|green|colorless))*)\s*,?\s+(?:or|and\/or)\s+(white|blue|black|red|green|colorless)\s+(.+)$/i
		);
		if (colorDisj) {
			const cols: ManaColor[] = outer.colors ? [...outer.colors] : [];
			const firstList = colorDisj[1].split(/\s*,\s*/);
			for (const w of [...firstList, colorDisj[2]]) {
				const mapped = COLOR_MAP[w.toLowerCase()];
				if (mapped && !cols.includes(mapped)) cols.push(mapped);
			}
			outer.colors = cols;
			rest = colorDisj[3].trim();
			continue;
		}
		// Multi-word / hyphenated / comma-separated negated subtypes: "non-Time Lord", "non-Assembly-Worker", "non-Human, non-Elf"
		const nonSubM = rest.match(/^non-([A-Z][A-Za-z'-]*)(?:,\s*(?:and\s+)?|\s+and\s+|\s+)(.+)$/);
		if (nonSubM) {
			const sub = singularSubtype(nonSubM[1]) ?? nonSubM[1];
			(outer.notSubtypes ??= []).push(sub);
			rest = nonSubM[2].trim();
			continue;
		}
		// Standard single-word leading modifiers ("nontoken", "tapped", "untapped", "legendary", "nonland", "white", "nonblack", "multicolored", etc.)
		const singleModM = rest.match(
			/^(untapped|tapped|nontoken|historic|nonhistoric|attacking|blocking|multicolored|monocolored|basic|legendary|snow|white|blue|black|red|green|colorless|nonwhite|nonblue|nonblack|nonred|nongreen|nonartifact|noncreature|nonenchantment|nonland|nonplaneswalker),?\s+(.+)$/i
		);
		if (singleModM) {
			const modProbe = parseObjectPhrase(`${singleModM[1]} permanent`);
			if (modProbe) {
				Object.assign(outer, mergeObjectFilters(outer, modProbe));
				rest = singleModM[2].trim();
				continue;
			}
		}
		break;
	}

	// Handle spell nouns ("spell", "noncreature spell", "instant or sorcery spell", "kicked spell").
	if (sawSpellQualifier) {
		if (/^spells?$/i.test(rest)) {
			return outer;
		}
		const strippedSpell = rest.replace(/\s+spells?$/i, '').trim();
		if (strippedSpell !== rest) {
			rest = strippedSpell;
		}
	}

	// Strip redundant trailing "permanents?" or "cards?" when preceded by other type/noun words.
	if (/\s+(?:permanents?|cards?)$/i.test(rest)) {
		const withoutGeneric = rest.replace(/\s+(?:permanents?|cards?)$/i, '').trim();
		if (withoutGeneric) {
			rest = withoutGeneric;
		}
	}

	// Bare "permanent(s)" or "card(s)" after leading/trailing modifiers.
	if (/^(?:permanents?|cards?)$/i.test(rest)) {
		return outer;
	}

	// Re-check standard parser on reduced core.
	const reducedDirect = parseObjectPhrase(rest);
	if (reducedDirect) return mergeObjectFilters(reducedDirect, outer);

	// Hyphenated or two-word capitalized subtypes ("Time Lord", "Assembly-Worker").
	if (/^[A-Z][A-Za-z'-]*$/.test(rest)) {
		const sub = singularSubtype(rest);
		if (sub) return mergeObjectFilters({ subtypes: [sub] }, outer);
	}

	// 3. General disjunction across mixed types, subtypes, tokens, and compound branches!
	const disjParts = splitTopLevelDisjunction(rest);
	if (disjParts && depth < 2) {
		// Special high-frequency shorthand: "artifact, enchantment, or token"
		if (
			disjParts.length === 3 &&
			/^artifacts?$/i.test(disjParts[0]) &&
			/^enchantments?$/i.test(disjParts[1]) &&
			/^tokens?$/i.test(disjParts[2])
		) {
			return mergeObjectFilters({ artifactEnchantmentOrToken: true }, outer);
		}
		const branches: ObjectFilter[] = [];
		for (const part of disjParts) {
			const parsed = parseExtendedObjectPhrase(part, {
				allowSpellNoun: sawSpellQualifier,
				depth: depth + 1
			});
			if (!parsed || Object.keys(parsed).length === 0) return null;
			branches.push(parsed);
		}
		if (branches.every(isPureTypesBranch)) {
			const allTypes: string[] = [];
			for (const b of branches) {
				for (const t of b.types) if (!allTypes.includes(t)) allTypes.push(t);
			}
			return mergeObjectFilters({ types: allTypes }, outer);
		}
		if (branches.every(isPureSubtypesBranch)) {
			const allSubs: string[] = [];
			for (const b of branches) {
				for (const s of b.subtypes) if (!allSubs.includes(s)) allSubs.push(s);
			}
			return mergeObjectFilters({ subtypes: allSubs }, outer);
		}
		return mergeObjectFilters({ anyOf: branches }, outer);
	}

	return null;
}

// ---- 2. P13 Dynamic Amount Parsers ----------------------------------------------------------

export function parseP13Amount(
	raw: string,
	parseSubAmount?: (text: string) => Amount | null
): Amount | null {
	const t = raw.trim().replace(/\.$/, '').trim();
	if (!t) return null;
	const low = t.toLowerCase();

	// "half X, rounded up/down" / "half your life total, rounded up/down"
	const halfM = t.match(/^half (?:of )?(.+?),?\s+rounded (up|down)$/i);
	if (halfM && parseSubAmount) {
		const inner = parseSubAmount(halfM[1].trim());
		if (inner) {
			return { k: 'half', of: inner, round: halfM[2].toLowerCase() === 'up' ? 'up' : 'down' };
		}
	}

	// "twice <amount>" / "two times <amount>"
	const twiceM = t.match(/^(?:twice|two times)\s+(.+)$/i);
	if (twiceM && parseSubAmount) {
		const inner = parseSubAmount(twiceM[1].trim());
		if (inner) {
			return { k: 'sum', args: [inner, inner] };
		}
	}

	// "your devotion to red" / "your devotion to white and blue" / "your devotion to black, red, and green"
	const devM = low.match(
		/^(?:your )?devotion to ((?:white|blue|black|red|green)(?:\s*(?:,\s*(?:and\s+)?|\s+and\s+)(?:white|blue|black|red|green))*)$/
	);
	if (devM) {
		const colors: ManaColor[] = [];
		for (const w of devM[1].split(/\s*(?:,\s*(?:and\s+)?|\s+and\s+)\s*/)) {
			const c = COLOR_MAP[w.trim()];
			if (c && c !== 'C' && !colors.includes(c)) colors.push(c);
		}
		if (colors.length > 0) return { k: 'devotion', colors };
	}

	// "the number of unlocked doors among Rooms you control"
	if (
		/^(?:the number of )?unlocked doors among rooms you control$/.test(low) ||
		/^the number of unlocked doors you control$/.test(low)
	) {
		return { k: 'unlockedDoorsCount', player: { k: 'you' } };
	}

	// "the excess damage" / "excess damage dealt this way"
	if (/^(?:the )?excess damage(?:\s+dealt(?:\s+this way)?)?$/.test(low)) {
		return { k: 'excessDamage' };
	}

	// "the life lost this way" / "the life gained this way" / "that much" (when bound to prior amount)
	if (
		/^(?:the )?(?:amount of )?(?:life (?:gained|lost)|damage dealt|cards? drawn) this way$/.test(low) ||
		/^the number of cards drawn this way$/.test(low)
	) {
		return { k: 'lastEffectAmount' };
	}

	// "the number of colors among permanents you control" / "the number of colors among <filter>"
	const colorsAmongM = t.match(/^(?:the number of )?colors among (.+)$/i);
	if (colorsAmongM) {
		const phrase = colorsAmongM[1].trim();
		if (/^permanents you control$/i.test(phrase)) {
			return { k: 'colorsAmongPermanents', player: { k: 'you' } };
		}
		const f = parseExtendedObjectPhrase(phrase);
		if (f) {
			return { k: 'colorsAmongPermanents', filter: { ...f, zone: 'battlefield' }, player: { k: 'you' } };
		}
	}

	// "the number of dungeons you've completed"
	if (/^(?:the number of )?dungeons you(?:'ve| have) completed$/.test(low)) {
		return { k: 'dungeonsCompleted', player: { k: 'you' } };
	}

	// "the greatest power/toughness/mana value among <filter>"
	const greatestM = t.match(
		/^(?:the )?(?:greatest|highest) (power|toughness|mana value) among (.+)$/i
	);
	if (greatestM) {
		const statRaw = greatestM[1].toLowerCase();
		const stat: 'power' | 'toughness' | 'manaValue' =
			statRaw === 'power' ? 'power' : statRaw === 'toughness' ? 'toughness' : 'manaValue';
		let filterPhrase = greatestM[2].trim();
		let zone: 'battlefield' | 'graveyard' | 'exile' | 'hand' = 'battlefield';
		const gySuffix = filterPhrase.match(/^(.+?)\s+in your graveyard$/i);
		if (gySuffix) {
			zone = 'graveyard';
			filterPhrase = `${gySuffix[1]} you own`;
		} else if (/\bin all graveyards$/i.test(filterPhrase)) {
			zone = 'graveyard';
			filterPhrase = filterPhrase.replace(/\s+in all graveyards$/i, '').trim();
		} else if (/\bin exile$/i.test(filterPhrase)) {
			zone = 'exile';
			filterPhrase = filterPhrase.replace(/\s+in exile$/i, '').trim();
		}
		const f = parseExtendedObjectPhrase(filterPhrase);
		if (f) {
			return { k: 'greatestStatAmong', filter: { ...f, zone }, stat };
		}
	}

	// "the total power/toughness/mana value of <filter>"
	const totalM = t.match(
		/^(?:the )?total (power|toughness|mana value) (?:of|among) (.+)$/i
	);
	if (totalM) {
		const statRaw = totalM[1].toLowerCase();
		const stat: 'power' | 'toughness' | 'manaValue' =
			statRaw === 'power' ? 'power' : statRaw === 'toughness' ? 'toughness' : 'manaValue';
		const f = parseExtendedObjectPhrase(totalM[2].trim());
		if (f) {
			return { k: 'totalStatAmong', filter: { ...f, zone: 'battlefield' }, stat };
		}
	}

	return null;
}

// ---- 3. P13 Verb Sentence Parsers -----------------------------------------------------------

export interface P13SentenceCallbacks {
	addTarget: (spec: TargetSpec) => number;
	subjectSelector: (phrase: string) => { sel: Selector; bind?: boolean } | null;
	playerSubject: (phrase: string) => Selector | null;
	validateEmblemAbility: (abilityText: string) => boolean;
	parseSubSteps: (clauseText: string) => EffectStep[] | null;
	parseAmount: (text: string) => Amount | null;
	parseDuration: (text: string) => { body: string; duration?: Duration };
}

/**
 * Parses Track P13 effect clauses (`createEmblem`, `createRoleToken`, `doubleOrTriple`, `exchange`,
 * `turnFace`, `chooseDesignation`, `grantGraveyardCast`, `ventureIntoDungeon`, `takeInitiative`,
 * `temptWithRing`, `earthbend`, `airbend`, `learn`, `villainousChoice`, `vote`).
 * Returns an array of `EffectStep`s when matched, or `null` to fall through.
 */
export type SpanlessEffectStep = Omit<EffectStep, 'span'>;

export function tryParseP13Sentence(
	rawText: string,
	cb: P13SentenceCallbacks
): SpanlessEffectStep[] | null {
	const text = rawText.trim().replace(/\.$/, '').trim();
	if (!text) return null;
	const low = text.toLowerCase();

	// 1. Emblems (CR 114):
	// "You get an emblem with \"...\"" / "Target opponent gets an emblem with \"...\"" / "Each opponent gets an emblem with \"...\""
	const emblemM = text.match(
		/^(you|target opponent|target player|each opponent)\s+gets?\s+an emblem with\s+(.+)$/i
	);
	if (emblemM) {
		const whoRaw = emblemM[1].toLowerCase();
		const quotedMatches = [...emblemM[2].matchAll(/[“"]([^”"]+)[”"]/g)].map((m) => m[1].trim());
		if (quotedMatches.length > 0 && quotedMatches.every((q) => cb.validateEmblemAbility(q))) {
			let subject: Selector = { k: 'none' };
			if (whoRaw === 'target opponent') {
				const idx = cb.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
				subject = { k: 'target', index: idx };
			} else if (whoRaw === 'target player') {
				const idx = cb.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
				subject = { k: 'target', index: idx };
			} else if (whoRaw === 'each opponent') {
				subject = { k: 'player', filter: { relation: 'each_opponent' } };
			}
			return [
				{
					verb: 'createEmblem',
					subject,
					params: { emblemAbilities: quotedMatches }
				}
			];
		}
		return null;
	}

	// 2. Role Aura tokens (CR 111.10k–r):
	// "Create a Wicked Role token attached to target creature you control"
	// "Create a Monster Role token attached to up to one target creature you control"
	const roleM = text.match(
		/^create a (cursed|monster|royal|sorcerer|virtuous|wicked|young hero) role token attached to (.+)$/i
	);
	if (roleM) {
		const roleKind = ROLE_KIND_MAP[roleM[1].toLowerCase()];
		const targetPhrase = roleM[2].trim();
		const sub = cb.subjectSelector(targetPhrase);
		if (roleKind && sub) {
			return [
				{
					verb: 'createRoleToken',
					subject: sub.sel,
					params: { roleKind },
					...(sub.bind ? { bindAs: 'it' } : {})
				}
			];
		}
		return null;
	}

	// 3. Dungeons, Initiative, The Ring Tempts You:
	if (
		low === 'venture into the dungeon' ||
		low === 'you venture into the dungeon'
	) {
		return [{ verb: 'ventureIntoDungeon', subject: { k: 'none' }, params: { dungeonKind: 'dungeon' } }];
	}
	if (
		low === 'venture into undercity' ||
		low === 'venture into the undercity' ||
		low === 'you venture into undercity'
	) {
		return [{ verb: 'ventureIntoDungeon', subject: { k: 'none' }, params: { dungeonKind: 'undercity' } }];
	}
	if (low === 'you take the initiative' || low === 'take the initiative') {
		return [{ verb: 'takeInitiative', subject: { k: 'none' } }];
	}
	if (low === 'the ring tempts you') {
		return [{ verb: 'temptWithRing', subject: { k: 'none' } }];
	}

	// 4. Learn (CR 701.48):
	if (low === 'learn' || low === 'you learn') {
		return [{ verb: 'learn', subject: { k: 'none' } }];
	}

	// 5. Earthbend N (CR 701.66):
	// "Earthbend 2" / "Earthbend X" (implicitly targets "target land you control")
	const earthbendM = text.match(/^earthbend\s+(\S+)$/i);
	if (earthbendM) {
		const amt = cb.parseAmount(earthbendM[1]);
		if (amt) {
			const idx = cb.addTarget({
				kind: 'object',
				filter: { types: ['Land'], controller: 'you', zone: 'battlefield' },
				min: 1,
				max: 1
			});
			return [
				{
					verb: 'earthbend',
					subject: { k: 'target', index: idx },
					amount: amt,
					bindAs: 'it'
				}
			];
		}
	}

	// 6. Airbend (CR 701.65):
	// "Airbend target nonland permanent" / "Airbend up to one target creature" / "Airbend target spell"
	const airbendM = text.match(/^airbend\s+(.+)$/i);
	if (airbendM) {
		const phrase = airbendM[1].trim();
		const upToOneSpell = phrase.match(/^(up to one )?target (noncreature |creature )?spell$/i);
		if (upToOneSpell) {
			const min = upToOneSpell[1] ? 0 : 1;
			const kindQual = upToOneSpell[2]?.trim().toLowerCase();
			const filter: ObjectFilter = {
				zone: 'stack',
				stackKind: 'spell',
				...(kindQual === 'noncreature'
					? { notTypes: ['Creature'] }
					: kindQual === 'creature'
						? { types: ['Creature'] }
						: {})
			};
			const idx = cb.addTarget({ kind: 'object', filter, min, max: 1 });
			return [{ verb: 'airbend', subject: { k: 'target', index: idx }, bindAs: 'it' }];
		}
		const sub = cb.subjectSelector(phrase);
		if (sub) {
			return [
				{
					verb: 'airbend',
					subject: sub.sel,
					...(sub.bind ? { bindAs: 'it' } : {})
				}
			];
		}
	}

	// 7. Turn Face Down / Face Up (CR 708):
	const turnFaceM = text.match(/^turn (.+?) face (down|up)$/i);
	if (turnFaceM) {
		const dir: 'up' | 'down' = turnFaceM[2].toLowerCase() === 'up' ? 'up' : 'down';
		const sub = cb.subjectSelector(turnFaceM[1].trim());
		if (sub) {
			return [
				{
					verb: 'turnFace',
					subject: sub.sel,
					params: { faceDirection: dir },
					...(sub.bind ? { bindAs: 'it' } : {})
				}
			];
		}
	}

	// 8. Choose a color / creature type / card name:
	if (low === 'choose a color') {
		return [{ verb: 'chooseDesignation', subject: { k: 'none' }, params: { chooseKind: 'color' } }];
	}
	if (low === 'choose a creature type') {
		return [
			{ verb: 'chooseDesignation', subject: { k: 'none' }, params: { chooseKind: 'creatureType' } }
		];
	}
	if (low === 'choose a card name') {
		return [
			{ verb: 'chooseDesignation', subject: { k: 'none' }, params: { chooseKind: 'cardName' } }
		];
	}
	if (low === 'choose a nonland card name') {
		return [
			{
				verb: 'chooseDesignation',
				subject: { k: 'none' },
				params: { chooseKind: 'nonlandCardName' }
			}
		];
	}

	// 9. Double / Triple (CR 701.10–11):
	const dblStep = tryParseDoubleOrTriple(text, cb);
	if (dblStep) return [dblStep];

	// 10. Exchange control / life totals / life & power/toughness (CR 701.12):
	const exStep = tryParseExchange(text, cb);
	if (exStep) return [exStep];

	// 11. Temporary Graveyard Cast / Flashback Grant:
	const gyGrant = tryParseGraveyardCastGrant(text, cb);
	if (gyGrant) return [gyGrant];

	// 12. Villainous Choice (CR 701.55):
	// "Each opponent faces a villainous choice — <optA>, or <optB>"
	// "Target opponent faces a villainous choice — <optA>, or <optB>"
	const villM = text.match(
		/^(each opponent|target opponent)\s+faces a villainous choice\s*(?:—|--|-)\s*(.+?),\s+or\s+(.+)$/i
	);
	if (villM) {
		const whoRaw = villM[1].toLowerCase();
		const labelA = villM[2].trim();
		const labelB = villM[3].trim();
		// Normalize "they draw a card" / "that player loses 3 life" -> eventPlayer actions where needed
		const normVillOpt = (s: string) =>
			s
				.replace(/^they\s+lose\s+/i, 'that player loses ')
				.replace(/^they\s+sacrifice\s+/i, 'that player sacrifices ')
				.replace(/^they\s+discard\s+/i, 'that player discards ')
				.replace(/^they\s+draw\s+/i, 'that player draws ');
		const stepsA = cb.parseSubSteps(normVillOpt(labelA));
		const stepsB = cb.parseSubSteps(normVillOpt(labelB));
		if (stepsA && stepsB && stepsA.length > 0 && stepsB.length > 0) {
			let subject: Selector = { k: 'none' };
			if (whoRaw === 'target opponent') {
				const idx = cb.addTarget({ kind: 'player', filter: {}, player: { relation: 'opponent' }, min: 1, max: 1 });
				subject = { k: 'target', index: idx };
			}
			return [
				{
					verb: 'villainousChoice',
					subject,
					params: {
						villainousOptions: [stepsA, stepsB],
						villainousOptionLabels: [labelA, labelB]
					}
				}
			];
		}
	}

	// 13. Council's Dilemma / Will of the Council Vote (CR 701.38):
	const voteStep = tryParseVote(text, cb);
	if (voteStep) return [voteStep];

	return null;
}

function tryParseDoubleOrTriple(text: string, cb: P13SentenceCallbacks): SpanlessEffectStep | null {
	const { body, duration } = cb.parseDuration(text);

	// A. "Double/Triple the power / toughness / power and toughness of <subject>"
	const ptOfM = body.match(
		/^(double|triple) the (power and toughness|power|toughness) of (.+)$/i
	);
	if (ptOfM) {
		const factor: 2 | 3 = ptOfM[1].toLowerCase() === 'triple' ? 3 : 2;
		const whatRaw = ptOfM[2].toLowerCase();
		const target: 'power' | 'toughness' | 'pt' =
			whatRaw === 'power and toughness' ? 'pt' : whatRaw === 'power' ? 'power' : 'toughness';
		const sub = cb.subjectSelector(ptOfM[3].trim());
		if (sub) {
			const doubleSpec: DoubleOrTripleSpec = {
				factor,
				target,
				duration: duration ?? 'endOfTurn'
			};
			return {
				verb: 'doubleOrTriple',
				subject: sub.sel,
				params: { doubleSpec },
				...(sub.bind ? { bindAs: 'it' } : {})
			};
		}
	}

	// B. "Double/Triple <possessive subject>'s power / toughness / power and toughness"
	const possPtM = body.match(
		/^(double|triple) (.+?)'s (power and toughness|power|toughness)$/i
	);
	if (possPtM) {
		const factor: 2 | 3 = possPtM[1].toLowerCase() === 'triple' ? 3 : 2;
		const whatRaw = possPtM[3].toLowerCase();
		const target: 'power' | 'toughness' | 'pt' =
			whatRaw === 'power and toughness' ? 'pt' : whatRaw === 'power' ? 'power' : 'toughness';
		const sub = cb.subjectSelector(possPtM[2].trim());
		if (sub) {
			const doubleSpec: DoubleOrTripleSpec = {
				factor,
				target,
				duration: duration ?? 'endOfTurn'
			};
			return {
				verb: 'doubleOrTriple',
				subject: sub.sel,
				params: { doubleSpec },
				...(sub.bind ? { bindAs: 'it' } : {})
			};
		}
	}

	// C. "Double the number of <counter> counters on <subject>" / "Double the number of each kind of counter on <subject>"
	const ctrM = text.match(
		/^(double|triple) the number of (each kind of|[+-−]\d+\/[+-−]\d+|first strike|double strike|[a-z]+) counters? on (.+)$/i
	);
	if (ctrM) {
		const factor: 2 | 3 = ctrM[1].toLowerCase() === 'triple' ? 3 : 2;
		const rawCtr = ctrM[2].toLowerCase().replace(/−/g, '-');
		const counter: CounterType | 'each' | undefined =
			rawCtr === 'each kind of' ? 'each' : COUNTERS[rawCtr];
		const sub = cb.subjectSelector(ctrM[3].trim());
		if (counter && sub) {
			return {
				verb: 'doubleOrTriple',
				subject: sub.sel,
				params: {
					doubleSpec: {
						factor,
						target: 'counters',
						counter
					}
				},
				...(sub.bind ? { bindAs: 'it' } : {})
			};
		}
	}

	// D. "Double your life total" / "Double target player's life total"
	const lifeM = text.match(/^(double|triple) (your|target player's|target opponent's) life total$/i);
	if (lifeM) {
		const factor: 2 | 3 = lifeM[1].toLowerCase() === 'triple' ? 3 : 2;
		const who = lifeM[2].toLowerCase();
		let subject: Selector;
		if (who === 'your') {
			subject = { k: 'player', filter: { relation: 'you' } };
		} else {
			const rel = who.includes('opponent') ? 'opponent' : 'any';
			const idx = cb.addTarget({ kind: 'player', filter: {}, player: { relation: rel }, min: 1, max: 1 });
			subject = { k: 'target', index: idx };
		}
		return {
			verb: 'doubleOrTriple',
			subject,
			params: { doubleSpec: { factor, target: 'life' } }
		};
	}

	return null;
}

function tryParseExchange(text: string, cb: P13SentenceCallbacks): SpanlessEffectStep | null {
	// A. "Exchange life totals with target player/opponent"
	const lifeWithM = text.match(/^exchange life totals with (target player|target opponent)$/i);
	if (lifeWithM) {
		const rel = lifeWithM[1].toLowerCase().includes('opponent') ? 'opponent' : 'any';
		const idx = cb.addTarget({ kind: 'player', filter: {}, player: { relation: rel }, min: 1, max: 1 });
		const exchangeSpec: ExchangeSpec = {
			kind: 'lifeTotals',
			second: { k: 'target', index: idx }
		};
		return {
			verb: 'exchange',
			subject: { k: 'player', filter: { relation: 'you' } },
			params: { exchangeSpec }
		};
	}

	// B. "Two target players exchange life totals"
	if (/^two target players exchange life totals$/i.test(text)) {
		const idx0 = cb.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		const idx1 = cb.addTarget({ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 });
		return {
			verb: 'exchange',
			subject: { k: 'target', index: idx0 },
			params: { exchangeSpec: { kind: 'lifeTotals', second: { k: 'target', index: idx1 } } }
		};
	}

	// C. "Exchange your life total with <subject>'s power/toughness"
	const lifeStatM = text.match(/^exchange your life total with (.+?)'s (power|toughness)$/i);
	if (lifeStatM) {
		const sub = cb.subjectSelector(lifeStatM[1].trim());
		if (sub) {
			const kind = lifeStatM[2].toLowerCase() === 'power' ? 'lifeAndPower' : 'lifeAndToughness';
			return {
				verb: 'exchange',
				subject: { k: 'player', filter: { relation: 'you' } },
				params: { exchangeSpec: { kind, second: sub.sel } }
			};
		}
	}

	// D. "Exchange control of two target <filter>"
	const twoTargetCtrl = text.match(/^exchange control of two target (.+)$/i);
	if (twoTargetCtrl) {
		const filter = parseExtendedObjectPhrase(twoTargetCtrl[1].trim());
		if (filter) {
			const bfFilter: ObjectFilter = { ...filter, zone: 'battlefield' };
			const idx0 = cb.addTarget({ kind: 'object', filter: bfFilter, min: 1, max: 1 });
			const idx1 = cb.addTarget({ kind: 'object', filter: bfFilter, min: 1, max: 1 });
			return {
				verb: 'exchange',
				subject: { k: 'target', index: idx0 },
				params: { exchangeSpec: { kind: 'control', second: { k: 'target', index: idx1 } } }
			};
		}
	}

	// E. "Exchange control of ~ and target <filter>" / "Exchange control of target <f1> and target <f2>"
	const pairCtrl = text.match(/^exchange control of (.+?) and (target .+|~)$/i);
	if (pairCtrl) {
		const subA = cb.subjectSelector(pairCtrl[1].trim());
		const subB = cb.subjectSelector(pairCtrl[2].trim());
		if (subA && subB) {
			return {
				verb: 'exchange',
				subject: subA.sel,
				params: { exchangeSpec: { kind: 'control', second: subB.sel } }
			};
		}
	}

	return null;
}

function tryParseGraveyardCastGrant(text: string, cb: P13SentenceCallbacks): SpanlessEffectStep | null {
	// A. "Target instant or sorcery card in your graveyard gains flashback until end of turn. The flashback cost is equal to its mana cost"
	// (Also handles single-sentence "Target <filter> card in your graveyard gains flashback until end of turn")
	const fbM = text.match(
		/^(target .+? in your graveyard|it|that card)\s+gains flashback until (end of turn|the end of your next turn)(?:\.\s*the flashback cost is equal to its mana cost)?$/i
	);
	if (fbM) {
		const sub = cb.subjectSelector(fbM[1].trim());
		if (sub) {
			const dur: 'thisTurn' | 'untilEndOfYourNextTurn' = fbM[2]
				.toLowerCase()
				.includes('next turn')
				? 'untilEndOfYourNextTurn'
				: 'thisTurn';
			const graveyardCastSpec: GraveyardCastGrantSpec = {
				duration: dur,
				flashbackEqualManaCost: true,
				exileIfWouldEnterGraveyard: true
			};
			return {
				verb: 'grantGraveyardCast',
				subject: sub.sel,
				params: { graveyardCastSpec },
				...(sub.bind ? { bindAs: 'it' } : {})
			};
		}
	}

	// B. "You may cast <target ... in/from your graveyard> this turn [without paying its mana cost]"
	// / "You may cast <that card | it> from your graveyard this turn [without paying its mana cost]"
	// Must explicitly mention `graveyard` so bare "You may play that card this turn" after exile
	// falls through cleanly to `grantPlayFromExile`.
	const castGyM = text.match(
		/^(?:until (end of turn|the end of your next turn),\s+)?you may (?:cast|play) (?:(target .+?)\s+(?:in|from) (your|a) graveyard|(that card|it)\s+from (?:your|a|that) graveyard)(?:\s+(this turn|until end of turn|until the end of your next turn))?(?:\s+(without paying its mana cost))?$/i
	);
	if (castGyM) {
		const durStr = (castGyM[1] ?? castGyM[5] ?? 'this turn').toLowerCase();
		const dur: 'thisTurn' | 'untilEndOfYourNextTurn' = durStr.includes('next turn')
			? 'untilEndOfYourNextTurn'
			: 'thisTurn';
		const free = Boolean(castGyM[6]);
		const subjPhrase = castGyM[2]
			? `${castGyM[2].trim()} in ${castGyM[3].toLowerCase()} graveyard`
			: castGyM[4].trim();
		const sub = cb.subjectSelector(subjPhrase);
		if (sub) {
			const graveyardCastSpec: GraveyardCastGrantSpec = {
				duration: dur,
				...(free ? { withoutPayingManaCost: true } : {})
			};
			return {
				verb: 'grantGraveyardCast',
				subject: sub.sel,
				params: { graveyardCastSpec },
				...(sub.bind ? { bindAs: 'it' } : {})
			};
		}
	}

	return null;
}

function tryParseVote(text: string, cb: P13SentenceCallbacks): SpanlessEffectStep | null {
	// Handles multi-sentence or semicolon-joined vote blocks when passed in, or single-sentence votes:
	// "Starting with you, each player votes for <opt1> or <opt2>"
	const m = text.match(
		/^starting with you,\s*each player votes for ([a-z]+)\s+or\s+([a-z]+)(?:\.\s*(.+))?$/i
	);
	if (!m) return null;
	const opt1 = m[1].toLowerCase();
	const opt2 = m[2].toLowerCase();
	const tail = m[3]?.trim();
	const voteSpec: VoteSpec = { options: [opt1, opt2] };
	if (!tail) {
		return { verb: 'vote', subject: { k: 'none' }, params: { voteSpec } };
	}

	// Parse follow-up sentences:
	// - Council's dilemma: "For each <opt1> vote, <effect1>. For each <opt2> vote, <effect2>"
	const dilemmaM = tail.match(
		new RegExp(
			`^for each ${opt1} vote,\\s*(.+?)\\.\\s*for each ${opt2} vote,\\s*(.+)$`,
			'i'
		)
	);
	if (dilemmaM) {
		const eff1 = cb.parseSubSteps(dilemmaM[1].trim());
		const eff2 = cb.parseSubSteps(dilemmaM[2].trim());
		if (eff1 && eff2) {
			voteSpec.perOptionEffect = [eff1, eff2];
			return { verb: 'vote', subject: { k: 'none' }, params: { voteSpec } };
		}
	}

	// - Will of the council: "If <opt1> gets more votes, <effect1>. If <opt2> gets more votes or the vote is tied, <effect2>"
	const councilM = tail.match(
		new RegExp(
			`^if ${opt1} gets more votes,\\s*(.+?)\\.\\s*if ${opt2} gets more votes(?: or the vote is tied)?,\\s*(.+)$`,
			'i'
		)
	);
	if (councilM) {
		const eff1 = cb.parseSubSteps(councilM[1].trim());
		const eff2 = cb.parseSubSteps(councilM[2].trim());
		if (eff1 && eff2) {
			voteSpec.perWinningEffect = [eff1, eff2];
			return { verb: 'vote', subject: { k: 'none' }, params: { voteSpec } };
		}
	}

	return null;
}

export { parseSmallNumber };
