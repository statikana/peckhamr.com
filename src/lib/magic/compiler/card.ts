/**
 * The card compiler (ENGINE_ARCHITECTURE_PLAN.md section 2.2; step F replaces the Phase 1 adapter).
 *
 * Turns a card's normalised rules text into the abilities of a FaceDefinition, using only the
 * grammars: keywords (here), triggers (compiler/triggers.ts), costs (compiler/costs.ts), effects
 * (compiler/effects.ts) and statics (compiler/statics.ts). No legacy parser is involved.
 *
 * An ability is `unsupported` exactly when the grammar left part of it unparsed or the IR
 * interpreter can't run what it produced (compiler/interpretable.ts). That makes this file, with
 * interpretable.ts, the single source of truth for "is this ability automated?": the deck builder
 * and inspector (compiler/support.ts) and the runtime (engine.ts) both read the result.
 *
 * Ability ids: activated abilities carry the id the runtime and UI use to name them
 * (`mana_tap` for the first "{T}: Add ..." ability, `loyalty_<line>`, `act_<line>`, and
 * `equip_<line>` on Equip keywords), where <line> is the index of the line in the printed text.
 */
import type {
	AbilityDef,
	ActivatedAbility,
	ActivationRestriction,
	Amount,
	Characteristics,
	Condition,
	CostDef,
	EffectStep,
	FaceDefinition,
	KeywordDef,
	ModalDef,
	ObjectFilter,
	PrototypeSpec,
	SpellAbility,
	Span,
	StaticDef,
	TargetSpec,
	Timing,
	TriggeredAbility,
	TriggerDef,
	UnsupportedAbility,
	UnsupportedReason
} from '../ir.ts';
import { getKeywordSpec, IMPLEMENTED_KEYWORDS, KNOWN_KEYWORDS } from '../keywords.ts';
import {
	andConditions,
	buildFadingAbilities,
	buildLevelRangeCondition,
	buildStationCounterCondition,
	buildVanishingAbilities,
	parseManaValueFromCostString,
	parsePrototypeColorsFromManaCost
} from '../runtime/striatedFrames.ts';
import { getCardFaces } from '../scryfall.ts';
import type { CardLayout, ManaColor, ScryfallCard, ScryfallCardFace, ZoneType } from '../types.ts';
import { parseAdditionalCostSentence, parseCost, parseCostModifierSentence, parseObjectPhrase } from './costs.ts';
import { extractUnparsedTargets, parseEffects, parseModal, parseSpellFace, type EffectParse } from './effects.ts';
import {
	SUPPORTED_OPTIONAL_COST_KINDS,
	staticallyInterpretable,
	triggerTargetsSupported
} from './interpretable.ts';
import { normalizeFace, splitSentences, type NormalizedFace, type NormalizedLine } from './normalize.ts';
import { canonicalKickerTag, parseActivatedIfConditionSentence } from './triggers.ts';
import { parseStaticAbility } from './statics.ts';
import { parseTriggerHeader, runtimeTriggerProblem } from './triggers.ts';

const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Elite', 'Host']);

const BASIC_LAND_MANA: Record<string, ManaColor> = {
	Plains: 'W',
	Island: 'U',
	Swamp: 'B',
	Mountain: 'R',
	Forest: 'G'
};

export { IMPLEMENTED_KEYWORDS };

// ---- Entry point ----------------------------------------------------------------------------

const SUPPORTED_MULTIFACE_LAYOUTS = new Set<CardLayout>(['split', 'modal_dfc', 'adventure', 'transform', 'flip']);

export function compileSingleFace(
	face: ScryfallCard | ScryfallCardFace,
	topCard?: ScryfallCard,
	layout?: CardLayout
): FaceDefinition {
	const characteristics = buildCharacteristicsForFace(face, topCard, layout);
	const norm = normalizeFace(face.name, face.oracleText);

	const cardManaValue =
		layout === 'split' && topCard?.faces && topCard.faces.length >= 2
			? topCard.faces.reduce((sum, f) => sum + parseManaValueFromCostString(f.manaCost), 0)
			: parseManaValueFromCostString(characteristics.manaCost);

	const isClass = characteristics.subtypes.includes('Class');
	const isCase = characteristics.subtypes.includes('Case');
	const hasAnyKickerLine = norm.lines.some((l) => /\b(?:multikicker|kicker)\b/i.test(l.body));
	const hasBargainKeyword =
		!hasAnyKickerLine &&
		norm.lines.some((l) => /^bargain$/i.test(l.body.trim()) || /(?:^|,\s*)bargain(?:\s*,|$)/i.test(l.body));
	const hasRenownKeyword =
		!norm.lines.some((l) => /\bmonstrosity\b/i.test(l.body)) &&
		norm.lines.some((l) => /(?:^|,\s*)renown\s+\d+(?:\s*,|$)/i.test(l.body));
	const hasDevourKeyword =
		!hasAnyKickerLine &&
		!norm.lines.some((l) => /\b(?:monstrosity|renown)\b/i.test(l.body)) &&
		norm.lines.some((l) => /(?:^|,\s*)devour\b/i.test(l.body));

	const ctx: Ctx = {
		isSpell: characteristics.types.includes('Instant') || characteristics.types.includes('Sorcery'),
		isPlaneswalker: characteristics.types.includes('Planeswalker'),
		isClass,
		isCase,
		hasBargainKeyword,
		hasRenownKeyword,
		hasDevourKeyword,
		manaTapTaken: false,
		hasReadAhead: false,
		cardManaValue
	};
	const abilities: AbilityDef[] = [];
	const spellLines: NormalizedLine[] = [];

	// CR 305.6: each basic land type grants "{T}: Add [mana]".
	if (characteristics.types.includes('Land')) {
		for (const typeName of characteristics.subtypes) {
			const color = BASIC_LAND_MANA[typeName];
			if (color) abilities.push(intrinsicManaAbility(ctx, color));
		}
	}

	const { baseLines, levelStriations, stationStriations, classStriations } = partitionStriatedLines(
		norm,
		isClass
	);

	for (const group of groupLines(baseLines)) {
		const line = group[0];
		const sagaOut = sagaChapterLine(group);
		if (sagaOut) {
			abilities.push(...sagaOut);
			continue;
		}
		if (ctx.isCase) {
			const solveOut = caseToSolveLine(group);
			if (solveOut) {
				abilities.push(...solveOut);
				continue;
			}
			const solvedOut = caseSolvedLine(ctx, group, norm.text);
			if (solvedOut) {
				abilities.push(...solvedOut);
				continue;
			}
		}
		if (ctx.isSpell && (isSpreeGroup(group) || isTieredGroup(group))) {
			spellLines.push(...group);
			continue;
		}
		const skipSpellDelayedTrigger =
			ctx.isSpell &&
			/^at (?:the beginning of (?:the next|that turn's)|(?:the )?end of combat)\b/i.test(line.body);
		const out =
			(group.length === 1 ? keywordLine(ctx, line) : null) ??
			(ctx.isSpell ? null : exertAttackLine(group)) ??
			(skipSpellDelayedTrigger ? null : triggerLine(ctx, group)) ??
			activatedLine(ctx, group);
		if (out) abilities.push(...out);
		else if (ctx.isSpell) {
			if (
				group.length === 1 &&
				!line.abilityWord &&
				!/[.!—]$/.test(line.body) &&
				!line.text.startsWith('•')
			) {
				abilities.push(unsupported('keyword_not_implemented', line.text, line.span, [line.span]));
			} else {
				spellLines.push(...group);
			}
		} else abilities.push(...staticGroup(ctx, group));
	}

	// CR 711.5: Leveler striations ("LEVEL N1-N2" / "LEVEL N3+").
	for (const st of levelStriations) {
		if (!st.pt) {
			abilities.push(unsupported('unparsed', st.headerText, st.headerSpan, [st.headerSpan]));
			continue;
		}
		const cond = buildLevelRangeCondition(st.min, st.max);
		if (st.pt.power !== null && st.pt.toughness !== null) {
			abilities.push({
				kind: 'static',
				static: {
					k: 'continuous',
					layer: '7b',
					affected: 'self',
					condition: cond,
					mod: {
						k: 'setBasePT',
						power: { k: 'const', n: st.pt.power },
						toughness: { k: 'const', n: st.pt.toughness }
					}
				},
				span: st.pt.span
			});
		}
		for (const innerGroup of groupLines(st.innerLines)) {
			for (const ab of compilePermanentGroup(ctx, innerGroup)) {
				abilities.push(...gateAbilityByStriationCondition(ab, cond, norm.text));
			}
		}
	}

	// CR 722.2: Station striations ("N+ | [abilities]" / "STATION N+").
	if (stationStriations.length > 0) {
		const isNonCreatureFace = !characteristics.types.includes('Creature');
		const printedPower = characteristics.power;
		const printedToughness = characteristics.toughness;
		const hasPrintedStationPT =
			isNonCreatureFace &&
			(printedPower !== undefined ||
				printedToughness !== undefined ||
				Boolean(characteristics.ptDefinedByAbility));
		const reminderThresholdMatch = face.oracleText.match(/\bcreature at (\d+)\+/i);
		const defaultCreatureThreshold = reminderThresholdMatch
			? parseInt(reminderThresholdMatch[1], 10)
			: Math.max(...stationStriations.map((s) => s.threshold));
		let animatedViaStation = false;

		for (const st of stationStriations) {
			const cond = buildStationCounterCondition(st.threshold);
			const explicitPT = st.explicitPT;
			const isImplicitCreatureTier =
				!explicitPT && hasPrintedStationPT && st.threshold === defaultCreatureThreshold;
			if (explicitPT || isImplicitCreatureTier) {
				animatedViaStation = true;
				abilities.push({
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '4',
						affected: 'self',
						condition: cond,
						mod: { k: 'addTypes', types: ['Artifact', 'Creature'] }
					},
					span: st.headerSpan
				});
				const p = explicitPT ? explicitPT.power : printedPower;
				const t = explicitPT ? explicitPT.toughness : printedToughness;
				if (p !== undefined && p !== null && t !== undefined && t !== null) {
					abilities.push({
						kind: 'static',
						static: {
							k: 'continuous',
							layer: '7b',
							affected: 'self',
							condition: cond,
							mod: {
								k: 'setBasePT',
								power: { k: 'const', n: p },
								toughness: { k: 'const', n: t }
							}
						},
						span: st.headerSpan
					});
				}
			}
			for (const innerGroup of groupLines(st.innerLines)) {
				for (const ab of compilePermanentGroup(ctx, innerGroup)) {
					abilities.push(...gateAbilityByStriationCondition(ab, cond, norm.text));
				}
			}
		}

		// CR 722.2c: Non-creature Station cards do not have printed power/toughness outside the station symbol.
		if (animatedViaStation && isNonCreatureFace) {
			delete characteristics.power;
			delete characteristics.toughness;
		}
	}

	// CR 717.2: Class striations ("{Cost}: Level N" followed by abilities active while level >= N).
	for (const st of classStriations) {
		const cost = parseCost(st.costText, st.costSpan.start);
		const costOk =
			cost.unparsed.length === 0 &&
			cost.defs.length > 0 &&
			cost.defs.every((d) => d.k !== 'mana' || !/\{X\}/i.test(d.cost));
		const levelId = `class_level_${st.level}`;
		const activateCond: Condition = { k: 'classLevelIs', level: st.level - 1 };
		if (!costOk) {
			abilities.push({
				...unsupported(
					'unparsed',
					st.headerText,
					st.headerSpan,
					cost.unparsed.length > 0 ? cost.unparsed : [st.costSpan]
				),
				id: levelId,
				cost: cost.defs,
				costComplete: false,
				timing: 'sorcery',
				isMana: false,
				activationCondition: activateCond
			});
		} else {
			abilities.push({
				kind: 'activated',
				id: levelId,
				cost: cost.defs,
				targets: [],
				effect: [],
				timing: 'sorcery',
				isMana: false,
				activationCondition: activateCond,
				text: st.headerText,
				span: st.headerSpan
			});
		}
		const gateCond: Condition = { k: 'classLevelAtLeast', level: st.level };
		for (const innerGroup of groupLines(st.innerLines)) {
			for (const ab of compilePermanentGroup(ctx, innerGroup)) {
				abilities.push(...gateAbilityByStriationCondition(ab, gateCond, norm.text));
			}
		}
	}

	if (spellLines.length > 0) abilities.push(...spellAbility(ctx, norm, spellLines));

	// CR 702.165b: Backup grants printed abilities below Backup on the card when targeting another creature.
	for (let idx = 0; idx < abilities.length; idx++) {
		const ab = abilities[idx];
		if (ab.kind === 'keyword' && ab.keyword.name === 'backup') {
			ab.keyword.backupAbilityStartIndex = idx + 1;
		}
	}

	let grantIdx = 0;
	for (const ab of abilities) {
		if (
			ab.kind === 'static' &&
			ab.static.k === 'continuous' &&
			ab.static.mod.k === 'grantAbility' &&
			ab.static.mod.ability.kind === 'activated'
		) {
			ab.static.mod.ability.id = `granted_${grantIdx++}`;
		}
	}

	return {
		name: face.name,
		characteristics,
		abilities,
		...(ctx.hasReadAhead ? { hasReadAhead: true } : {}),
		...(ctx.prototypeSpec ? { prototypeSpec: ctx.prototypeSpec } : {})
	};
}

export function compileFaces(card: ScryfallCard): FaceDefinition[] {
	const layout: CardLayout =
		card.layout ?? (card.backFace ? 'transform' : card.faces && card.faces.length >= 2 ? 'split' : 'normal');
	const candidateFaces = getCardFaces(card);
	const faces = candidateFaces.length >= 2 ? candidateFaces : null;

	if (faces && SUPPORTED_MULTIFACE_LAYOUTS.has(layout)) {
		return faces.map((f) => compileSingleFace(f, card, layout));
	}

	if (card.backFace || card.oracleText.includes('\n//\n') || (card.faces && card.faces.length > 1)) {
		const characteristics = buildCharacteristicsForFace(card, card, layout);
		const norm = normalizeFace(card.name, card.oracleText);
		const span = { start: 0, end: norm.text.length };
		return [{ name: card.name, characteristics, abilities: [unsupported('multiface', norm.text, span, [])] }];
	}

	return [compileSingleFace(card, card, layout)];
}

interface Ctx {
	isSpell: boolean;
	isPlaneswalker: boolean;
	isClass: boolean;
	isCase: boolean;
	hasBargainKeyword: boolean;
	hasRenownKeyword: boolean;
	hasDevourKeyword: boolean;
	/** The first "{T}: Add ..." ability gets the id `mana_tap`. */
	manaTapTaken: boolean;
	hasReadAhead: boolean;
	cardManaValue: number;
	prototypeSpec?: PrototypeSpec;
}

interface LevelStriation {
	min: number;
	max?: number;
	headerText: string;
	headerSpan: Span;
	pt: { power: number | null; toughness: number | null; span: Span } | null;
	innerLines: NormalizedLine[];
}

interface StationStriation {
	threshold: number;
	headerSpan: Span;
	explicitPT?: { power: number; toughness: number };
	innerLines: NormalizedLine[];
}

interface ClassStriation {
	level: number;
	costText: string;
	costSpan: Span;
	headerText: string;
	headerSpan: Span;
	innerLines: NormalizedLine[];
}

const LEVEL_HEADER_RE = /^LEVEL\s+(\d+)(?:\s*[—–-]\s*(\d+)|\+)(?:\s*(?:\|\s*)?(-?\d+|\*)\/(-?\d+|\*))?$/i;
const STATION_HEADER_RE = /^(?:STATION\s+(\d+)\+(?:\s*\|\s*(.*))?|(\d+)\+\s*\|\s*(.*))$/i;
const CLASS_HEADER_RE = /^(.+?):\s*Level\s+(\d+)\s*$/i;
const STANDALONE_PT_RE = /^\[?(-?\d+|\*)\/(-?\d+|\*)\]?$/;

function parsePTPair(pRaw: string, tRaw: string): { power: number | null; toughness: number | null } {
	return {
		power: /^-?\d+$/.test(pRaw) ? parseInt(pRaw, 10) : null,
		toughness: /^-?\d+$/.test(tRaw) ? parseInt(tRaw, 10) : null
	};
}

function partitionStriatedLines(
	norm: NormalizedFace,
	isClass: boolean
): {
	baseLines: NormalizedLine[];
	levelStriations: LevelStriation[];
	stationStriations: StationStriation[];
	classStriations: ClassStriation[];
} {
	const baseLines: NormalizedLine[] = [];
	const levelStriations: LevelStriation[] = [];
	const stationStriations: StationStriation[] = [];
	const classStriations: ClassStriation[] = [];
	const hasStation = norm.lines.some(
		(l) => /^station$/i.test(l.body.trim()) || /^STATION\s+\d+\+/i.test(l.text.trim())
	);

	const total = norm.lines.length;
	for (let i = 0; i < total; ) {
		const line = norm.lines[i];
		if (isClass) {
			const classMatch = line.text.trim().match(CLASS_HEADER_RE);
			const parsedLevel = classMatch ? parseInt(classMatch[2], 10) : 0;
			if (classMatch && parsedLevel >= 2) {
				const rawCostPart = classMatch[1];
				const leadTrim = line.text.indexOf(rawCostPart);
				const costStart = leadTrim >= 0 ? line.span.start + leadTrim : line.span.start;
				const costText = rawCostPart.trim();
				const costSpan: Span = { start: costStart, end: costStart + costText.length };
				const innerLines: NormalizedLine[] = [];
				i++;
				for (; i < total; i++) {
					const cand = norm.lines[i];
					const nextClass = cand.text.trim().match(CLASS_HEADER_RE);
					if (nextClass && parseInt(nextClass[2], 10) >= 2) break;
					innerLines.push(cand);
				}
				classStriations.push({
					level: parsedLevel,
					costText,
					costSpan,
					headerText: line.text,
					headerSpan: line.span,
					innerLines
				});
				continue;
			}
		}

		const levelMatch = line.text.trim().match(LEVEL_HEADER_RE);
		if (levelMatch) {
			const min = parseInt(levelMatch[1], 10);
			const max = levelMatch[2] !== undefined ? parseInt(levelMatch[2], 10) : undefined;
			let pt: LevelStriation['pt'] = null;
			if (levelMatch[3] !== undefined && levelMatch[4] !== undefined) {
				pt = { ...parsePTPair(levelMatch[3], levelMatch[4]), span: line.span };
			} else if (i + 1 < total) {
				const nextPt = norm.lines[i + 1].text.trim().match(STANDALONE_PT_RE);
				if (nextPt) {
					pt = { ...parsePTPair(nextPt[1], nextPt[2]), span: norm.lines[i + 1].span };
					i++;
				}
			}
			const innerLines: NormalizedLine[] = [];
			i++;
			for (; i < total; i++) {
				const cand = norm.lines[i];
				if (LEVEL_HEADER_RE.test(cand.text.trim())) break;
				if (hasStation && STATION_HEADER_RE.test(cand.text.trim())) break;
				innerLines.push(cand);
			}
			levelStriations.push({
				min,
				max,
				headerText: line.text,
				headerSpan: line.span,
				pt,
				innerLines
			});
			continue;
		}

		const stationMatch = hasStation ? line.text.trim().match(STATION_HEADER_RE) : null;
		if (stationMatch) {
			const threshold = parseInt(stationMatch[1] ?? stationMatch[3], 10);
			let explicitPT: StationStriation['explicitPT'];
			const innerLines: NormalizedLine[] = [];

			const pipeIdx = line.text.indexOf('|');
			if (pipeIdx >= 0) {
				let afterPipe = line.text.slice(pipeIdx + 1);
				const leadSpaces = afterPipe.length - afterPipe.trimStart().length;
				afterPipe = afterPipe.trimStart();
				const bodyStart = line.span.start + pipeIdx + 1 + leadSpaces;
				const trailingBracketPT = afterPipe.match(/\s*\[(-?\d+)\/(-?\d+)\]\s*$/);
				if (trailingBracketPT) {
					explicitPT = {
						power: parseInt(trailingBracketPT[1], 10),
						toughness: parseInt(trailingBracketPT[2], 10)
					};
					afterPipe = afterPipe.slice(0, afterPipe.length - trailingBracketPT[0].length);
				}
				const trimmedRight = afterPipe.trimEnd();
				if (trimmedRight.length > 0) {
					const subSpan: Span = { start: bodyStart, end: bodyStart + trimmedRight.length };
					innerLines.push({
						rawIndex: line.rawIndex,
						raw: line.raw,
						text: trimmedRight,
						span: subSpan,
						body: trimmedRight,
						bodySpan: subSpan,
						sentences: splitSentences(trimmedRight, bodyStart)
					});
				}
			}

			i++;
			for (; i < total; i++) {
				const cand = norm.lines[i];
				if (STATION_HEADER_RE.test(cand.text.trim()) || LEVEL_HEADER_RE.test(cand.text.trim())) {
					break;
				}
				const ptLine = cand.text.trim().match(/^\[?(-?\d+)\/(-?\d+)\]?$/);
				if (ptLine && !explicitPT) {
					explicitPT = { power: parseInt(ptLine[1], 10), toughness: parseInt(ptLine[2], 10) };
				} else {
					innerLines.push(cand);
				}
			}

			stationStriations.push({
				threshold,
				headerSpan: line.span,
				...(explicitPT ? { explicitPT } : {}),
				innerLines
			});
			continue;
		}

		baseLines.push(line);
		i++;
	}

	return { baseLines, levelStriations, stationStriations, classStriations };
}

function compilePermanentGroup(ctx: Ctx, group: NormalizedLine[]): AbilityDef[] {
	const line = group[0];
	const sagaOut = sagaChapterLine(group);
	if (sagaOut) return sagaOut;
	return (
		(group.length === 1 ? keywordLine(ctx, line) : null) ??
		triggerLine(ctx, group) ??
		activatedLine(ctx, group) ??
		staticGroup(ctx, group)
	);
}

function gateAbilityByStriationCondition(
	ab: AbilityDef,
	cond: Condition,
	normText: string
): AbilityDef[] {
	if (ab.kind === 'keyword') {
		const kw = ab.keyword;
		const spec = getKeywordSpec(kw.name);
		if (spec?.displayLabel && !kw.param && kw.cost === undefined && kw.n === undefined) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						condition: cond,
						mod: { k: 'addKeywords', keywords: [kw.name] }
					},
					span: ab.span
				}
			];
		}
		if (kw.name === 'hexproof' && kw.param) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						condition: cond,
						mod: { k: 'addKeywords', keywords: [`hexproof from ${kw.param.toLowerCase()}`] }
					},
					span: ab.span
				}
			];
		}
		if (kw.name === 'protection' && kw.param) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						condition: cond,
						mod: { k: 'addKeywords', keywords: [`protection from ${kw.param.toLowerCase()}`] }
					},
					span: ab.span
				}
			];
		}
		if (kw.name === 'ward' && (kw.cost || kw.param)) {
			const wardStr = kw.cost ? `Ward ${kw.cost}` : `Ward—${kw.param}`;
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						condition: cond,
						mod: { k: 'addKeywords', keywords: [wardStr] }
					},
					span: ab.span
				}
			];
		}
		if (
			(kw.name === 'toxic' ||
				kw.name === 'afflict' ||
				kw.name === 'firebending' ||
				kw.name === 'mobilize' ||
				kw.name === 'rampage' ||
				kw.name === 'renown') &&
			kw.n !== undefined
		) {
			return [
				{
					kind: 'static',
					static: {
						k: 'continuous',
						layer: '6',
						affected: 'self',
						condition: cond,
						mod: { k: 'addKeywords', keywords: [`${kw.name} ${kw.n}`] }
					},
					span: ab.span
				}
			];
		}
		if (spec?.status === 'implemented' && spec.implementation?.kind === 'static') {
			const statics = spec.implementation.buildStatics(kw);
			if (statics.length > 0) {
				return statics.map((st) => ({
					kind: 'static' as const,
					static: { ...st, condition: andConditions(st.condition, cond) },
					span: ab.span
				}));
			}
		}
		if (
			spec?.status === 'implemented' &&
			spec.implementation?.kind === 'activated' &&
			spec.implementation.buildActivated
		) {
			const built = spec.implementation.buildActivated(kw, ab.id ?? `act_${ab.span.start}`, ab.span);
			if (built) {
				return [
					{
						...built.ability,
						grantCondition: andConditions(built.ability.grantCondition, cond)
					}
				];
			}
		}
		if (spec?.status === 'implemented' && spec.implementation?.kind === 'trigger') {
			const rts = spec.implementation.buildTriggers(kw, 0, ab.span);
			if (rts.length > 0 && rts.every((rt) => rt.effect)) {
				return rts.map(
					(rt): TriggeredAbility => ({
						kind: 'triggered',
						trigger: rt.trigger,
						...(rt.condition ? { condition: rt.condition } : {}),
						grantCondition: cond,
						targets: rt.effect!.targets,
						effect: rt.effect!.steps,
						...(rt.effect!.modal ? { modal: rt.effect!.modal } : {}),
						text: rt.text,
						span: ab.span
					})
				);
			}
		}
		return [
			unsupported('static_not_compiled', normText.slice(ab.span.start, ab.span.end), ab.span, [ab.span])
		];
	}
	if (ab.kind === 'static') {
		return [{ ...ab, static: { ...ab.static, condition: andConditions(ab.static.condition, cond) } }];
	}
	if (ab.kind === 'replacement') {
		return [
			{
				...ab,
				replacement: { ...ab.replacement, condition: andConditions(ab.replacement.condition, cond) }
			}
		];
	}
	if (ab.kind === 'triggered' || ab.kind === 'activated' || ab.kind === 'unsupported') {
		return [{ ...ab, grantCondition: andConditions(ab.grantCondition, cond) }];
	}
	return [ab];
}

// ---- Grouping -------------------------------------------------------------------------------

/** A modal header and its bullet lines (or Spree header and its `+ ` mode lines) form one ability. */
function groupLines(lines: NormalizedLine[]): NormalizedLine[][] {
	const groups: NormalizedLine[][] = [];
	for (const line of lines) {
		const prev = groups[groups.length - 1];
		if (prev && line.text.startsWith('•')) prev.push(line);
		else if (prev && /^spree$/i.test(prev[0].body.trim()) && /^\+\s+/.test(line.text.trim())) prev.push(line);
		else groups.push([line]);
	}
	return groups;
}

function groupSpan(group: NormalizedLine[]): Span {
	return { start: group[0].span.start, end: group[group.length - 1].span.end };
}

// ---- Keywords -------------------------------------------------------------------------------

const MANA_COLOR_NAMES: Record<string, string> = {
	W: 'white',
	U: 'blue',
	B: 'black',
	R: 'red',
	G: 'green'
};

function kickerTagsForEntry(rawEntry: string, defs: CostDef[]): string[] {
	const tags: string[] = [canonicalKickerTag(rawEntry)];
	const colors = new Set<string>();
	for (const def of defs) {
		if (def.k !== 'mana') continue;
		for (const sym of def.cost.matchAll(/\{([^}]+)\}/g)) {
			const inner = sym[1].toUpperCase();
			for (const ch of inner) {
				if (ch in MANA_COLOR_NAMES) colors.add(ch);
			}
		}
	}
	if (colors.size === 1) {
		const only = colors.values().next().value!;
		const colorName = MANA_COLOR_NAMES[only];
		if (colorName && !tags.includes(colorName)) tags.push(colorName);
	}
	return tags;
}

function formatCyclingDesc(rawQuality: string, filter: ObjectFilter): string {
	const subtypeSet = new Set((filter.subtypes ?? []).map((s) => s.toLowerCase()));
	return rawQuality
		.trim()
		.split(/\s+/)
		.map((w) => (subtypeSet.has(w.toLowerCase()) ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()))
		.join(' ');
}

const COST_SYM_COUNT_WORDS: Readonly<Record<string, number>> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10
};

function normalizeKeywordCostText(raw: string): string {
	const trimmed = raw.trim();
	const payMultiSym = trimmed.match(
		/^pay\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(\{[WUBRGC]\})$/i
	);
	if (payMultiSym) {
		const countRaw = payMultiSym[1].toLowerCase();
		const n = /^\d+$/.test(countRaw) ? parseInt(countRaw, 10) : COST_SYM_COUNT_WORDS[countRaw];
		if (n && n > 0 && n <= 20) {
			return payMultiSym[2].toUpperCase().repeat(n);
		}
	}
	const manaOrMana = trimmed.match(/^((?:\{[^}]+\})+)\s+or\s+((?:\{[^}]+\})+)$/i);
	if (manaOrMana) {
		return `pay ${manaOrMana[1]} or pay ${manaOrMana[2]}`;
	}
	const manaOrOther = trimmed.match(/^((?:\{[^}]+\})+)\s+or\s+(.+)$/i);
	if (manaOrOther) {
		return `pay ${manaOrOther[1]} or ${manaOrOther[2]}`;
	}
	return trimmed;
}

function isCastPayableCostDef(d: CostDef): boolean {
	switch (d.k) {
		case 'mana':
		case 'payLife':
		case 'payEnergy':
		case 'tapSubsetSum':
			return true;
		case 'sacrifice':
		case 'discard':
		case 'tapOthers':
		case 'returnToHand':
		case 'revealFromHand':
			return d.filter !== 'self';
		case 'exileFrom':
			return (
				d.filter !== 'self' &&
				(d.zone === 'graveyard' || d.zone === 'hand' || d.zone === 'battlefield')
			);
		case 'choice':
			return d.options.length > 0 && d.options.every((opt) => opt.length > 0 && opt.every(isCastPayableCostDef));
		case 'optional':
			return d.cost.length > 0 && d.cost.every(isCastPayableCostDef);
		default:
			return (d as { k: string }).k === 'mill';
	}
}

function isWardPayableCostDef(d: CostDef): boolean {
	switch (d.k) {
		case 'mana':
			return !/\{X\}/i.test(d.cost);
		case 'payLife':
			return d.amount.k === 'const';
		case 'payEnergy':
			return d.count.k === 'const';
		case 'tapSubsetSum':
			return d.minTotal.k === 'const' && !d.excludeSelf;
		case 'sacrifice':
		case 'discard':
		case 'tapOthers':
		case 'returnToHand':
		case 'revealFromHand':
			return d.count.k === 'const' && d.filter !== 'self';
		case 'exileFrom':
			return (
				d.count.k === 'const' &&
				d.filter !== 'self' &&
				(d.zone === 'graveyard' || d.zone === 'hand' || d.zone === 'battlefield')
			);
		case 'choice':
			return d.options.length > 0 && d.options.every((opt) => opt.length > 0 && opt.every(isWardPayableCostDef));
		default: {
			const extra = d as { k: string; count?: Amount };
			return extra.k === 'mill' && extra.count?.k === 'const';
		}
	}
}

function isEquipPayableCostDef(d: CostDef): boolean {
	switch (d.k) {
		case 'mana':
			return !/\{X\}/i.test(d.cost);
		case 'tapSelf':
		case 'untapSelf':
		case 'exertSelf':
		case 'payLife':
		case 'payEnergy':
		case 'tapSubsetSum':
		case 'sacrifice':
		case 'returnToHand':
			return true;
		case 'removeCounters':
			return d.from === 'self';
		case 'discard':
		case 'tapOthers':
		case 'revealFromHand':
			return d.filter !== 'self';
		case 'exileFrom':
			return d.zone === 'graveyard' || d.zone === 'hand' || d.zone === 'battlefield';
		case 'choice':
			return d.options.length > 0 && d.options.every((opt) => opt.length > 0 && opt.every(isEquipPayableCostDef));
		default:
			return (d as { k: string }).k === 'mill';
	}
}

function parseEquipQualityPhrase(
	rawPhrase: string
): { equipFilter: ObjectFilter; equipAllowPlaneswalker?: boolean } | null {
	const phrase = rawPhrase.trim();
	if (!phrase) return null;
	if (/^planeswalkers?$/i.test(phrase)) {
		return { equipFilter: { types: ['Planeswalker'] }, equipAllowPlaneswalker: true };
	}
	if (/^creatures?\s+or\s+planeswalkers?$/i.test(phrase)) {
		return { equipFilter: { types: ['Creature', 'Planeswalker'] }, equipAllowPlaneswalker: true };
	}
	if (/^creature\s+tokens?$/i.test(phrase) || /^token\s+creatures?$/i.test(phrase)) {
		return { equipFilter: { token: true } };
	}
	if (/\bor\b/i.test(phrase)) {
		const subParts = phrase
			.replace(/\s+creature$/i, '')
			.split(/,\s*or\s+|\s+or\s+|,\s*/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (subParts.length >= 2) {
			const parsedParts = subParts.map((sp) => parseObjectPhrase(sp));
			if (
				parsedParts.every(
					(pf) =>
						pf !== null &&
						pf.subtypes &&
						pf.subtypes.length > 0 &&
						!pf.types &&
						!pf.supertypes &&
						!pf.colors
				)
			) {
				return {
					equipFilter: {
						subtypes: parsedParts.flatMap((pf) => pf!.subtypes!)
					}
				};
			}
		}
	}
	const parsed = parseObjectPhrase(phrase);
	if (!parsed) return null;
	const filter: ObjectFilter = { ...parsed };
	const allowsPw = Boolean(filter.types?.includes('Planeswalker'));
	if (filter.types && filter.types.length === 1 && filter.types[0] === 'Creature') {
		delete filter.types;
	}
	return {
		equipFilter: filter,
		...(allowsPw ? { equipAllowPlaneswalker: true } : {})
	};
}

const COLOR_WORD_TO_MANA: Record<string, ManaColor> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G'
};

function parseMultiOrObjectPhrase(phrase: string): ObjectFilter | null {
	const direct = parseObjectPhrase(phrase);
	if (direct) return direct;
	if (!/\bor\b/i.test(phrase)) return null;
	const colorDisj = phrase.match(
		/^((?:white|blue|black|red|green)(?:\s*,\s*(?:white|blue|black|red|green))*\s*,?\s+or\s+(?:white|blue|black|red|green))\s+(.+)$/i
	);
	if (colorDisj) {
		const colorWords = colorDisj[1]
			.split(/,\s*or\s+|\s+or\s+|,\s*/i)
			.map((w) => COLOR_WORD_TO_MANA[w.trim().toLowerCase()])
			.filter(Boolean);
		const tailFilter = parseMultiOrObjectPhrase(colorDisj[2].trim());
		if (tailFilter && !tailFilter.colors && !tailFilter.anyOf && colorWords.length >= 2) {
			return { ...tailFilter, colors: [...new Set(colorWords)] };
		}
	}
	const parts = phrase
		.split(/,\s*or\s+|\s+or\s+|,\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const parsed = parts.map((p) => parseObjectPhrase(p));
	if (parsed.some((p) => !p)) return null;
	const nonNull = parsed as ObjectFilter[];
	const allPureTypes = nonNull.every(
		(f) =>
			f.types &&
			f.types.length > 0 &&
			!f.subtypes &&
			!f.supertypes &&
			!f.colors &&
			!f.notTypes &&
			!f.notSubtypes &&
			f.token === undefined &&
			f.tapped === undefined
	);
	if (allPureTypes) {
		return { types: [...new Set(nonNull.flatMap((f) => f.types!))] };
	}
	const allPureSubtypes = nonNull.every(
		(f) =>
			f.subtypes &&
			f.subtypes.length > 0 &&
			!f.types &&
			!f.supertypes &&
			!f.colors &&
			!f.notTypes &&
			!f.notSubtypes &&
			f.token === undefined &&
			f.tapped === undefined
	);
	if (allPureSubtypes) {
		return { subtypes: [...new Set(nonNull.flatMap((f) => f.subtypes!))] };
	}
	return { anyOf: nonNull };
}

function parseEnchantPhrase(rawParam: string): ObjectFilter | null {
	let phrase = rawParam.trim();
	if (!phrase || /\bgraveyard\b/i.test(phrase)) return null;
	let controller: ObjectFilter['controller'];
	let other: boolean | undefined;
	let tapped: boolean | undefined;

	if (/\s+you\s+control$/i.test(phrase)) {
		controller = 'you';
		phrase = phrase.replace(/\s+you\s+control$/i, '').trim();
	} else if (/\s+(?:an\s+opponent\s+controls|you\s+don't\s+control)$/i.test(phrase)) {
		controller = 'opponent';
		phrase = phrase.replace(/\s+(?:an\s+opponent\s+controls|you\s+don't\s+control)$/i, '').trim();
	}
	if (/^another\s+/i.test(phrase)) {
		other = true;
		phrase = phrase.replace(/^another\s+/i, '').trim();
	}
	if (/^tapped\s+/i.test(phrase)) {
		tapped = true;
		phrase = phrase.replace(/^tapped\s+/i, '').trim();
	} else if (/^untapped\s+/i.test(phrase)) {
		tapped = false;
		phrase = phrase.replace(/^untapped\s+/i, '').trim();
	}

	const base = parseMultiOrObjectPhrase(phrase);
	if (!base) return null;
	return {
		...base,
		...(controller ? { controller } : {}),
		...(other ? { other: true } : {}),
		...(tapped !== undefined ? { tapped } : {})
	};
}

function parseKeyword(part: string): KeywordDef | null {
	const low = part.toLowerCase();
	for (const kw of KNOWN_KEYWORDS) {
		if (low === kw) return { name: kw };
		if (!low.startsWith(kw)) continue;
		const rest = part.slice(kw.length);
		if (!/^[\s—-]/.test(rest)) continue;
		const rawArg = rest.replace(/^\s*[—-]?\s*/, '').trim();
		const arg =
			kw === 'ward' ||
			kw === 'equip' ||
			kw === 'flashback' ||
			kw === 'kicker' ||
			kw === 'multikicker' ||
			kw === 'morph' ||
			kw === 'megamorph' ||
			kw === 'disguise' ||
			kw === 'unearth' ||
			kw === 'buyback' ||
			kw === 'evoke' ||
			kw === 'escape' ||
			kw === 'foretell' ||
			kw === 'plot' ||
			kw === 'entwine' ||
			kw === 'disturb' ||
			kw === 'blitz' ||
			kw === 'cumulative upkeep' ||
			kw === 'cycling' ||
			kw === 'basic landcycling' ||
			kw === 'landcycling' ||
			kw === 'offspring' ||
			kw === 'squad' ||
			kw === 'replicate' ||
			kw === 'warp' ||
			kw === 'transmute' ||
			kw === 'level up' ||
			kw === 'reinforce' ||
			kw === 'prototype' ||
			kw === 'echo' ||
			kw === 'madness' ||
			kw === 'dash' ||
			kw === 'ninjutsu' ||
			kw === 'commander ninjutsu' ||
			kw === 'scavenge' ||
			kw === 'outlast' ||
			kw === 'embalm' ||
			kw === 'eternalize' ||
			kw === 'encore' ||
			kw === 'bestow' ||
			kw === 'escalate' ||
			kw === 'recover' ||
			kw === 'harmonize' ||
			kw === 'miracle' ||
			kw === 'spectacle' ||
			kw === 'surge' ||
			kw === 'awaken' ||
			kw === 'emerge' ||
			kw === 'devour' ||
			kw === 'sneak' ||
			kw === 'beam me up' ||
			kw === 'mayhem' ||
			kw === 'web-slinging'
				? rawArg.replace(/\.$/, '').trim()
				: rawArg;
		if (kw === 'prototype') {
			const protoMatch = arg.match(/^((?:\{[^}]+\})+)\s*[—–-]\s*(-?\d+)\/(-?\d+)$/);
			if (protoMatch && !/\{X\}/i.test(protoMatch[1])) {
				const manaCost = protoMatch[1];
				return {
					name: 'prototype',
					cost: manaCost,
					prototypeSpec: {
						manaCost,
						colors: parsePrototypeColorsFromManaCost(manaCost),
						power: parseInt(protoMatch[2], 10),
						toughness: parseInt(protoMatch[3], 10)
					}
				};
			}
		}
		if (kw === 'reinforce') {
			const reinfMatch = arg.match(/^(\d+)\s*[—–-]\s*(.+)$/);
			if (reinfMatch) {
				const n = parseInt(reinfMatch[1], 10);
				const costPart = reinfMatch[2].trim();
				if (/^(\{[^}]+\})+$/.test(costPart)) return { name: 'reinforce', n, cost: costPart };
				return { name: 'reinforce', n, param: costPart };
			}
		}
		if (/^(\{[^}]+\})+$/.test(arg)) return { name: kw, cost: arg };
		if (/^\d+$/.test(arg)) return { name: kw, n: parseInt(arg, 10) };
		const nCost = arg.match(/^(\d+)\s*[—–-]\s*((?:\{[^}]+\})+)$/);
		if (nCost) return { name: kw, n: parseInt(nCost[1], 10), cost: nCost[2] };
		if (/^from\b/i.test(arg) || kw === 'enchant' || kw === 'protection') {
			return { name: kw, param: arg.replace(/^from\s+/i, '') };
		}
		if (arg && !arg.endsWith('.')) return { name: kw, param: arg };
	}
	// Typecycling (CR 702.29e): "[Quality]cycling [cost]" or "[Quality]cycling—[cost]."
	const typecycling = part.match(/^(.+?cycling)(?=[\s—-])([\s\S]+)$/i);
	if (typecycling) {
		const head = typecycling[1].trim();
		const rest = typecycling[2];
		const quality = head.slice(0, -'cycling'.length).trim();
		if (!quality || !/^[a-z][a-z -]*$/i.test(quality)) return null;
		const arg = rest.replace(/^\s*[—-]?\s*/, '').replace(/\.$/, '').trim();
		if (!arg) return null;
		const filter =
			/^(?:type|a|an|the|any|each|another|other|all|target)$/i.test(quality)
				? null
				: (parseObjectPhrase(quality) ??
					parseObjectPhrase(quality.replace(/\b[a-z]/g, (c) => c.toUpperCase())));
		if (!filter) {
			return { name: 'typecycling', param: arg };
		}
		const isManaOnly = /^(\{[^}]+\})+$/.test(arg);
		return {
			name: 'typecycling',
			...(isManaOnly ? { cost: arg } : { param: arg }),
			cyclingFilter: filter,
			cyclingDesc: formatCyclingDesc(quality, filter)
		};
	}
	return null;
}

function parseAffinityQuality(phrase: string): ObjectFilter | null {
	if (/^outlaws?$/i.test(phrase)) {
		// CR 700.12a: Assassins, Mercenaries, Pirates, Rogues, and Warlocks are outlaws.
		return { subtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'] };
	}
	if (/^historic$/i.test(phrase)) {
		// CR 700.6: Artifacts, legendaries, and Sagas are historic.
		return {
			anyOf: [{ types: ['Artifact'] }, { supertypes: ['Legendary'] }, { subtypes: ['Saga'] }]
		};
	}
	return parseObjectPhrase(phrase);
}

/** "Flying, vigilance", "Equip {2}", "Protection from black". A trailing period means an effect. */
function keywordLine(ctx: Ctx, line: NormalizedLine): AbilityDef[] | null {
	if (
		line.abilityWord ||
		(/\.$/.test(line.body) &&
			!/^(?:ward|equip(?:\s+[a-z][a-z ,'-]*?)?|flashback|kicker|multikicker|morph|megamorph|disguise|unearth|buyback|evoke|escape|foretell|plot|entwine|disturb|blitz|cumulative upkeep|offspring|squad|replicate|warp|transmute|level up|reinforce(?:\s+\d+)?|echo|madness|dash|commander ninjutsu|ninjutsu|scavenge|outlast|embalm|eternalize|encore|bestow|escalate|recover|harmonize|miracle|spectacle|surge|awaken(?:\s+\d+)?|emerge|sneak|beam me up|mayhem|web-slinging|cycling|(?:[a-z][a-z -]*\s+)?[a-z]*cycling)\s*[—–-]/i.test(
				line.body
			))
	) {
		return null;
	}
	// "Enchant creature, land, or planeswalker", "Protection from white, from blue", and composite
	// dash costs ("Ward—...", "Flashback—...", "Kicker—...", "Morph—...", "Cycling—...", "Escape—...") are one keyword.
	const parts =
		/^(?:enchant|protection from|hexproof from|partner with|prototype\b|devour\s+x\b|equip\s+[a-z][a-z '-]*,\s*[a-z]|(?:ward|equip(?:\s+[a-z][a-z ,'-]*?)?|flashback|kicker|multikicker|morph|megamorph|disguise|unearth|buyback|evoke|escape|foretell|plot|entwine|disturb|blitz|cumulative upkeep|offspring|squad|replicate|warp|transmute|level up|reinforce(?:\s+\d+)?|echo|madness|dash|commander ninjutsu|ninjutsu|scavenge|outlast|embalm|eternalize|encore|bestow|escalate|recover|harmonize|miracle|spectacle|surge|awaken(?:\s+\d+)?|emerge|sneak|beam me up|mayhem|web-slinging|cycling|(?:[a-z][a-z -]*\s+)?[a-z]*cycling)\s*[—–-])/i.test(
			line.body
		)
			? [line.body]
			: line.body.split(/,\s*/);
	const keywords = parts.map(parseKeyword);
	if (keywords.some((k) => !k)) return null;

	const out: AbilityDef[] = [];
	let cursor = line.bodySpan.start;
	parts.forEach((part, i) => {
		const start = line.text.indexOf(part, cursor - line.span.start) + line.span.start;
		const span = { start, end: start + part.length };
		cursor = span.end;
		const keyword = keywords[i]!;
		let implemented = IMPLEMENTED_KEYWORDS.has(keyword.name);
		// Equip is an activated ability (CR 702.6a): "Equip {N}", "Equip [quality] {N}", or "Equip—[cost]".
		if (keyword.name === 'equip' && !keyword.cost) {
			const dashEquip = part.match(/^equip(?:\s+([a-z][a-z ,'-]*?))?\s*[—–-]\s*([\s\S]+)$/i);
			if (dashEquip) {
				const rawQual = dashEquip[1]?.trim();
				const rawCost = normalizeKeywordCostText(dashEquip[2].replace(/\.$/, '').trim());
				const parsedCost = parseCost(rawCost);
				const qualParsed = rawQual ? parseEquipQualityPhrase(rawQual) : null;
				if (
					(rawQual && !qualParsed) ||
					parsedCost.unparsed.length > 0 ||
					parsedCost.defs.length === 0 ||
					!parsedCost.defs.every(isEquipPayableCostDef)
				) {
					out.push(unsupported('unparsed', part, span, [span]));
					return;
				}
				if (qualParsed) {
					keyword.equipFilter = qualParsed.equipFilter;
					if (qualParsed.equipAllowPlaneswalker) keyword.equipAllowPlaneswalker = true;
					keyword.param = rawQual;
				} else {
					delete keyword.param;
				}
				keyword.costDefs = parsedCost.defs;
				if (parsedCost.defs.length === 1 && parsedCost.defs[0].k === 'mana') {
					keyword.cost = parsedCost.defs[0].cost;
				}
			} else {
				const directEquipCost = keyword.param
					? parseCost(normalizeKeywordCostText(keyword.param))
					: null;
				if (
					directEquipCost &&
					directEquipCost.unparsed.length === 0 &&
					directEquipCost.defs.length > 0 &&
					directEquipCost.defs.every(isEquipPayableCostDef)
				) {
					keyword.costDefs = directEquipCost.defs;
					if (directEquipCost.defs.length === 1 && directEquipCost.defs[0].k === 'mana') {
						keyword.cost = directEquipCost.defs[0].cost;
					}
					delete keyword.param;
				} else {
					const q = keyword.param?.match(/^(.+?)\s*((?:\{[^}]+\})+)$/);
					const qualParsed = q ? parseEquipQualityPhrase(q[1]) : null;
					if (q && qualParsed && !/\{X\}/i.test(q[2])) {
						keyword.cost = q[2];
						keyword.equipFilter = qualParsed.equipFilter;
						if (qualParsed.equipAllowPlaneswalker) keyword.equipAllowPlaneswalker = true;
						delete keyword.param;
					} else {
						implemented = false;
					}
				}
			}
		}
		if (keyword.name === 'ward') {
			const wardCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(wardCost);
			const supportedWardCost =
				parsed.unparsed.length === 0 &&
				parsed.defs.length > 0 &&
				parsed.defs.every(isWardPayableCostDef);
			if (!supportedWardCost) {
				out.push({
					kind: 'unsupported',
					reason: 'unparsed',
					trigger: {
						event: 'becomesTarget',
						filter: { object: 'self', targetedBy: 'spellOrAbility', player: { relation: 'opponent' } }
					},
					text: part,
					span,
					unparsed: [span]
				});
				return;
			}
			keyword.costDefs = parsed.defs;
		}
		if (
			keyword.name === 'flashback' ||
			keyword.name === 'morph' ||
			keyword.name === 'megamorph' ||
			keyword.name === 'disguise' ||
			keyword.name === 'unearth' ||
			keyword.name === 'buyback' ||
			keyword.name === 'evoke' ||
			keyword.name === 'escape' ||
			keyword.name === 'foretell' ||
			keyword.name === 'plot' ||
			keyword.name === 'entwine' ||
			keyword.name === 'disturb' ||
			keyword.name === 'blitz' ||
			keyword.name === 'warp' ||
			keyword.name === 'madness' ||
			keyword.name === 'dash' ||
			keyword.name === 'bestow'
		) {
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			if (
				parsed.unparsed.length > 0 ||
				parsed.defs.length === 0 ||
				(keyword.name === 'bestow' && !parsed.defs.every(isCastPayableCostDef))
			) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = parsed.defs;
			if (keyword.name === 'bestow' && parsed.defs.length === 1 && parsed.defs[0].k === 'mana') {
				keyword.cost = parsed.defs[0].cost;
			}
		}
		if (
			keyword.name === 'offspring' ||
			keyword.name === 'squad' ||
			keyword.name === 'replicate' ||
			keyword.name === 'echo' ||
			keyword.name === 'escalate'
		) {
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			const ok =
				parsed.unparsed.length === 0 &&
				parsed.defs.length > 0 &&
				parsed.defs.every(
					(d) => SUPPORTED_OPTIONAL_COST_KINDS.has(d.k) && (d.k !== 'mana' || !/\{X\}/i.test(d.cost))
				);
			if (!ok) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = parsed.defs;
			if (keyword.name === 'escalate' && parsed.defs.length === 1 && parsed.defs[0].k === 'mana') {
				keyword.cost = parsed.defs[0].cost;
			}
		}
		if (
			keyword.name === 'level up' ||
			keyword.name === 'transmute' ||
			keyword.name === 'reinforce' ||
			keyword.name === 'ninjutsu' ||
			keyword.name === 'commander ninjutsu' ||
			keyword.name === 'scavenge' ||
			keyword.name === 'outlast' ||
			keyword.name === 'embalm' ||
			keyword.name === 'eternalize' ||
			keyword.name === 'encore'
		) {
			if (keyword.name === 'reinforce' && keyword.n === undefined) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			const ok =
				parsed.unparsed.length === 0 &&
				parsed.defs.length > 0 &&
				parsed.defs.every((d) => d.k !== 'mana' || !/\{X\}/i.test(d.cost));
			if (!ok) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = parsed.defs;
			if (keyword.name === 'transmute') {
				keyword.n = ctx.cardManaValue;
			}
		}
		if (keyword.name === 'recover') {
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			if (
				parsed.unparsed.length > 0 ||
				parsed.defs.length !== 1 ||
				parsed.defs[0].k !== 'mana' ||
				/\{X\}/i.test(parsed.defs[0].cost)
			) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.cost = parsed.defs[0].cost;
			keyword.costDefs = parsed.defs;
			delete keyword.param;
		}
		if (
			keyword.name === 'harmonize' ||
			keyword.name === 'miracle' ||
			keyword.name === 'spectacle' ||
			keyword.name === 'surge'
		) {
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			if (parsed.unparsed.length > 0 || parsed.defs.length !== 1 || parsed.defs[0].k !== 'mana') {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.cost = parsed.defs[0].cost;
			keyword.costDefs = parsed.defs;
			delete keyword.param;
		}
		if (
			keyword.name === 'sneak' ||
			keyword.name === 'beam me up' ||
			keyword.name === 'web-slinging'
		) {
			const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
			const parsed = parseCost(kwCost);
			const ok =
				parsed.unparsed.length === 0 &&
				parsed.defs.length > 0 &&
				parsed.defs.every(
					(d) => isCastPayableCostDef(d) && (d.k !== 'mana' || !/\{X\}/i.test(d.cost))
				);
			if (!ok) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			const manaParts = parsed.defs.filter(
				(d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana'
			);
			if (manaParts.length > 0) {
				keyword.cost = manaParts.map((m) => m.cost).join('');
			}
			keyword.costDefs = parsed.defs;
			delete keyword.param;
		}
		if (keyword.name === 'mayhem') {
			if (!keyword.cost && !keyword.param && keyword.n === undefined) {
				// Bare Mayhem (CR 702.187c, e.g. Oscorp Industries)
			} else {
				const kwCost = normalizeKeywordCostText(keyword.cost ?? keyword.param ?? '');
				const parsed = parseCost(kwCost);
				const ok =
					parsed.unparsed.length === 0 &&
					parsed.defs.length > 0 &&
					parsed.defs.every(
						(d) => isCastPayableCostDef(d) && (d.k !== 'mana' || !/\{X\}/i.test(d.cost))
					);
				if (!ok) {
					out.push(unsupported('unparsed', part, span, [span]));
					return;
				}
				const manaParts = parsed.defs.filter(
					(d): d is Extract<CostDef, { k: 'mana' }> => d.k === 'mana'
				);
				if (manaParts.length > 0) {
					keyword.cost = manaParts.map((m) => m.cost).join('');
				}
				keyword.costDefs = parsed.defs;
				delete keyword.param;
			}
		}
		if (keyword.name === 'awaken') {
			if (
				keyword.n === undefined ||
				keyword.n <= 0 ||
				!keyword.cost ||
				!/^(\{[^}]+\})+$/.test(keyword.cost)
			) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.awakenN = keyword.n;
			keyword.costDefs = [{ k: 'mana', cost: keyword.cost }];
		}
		if (keyword.name === 'emerge') {
			if (!keyword.cost && keyword.param) {
				const em = keyword.param.match(/^(.+?)\s+((?:\{[^}]+\})+)$/);
				const ef = em ? parseMultiOrObjectPhrase(em[1].trim()) : null;
				if (!em || !ef) {
					out.push(unsupported('unparsed', part, span, [span]));
					return;
				}
				keyword.emergeFilter = ef;
				keyword.cost = em[2];
				delete keyword.param;
			}
			if (!keyword.cost || !/^(\{[^}]+\})+$/.test(keyword.cost) || /\{X\}/i.test(keyword.cost)) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = [{ k: 'mana', cost: keyword.cost }];
		}
		if (keyword.name === 'champion') {
			const rawChamp = (keyword.param ?? '').trim().replace(/^an?\s+/i, '').trim();
			const cf = rawChamp ? parseMultiOrObjectPhrase(rawChamp) : null;
			if (!cf || keyword.cost !== undefined || keyword.n !== undefined) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.championFilter = cf;
		}
		if (keyword.name === 'prototype') {
			if (!keyword.prototypeSpec) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			ctx.prototypeSpec = keyword.prototypeSpec;
		}
		if (
			(keyword.name === 'casualty' || keyword.name === 'fading') &&
			(keyword.n === undefined || keyword.cost !== undefined || keyword.param !== undefined)
		) {
			out.push(unsupported('unparsed', part, span, [span]));
			return;
		}
		if (
			keyword.name === 'vanishing' &&
			(keyword.cost !== undefined || keyword.param !== undefined)
		) {
			out.push(unsupported('unparsed', part, span, [span]));
			return;
		}
		if (keyword.name === 'cumulative upkeep') {
			let kwCost = (keyword.cost ?? keyword.param ?? '').trim();
			// CR 702.24a Example 1: "Cumulative upkeep {W} or {U}" chooses {W} or {U} per age counter, identical to {W/U}.
			const hybridOr = kwCost.match(/^\{([WUBRG])\}\s+or\s+\{([WUBRG])\}$/i);
			if (hybridOr) {
				kwCost = `{${hybridOr[1].toUpperCase()}/${hybridOr[2].toUpperCase()}}`;
			}
			const payManaAndLife = kwCost.match(/^pay\s+((?:\{[^}]+\})+)\s+and\s+(\d+\s+life)$/i);
			if (payManaAndLife) {
				kwCost = `${payManaAndLife[1]}, Pay ${payManaAndLife[2]}`;
			}
			const parsed = parseCost(kwCost);
			const scalable =
				parsed.unparsed.length === 0 &&
				parsed.defs.length > 0 &&
				parsed.defs.every((d) => {
					if (!SUPPORTED_OPTIONAL_COST_KINDS.has(d.k)) return false;
					if (d.k === 'mana') return !/\{X\}/i.test(d.cost);
					if (d.k === 'payLife') return d.amount.k === 'const';
					if (d.k === 'removeCounters') return d.count.k === 'const';
					if (d.k === 'tapSubsetSum') return d.minTotal.k === 'const';
					if (d.k === 'sacrifice' || d.k === 'discard' || d.k === 'exileFrom' || d.k === 'tapOthers') {
						return d.count.k === 'const' && d.filter !== 'self';
					}
					return false;
				});
			if (!scalable) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = parsed.defs;
		}
		if (keyword.name === 'kicker' || keyword.name === 'multikicker') {
			const rawKicker = (keyword.cost ?? keyword.param ?? '').trim();
			const rawEntries =
				keyword.name === 'kicker' ? rawKicker.split(/\s+and\/or\s+/i).map((e) => e.trim()) : [rawKicker];
			if (!rawKicker || rawEntries.some((e) => !e)) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			const parsedEntries: NonNullable<KeywordDef['kickerCosts']> = [];
			for (const entry of rawEntries) {
				const parsed = parseCost(entry);
				if (parsed.unparsed.length > 0 || parsed.defs.length === 0) {
					out.push(unsupported('unparsed', part, span, [span]));
					return;
				}
				parsedEntries.push({
					cost: entry,
					costDefs: parsed.defs,
					tags: kickerTagsForEntry(entry, parsed.defs)
				});
			}
			keyword.kickerCosts = parsedEntries;
			if (parsedEntries.length === 1) {
				keyword.costDefs = parsedEntries[0].costDefs;
			}
		}
		const kwSpec = getKeywordSpec(keyword.name);
		if (
			kwSpec?.parameterKind === 'none' &&
			(keyword.cost !== undefined || keyword.n !== undefined || keyword.param !== undefined)
		) {
			implemented = false;
		}
		if (keyword.name === 'bloodthirst') {
			const isBloodthirstX =
				keyword.n === undefined &&
				keyword.cost === undefined &&
				keyword.param?.trim().toUpperCase() === 'X';
			const isBloodthirstN =
				keyword.n !== undefined && keyword.cost === undefined && keyword.param === undefined;
			if (isBloodthirstX) {
				keyword.param = 'X';
			} else if (!isBloodthirstN) {
				implemented = false;
			}
		} else if (keyword.name === 'devour') {
			if (keyword.n !== undefined && keyword.cost === undefined && keyword.param === undefined) {
				// Devour N
			} else if (
				keyword.n === undefined &&
				keyword.cost === undefined &&
				keyword.param &&
				/^x(?:\s*,\s*where\s+x\s+is\s+the\s+number\s+of\s+creatures\s+devoured\s+this\s+way)?$/i.test(
					keyword.param.trim()
				)
			) {
				keyword.devourX = true;
				delete keyword.param;
			} else if (keyword.n === undefined && keyword.cost === undefined && keyword.param) {
				const dm = keyword.param.trim().match(/^(.+?)\s+(\d+)$/);
				const df = dm ? parseMultiOrObjectPhrase(dm[1].trim()) : null;
				if (dm && df) {
					keyword.devourFilter = df;
					keyword.n = parseInt(dm[2], 10);
					delete keyword.param;
				} else {
					implemented = false;
				}
			} else {
				implemented = false;
			}
		} else if (
			kwSpec?.parameterKind === 'number' &&
			(keyword.n === undefined || keyword.cost !== undefined || keyword.param !== undefined)
		) {
			implemented = false;
		}
		if (keyword.name === 'affinity') {
			const m = (keyword.param ?? '').trim().match(/^for\s+(.+)$/i);
			const filter = m ? parseAffinityQuality(m[1].trim()) : null;
			if (filter) {
				keyword.affinityFilter = filter;
			} else {
				implemented = false;
			}
		}
		if (keyword.name === 'read ahead') {
			ctx.hasReadAhead = true;
		}
		if (!implemented) {
			out.push(unsupported('keyword_not_implemented', part, span, [span]));
			return;
		}
		if (keyword.name === 'enchant') {
			// CR 303.4a: an Aura spell targets the object or player its enchant ability can enchant.
			const rawParam = (keyword.param ?? '').trim().toLowerCase();
			if (rawParam === 'player') {
				keyword.enchantPlayer = { relation: 'any' };
			} else if (rawParam === 'opponent' || rawParam === 'an opponent') {
				keyword.enchantPlayer = { relation: 'opponent' };
			} else if (rawParam === 'you') {
				keyword.enchantPlayer = { relation: 'you' };
			} else {
				const filter = parseEnchantPhrase((keyword.param ?? '').trim());
				if (filter) keyword.enchantFilter = filter;
				else {
					out.push(unsupported('keyword_not_implemented', part, span, [span]));
					return;
				}
			}
		}
		if (
			keyword.name === 'cycling' ||
			keyword.name === 'basic landcycling' ||
			keyword.name === 'landcycling' ||
			keyword.name === 'typecycling'
		) {
			if (keyword.name === 'basic landcycling') {
				keyword.cyclingFilter = { supertypes: ['Basic'], types: ['Land'] };
				keyword.cyclingDesc = 'basic land';
			} else if (keyword.name === 'landcycling') {
				keyword.cyclingFilter = { types: ['Land'] };
				keyword.cyclingDesc = 'land';
			} else if (keyword.name === 'typecycling' && !keyword.cyclingFilter) {
				out.push(unsupported('keyword_not_implemented', part, span, [span]));
				return;
			}
			const rawCost = (keyword.cost ?? keyword.param ?? '').trim();
			const parsed = parseCost(rawCost);
			if (parsed.unparsed.length > 0 || parsed.defs.length === 0) {
				out.push(unsupported('unparsed', part, span, [span]));
				return;
			}
			keyword.costDefs = parsed.defs;
		}
		const isCyclingKw =
			keyword.name === 'cycling' ||
			keyword.name === 'basic landcycling' ||
			keyword.name === 'landcycling' ||
			keyword.name === 'typecycling';
		const cyclingId = i === 0 ? `cycling_${line.rawIndex}` : `cycling_${line.rawIndex}_${i}`;
		const crewId = i === 0 ? `crew_${line.rawIndex}` : `crew_${line.rawIndex}_${i}`;
		const saddleId = i === 0 ? `saddle_${line.rawIndex}` : `saddle_${line.rawIndex}_${i}`;
		const unearthId = i === 0 ? `unearth_${line.rawIndex}` : `unearth_${line.rawIndex}_${i}`;
		const stationId = i === 0 ? `station_${line.rawIndex}` : `station_${line.rawIndex}_${i}`;
		const levelUpId = i === 0 ? `level_up_${line.rawIndex}` : `level_up_${line.rawIndex}_${i}`;
		const transmuteId = i === 0 ? `transmute_${line.rawIndex}` : `transmute_${line.rawIndex}_${i}`;
		const reinforceId = i === 0 ? `reinforce_${line.rawIndex}` : `reinforce_${line.rawIndex}_${i}`;
		const ninjutsuId = i === 0 ? `ninjutsu_${line.rawIndex}` : `ninjutsu_${line.rawIndex}_${i}`;
		const commanderNinjutsuId =
			i === 0 ? `commander_ninjutsu_${line.rawIndex}` : `commander_ninjutsu_${line.rawIndex}_${i}`;
		const scavengeId = i === 0 ? `scavenge_${line.rawIndex}` : `scavenge_${line.rawIndex}_${i}`;
		const outlastId = i === 0 ? `outlast_${line.rawIndex}` : `outlast_${line.rawIndex}_${i}`;
		const embalmId = i === 0 ? `embalm_${line.rawIndex}` : `embalm_${line.rawIndex}_${i}`;
		const eternalizeId = i === 0 ? `eternalize_${line.rawIndex}` : `eternalize_${line.rawIndex}_${i}`;
		const encoreId = i === 0 ? `encore_${line.rawIndex}` : `encore_${line.rawIndex}_${i}`;
		out.push({
			kind: 'keyword',
			keyword,
			span,
			...(keyword.name === 'equip'
				? { id: `equip_${line.rawIndex}` }
				: isCyclingKw
					? { id: cyclingId }
					: keyword.name === 'crew'
						? { id: crewId }
						: keyword.name === 'saddle'
							? { id: saddleId }
							: keyword.name === 'unearth'
								? { id: unearthId }
								: keyword.name === 'station'
									? { id: stationId }
									: keyword.name === 'level up'
										? { id: levelUpId }
										: keyword.name === 'transmute'
											? { id: transmuteId }
											: keyword.name === 'reinforce'
												? { id: reinforceId }
												: keyword.name === 'ninjutsu'
													? { id: ninjutsuId }
													: keyword.name === 'commander ninjutsu'
														? { id: commanderNinjutsuId }
														: keyword.name === 'scavenge'
															? { id: scavengeId }
															: keyword.name === 'outlast'
																? { id: outlastId }
																: keyword.name === 'embalm'
																	? { id: embalmId }
																	: keyword.name === 'eternalize'
																		? { id: eternalizeId }
																		: keyword.name === 'encore'
																			? { id: encoreId }
																			: {})
		});
		if (keyword.name === 'vanishing') {
			out.push(...buildVanishingAbilities(keyword.n, span));
		} else if (keyword.name === 'fading' && keyword.n !== undefined) {
			out.push(...buildFadingAbilities(keyword.n, span));
		}
		// CR 702.124j: "Partner with [name]" is two abilities. The pairing half is the keyword above
		// (deck construction); the other is "When this permanent enters, target player may search their
		// library for a card named [name], reveal it, put it into their hand, then shuffle."
		if (keyword.name === 'partner' && /^with\b/i.test(keyword.param ?? '')) {
			const partnerName = (keyword.param ?? '').replace(/^with\s+/i, '').trim();
			out.push({
				kind: 'triggered',
				trigger: { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } },
				targets: [{ kind: 'player', filter: {}, player: { relation: 'any' }, min: 1, max: 1 }],
				effect: [
					{
						verb: 'search',
						subject: { k: 'none' },
						actor: { k: 'target', index: 0 },
						amount: { k: 'const', n: 1 },
						optional: { chooser: { k: 'target', index: 0 } },
						params: {
							search: {
								filter: { named: partnerName },
								count: 1,
								upTo: true,
								statedQuality: true,
								destinations: [{ zone: 'hand' }],
								description: `a card named ${partnerName}`
							}
						},
						span
					}
				],
				text: part,
				span
			});
		}
	});
	return out;
}

// ---- Triggered abilities --------------------------------------------------------------------

const SAGA_ROMAN_TO_INT: Readonly<Record<string, number>> = {
	I: 1,
	II: 2,
	III: 3,
	IV: 4,
	V: 5,
	VI: 6
};

/**
 * CR 715.2: Saga chapter abilities ("I — ...", "I, II — ...", "I — Gungnir — ...").
 * Compiles into a `counterPlaced` TriggeredAbility with `chapterNumbers` and `isChapterAbility: true`.
 */
function sagaChapterLine(group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	const chapMatch = line.text.match(/^((?:I|II|III|IV|V|VI)(?:,\s*(?:I|II|III|IV|V|VI))*)\s*—\s*/);
	if (!chapMatch) return null;

	const chapterNumbers = chapMatch[1].split(/,\s*/).map((r) => SAGA_ROMAN_TO_INT[r]);
	if (chapterNumbers.some((n) => !n)) return null;

	const span = groupSpan(group);
	const fullText = group.map((l) => l.text).join('\n');
	let effectStart = line.span.start + chapMatch[0].length;
	let headerEffectText = line.text.slice(chapMatch[0].length);

	// Optional post-chapter flavor word (e.g. "I — Gungnir — Destroy target creature...").
	const flavorMatch = headerEffectText.match(/^([A-Z][A-Za-z0-9'’ !?-]*?) — (?=[A-Z•{~])/);
	if (flavorMatch && !/^choose\b/i.test(flavorMatch[1])) {
		effectStart += flavorMatch[0].length;
		headerEffectText = headerEffectText.slice(flavorMatch[0].length);
	}

	const trigger: TriggerDef = {
		event: 'counterPlaced',
		filter: { object: 'self', counter: 'lore' },
		chapterNumbers,
		isChapterAbility: true
	};

	const headerSentences = splitSentences(headerEffectText, effectStart);
	if (
		headerSentences.length >= 2 &&
		/^this ability triggers only once each turn\.?$/i.test(
			headerSentences[headerSentences.length - 1].text.trim()
		)
	) {
		trigger.onlyOncePerTurn = true;
		const lastSentence = headerSentences[headerSentences.length - 1];
		headerEffectText = headerEffectText.slice(0, lastSentence.span.start - effectStart).trimEnd();
	}

	if (group.length > 1) {
		const bullets = group.slice(1).map((b) => ({ text: b.text, start: b.span.start, end: b.span.end }));
		const modalParse = /^choose\b/i.test(headerEffectText.trim())
			? parseModal(headerEffectText, bullets, 'triggered', effectStart)
			: null;
		const modal = modalParse?.modal;
		const modesOk =
			Boolean(modalParse && modal) &&
			modalParse!.unparsed.length === 0 &&
			modal!.modes.length > 0 &&
			modal!.min >= 0 &&
			modal!.max >= modal!.min &&
			modal!.modes.every((m) => interpretableTrigger({ steps: m.effect, targets: m.targets, unparsed: [] }));
		if (!modesOk) {
			const gaps = modalParse?.unparsed.length
				? modalParse.unparsed
				: [{ start: effectStart, end: span.end }];
			return [{ ...unsupported('unparsed', fullText, span, gaps), trigger }];
		}
		return [{ kind: 'triggered', trigger, targets: [], effect: [], modal, text: fullText, span }];
	}

	const effect = parseEffects(headerEffectText, effectStart, 'triggered');
	if (!interpretableTrigger(effect)) {
		const gaps = effect.unparsed.length > 0 ? effect.unparsed : [{ start: effectStart, end: span.end }];
		return [{ ...unsupported('unparsed', fullText, span, gaps), trigger }];
	}
	return [{ kind: 'triggered', trigger, targets: effect.targets, effect: effect.steps, text: fullText, span }];
}

/**
 * CR 701.43d: Attack-exert abilities ("You may exert ~ as it attacks." and
 * "If ~ hasn't been exerted this turn, you may exert it as it attacks.", optionally followed by a
 * non-targeted "When you do, <effect>"). Targeted reflexive "When you do, ... target ..." triggers
 * are intentionally left unsupported because CR 603.12 chooses targets only after exerting.
 */
function exertAttackLine(group: NormalizedLine[]): AbilityDef[] | null {
	if (group.length !== 1) return null;
	const line = group[0];
	const m = line.body.match(
		/^(?:(if (?:~|it|he|she|they) (?:hasn't|wasn't|has not|was not) (?:been )?exerted this turn),\s+)?you may exert (?:~|it|him|her|them) as (?:~|it|he|she|they) attacks\.(?:\s+when you do,\s+(.+))?$/i
	);
	if (!m) return null;

	const span = groupSpan(group);
	const fullText = line.text;
	const trigger: TriggerDef = { event: 'attacks', filter: { object: 'self' } };
	const condition: Condition | undefined = m[1]
		? { k: 'not', of: { k: 'exertedThisTurn' } }
		: undefined;
	const exertStep: EffectStep = {
		verb: 'exert',
		subject: { k: 'self' },
		optional: { chooser: { k: 'you' } },
		span: line.bodySpan
	};

	if (!m[2]) {
		return [
			{
				kind: 'triggered',
				trigger,
				...(condition ? { condition } : {}),
				targets: [],
				effect: [exertStep],
				text: fullText,
				span
			}
		];
	}

	const followText = m[2];
	const followStart = Math.max(line.bodySpan.start, line.bodySpan.end - followText.length);
	const followEffect = parseEffects(followText, followStart, 'triggered', trigger);
	if (
		followEffect.targets.length > 0 ||
		followEffect.steps.length === 0 ||
		!staticallyInterpretable(followEffect, true)
	) {
		const gaps =
			followEffect.unparsed.length > 0
				? followEffect.unparsed
				: [{ start: followStart, end: span.end }];
		return [
			{
				...unsupported('unparsed', fullText, span, gaps),
				trigger,
				...(condition ? { condition } : {})
			}
		];
	}

	const shiftedSteps: EffectStep[] = followEffect.steps.map((s) => ({
		...s,
		ifPrecedingAccepted:
			s.ifPrecedingAccepted !== undefined
				? s.ifPrecedingAccepted + 1
				: s.ifPrecedingDeclined === undefined
					? 0
					: undefined,
		...(s.ifPrecedingDeclined !== undefined ? { ifPrecedingDeclined: s.ifPrecedingDeclined + 1 } : {})
	}));

	return [
		{
			kind: 'triggered',
			trigger,
			...(condition ? { condition } : {}),
			targets: [],
			effect: [exertStep, ...shiftedSteps],
			text: fullText,
			span
		}
	];
}

// ---- Case, Spree, Tiered, & Wave 4 Grammar Adapters -----------------------------------------

const CASE_NUMBER_WORDS: Readonly<Record<string, number>> = {
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

function parseSmallNumberToken(raw: string): number | null {
	const t = raw.trim().toLowerCase();
	if (/^\d+$/.test(t)) return parseInt(t, 10);
	return CASE_NUMBER_WORDS[t] ?? null;
}

function parseCaseSolveCondition(rawText: string): Condition | null {
	const s = rawText.trim().replace(/\.$/, '').trim();
	if (!s) return null;

	const gainedLife = s.match(/^you've gained (\S+) or more life this turn$/i);
	if (gainedLife) {
		const n = parseSmallNumberToken(gainedLife[1]);
		if (n !== null) return { k: 'gainedLifeThisTurn', min: { k: 'const', n } };
	}

	if (/^you have no cards in hand$/i.test(s)) {
		return {
			k: 'compare',
			left: { k: 'cardsIn', zone: 'hand', of: { k: 'you' } },
			op: '=',
			right: { k: 'const', n: 0 }
		};
	}

	const gyCount = s.match(/^there are (\S+) or more cards in your graveyard$/i);
	if (gyCount) {
		const n = parseSmallNumberToken(gyCount[1]);
		if (n !== null) {
			return {
				k: 'compare',
				left: { k: 'cardsIn', zone: 'graveyard', of: { k: 'you' } },
				op: '>=',
				right: { k: 'const', n }
			};
		}
	}

	const attacked = s.match(/^(\S+) or more creatures attacked this turn$/i);
	if (attacked) {
		const n = parseSmallNumberToken(attacked[1]);
		if (n !== null) return { k: 'creaturesAttackedCountThisTurn', min: n };
	}

	const totalPower = s.match(/^creatures you control have total power (\S+) or greater$/i);
	if (totalPower) {
		const n = parseSmallNumberToken(totalPower[1]);
		if (n !== null) return { k: 'totalPowerControlled', min: n };
	}

	const colors = s.match(/^there are (\S+) (?:or more )?colors among permanents you control$/i);
	if (colors) {
		const n = parseSmallNumberToken(colors[1]);
		if (n !== null) return { k: 'colorsAmongControlledPermanents', min: n };
	}

	const sourcesDmg = s.match(/^(\S+) or more sources you controlled dealt damage this turn$/i);
	if (sourcesDmg) {
		const n = parseSmallNumberToken(sourcesDmg[1]);
		if (n !== null) return { k: 'sourcesDealtDamageThisTurn', min: n };
	}

	const cardsToGy = s.match(
		/^(\S+) or more (.+?) cards? were put into (your graveyard|graveyards) from anywhere this turn$/i
	);
	if (cardsToGy) {
		const n = parseSmallNumberToken(cardsToGy[1]);
		const qual = cardsToGy[2].trim();
		const filter = /^cards?$/i.test(qual) ? {} : parseMultiOrObjectPhrase(qual);
		if (n !== null && filter) {
			return {
				k: 'cardsPutIntoGraveyardFromAnywhereThisTurn',
				min: n,
				...(Object.keys(filter).length > 0 ? { filter } : {}),
				whose: /^your\b/i.test(cardsToGy[3]) ? 'you' : 'any'
			};
		}
	}

	const spellsCast = s.match(/^you've cast (\S+) or more (?:(.+?) )?spells this turn$/i);
	if (spellsCast) {
		const n = parseSmallNumberToken(spellsCast[1]);
		const rawQual = spellsCast[2]?.trim().replace(/\binstant and sorcery\b/i, 'instant or sorcery');
		const filter = rawQual ? parseMultiOrObjectPhrase(rawQual) : {};
		if (n !== null && filter) {
			return {
				k: 'spellsCastThisTurnCount',
				min: n,
				...(Object.keys(filter).length > 0 ? { filter } : {})
			};
		}
	}

	const controlNo = s.match(/^you control no (.+)$/i);
	if (controlNo) {
		const filter = parseMultiOrObjectPhrase(controlNo[1].trim());
		if (filter) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...filter, controller: 'you', zone: 'battlefield' } },
				op: '=',
				right: { k: 'const', n: 0 }
			};
		}
	}

	const controlOrMore = s.match(/^you control (\S+) or more (.+)$/i);
	if (controlOrMore) {
		const n = parseSmallNumberToken(controlOrMore[1]);
		const filter = parseMultiOrObjectPhrase(controlOrMore[2].trim());
		if (n !== null && filter) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...filter, controller: 'you', zone: 'battlefield' } },
				op: '>=',
				right: { k: 'const', n }
			};
		}
	}

	const controlSingle = s.match(/^you control (?:an? )?(.+)$/i);
	if (controlSingle) {
		const filter = parseMultiOrObjectPhrase(controlSingle[1].trim());
		if (filter) {
			return {
				k: 'compare',
				left: { k: 'count', of: { ...filter, controller: 'you', zone: 'battlefield' } },
				op: '>=',
				right: { k: 'const', n: 1 }
			};
		}
	}

	return null;
}

function caseToSolveLine(group: NormalizedLine[]): AbilityDef[] | null {
	if (group.length !== 1) return null;
	const line = group[0];
	const m = line.text.match(/^To solve\s*—\s*([\s\S]+)$/i);
	if (!m) return null;
	const solveCond = parseCaseSolveCondition(m[1]);
	if (!solveCond) {
		return [unsupported('unparsed', line.text, line.span, [line.span])];
	}
	return [
		{
			kind: 'triggered',
			trigger: {
				event: 'phaseBegin',
				filter: { phase: 'end_step' },
				scope: 'controller_turn'
			},
			condition: { k: 'and', of: [{ k: 'caseUnsolved' }, solveCond] },
			targets: [],
			effect: [],
			text: line.text,
			span: line.span
		}
	];
}

function caseSolvedLine(ctx: Ctx, group: NormalizedLine[], normText: string): AbilityDef[] | null {
	const first = group[0];
	const m = first.text.match(/^Solved\s*—\s*/i);
	if (!m) return null;
	const prefixLen = m[0].length;
	const innerText = first.text.slice(prefixLen);
	const innerStart = first.span.start + prefixLen;
	const innerSpan: Span = { start: innerStart, end: first.span.end };
	const strippedFirst: NormalizedLine = {
		rawIndex: first.rawIndex,
		raw: first.raw,
		text: innerText,
		span: innerSpan,
		body: innerText,
		bodySpan: innerSpan,
		sentences: splitSentences(innerText, innerStart)
	};
	const innerGroup = [strippedFirst, ...group.slice(1)];
	const compiled = compilePermanentGroup(ctx, innerGroup);
	const out: AbilityDef[] = [];
	const cond: Condition = { k: 'caseSolved' };
	for (const ab of compiled) {
		out.push(...gateAbilityByStriationCondition(ab, cond, normText));
	}
	return out;
}

function isSpreeGroup(group: NormalizedLine[]): boolean {
	return /^spree$/i.test(group[0].body.trim());
}

function isTieredGroup(group: NormalizedLine[]): boolean {
	return /^tiered$/i.test(group[0].body.trim());
}

interface Wave4TextRewriteOpts {
	bargain: boolean;
	renown: boolean;
	devourCount: boolean;
	devourCond: boolean;
}

function detectWave4Rewrites(ctx: Ctx, texts: readonly string[]): Wave4TextRewriteOpts | null {
	const joined = texts.join('\n');
	const bargain = ctx.hasBargainKeyword && /\bbargained\b/i.test(joined);
	const renown = ctx.hasRenownKeyword && /\brenowned\b/i.test(joined);
	const devourCount =
		ctx.hasDevourKeyword && /\bfor each creature (?:it|~) devoured\b/i.test(joined);
	const devourCond =
		ctx.hasDevourKeyword && /\bif (?:it|~) devoured a creature\b/i.test(joined);
	if (!bargain && !renown && !devourCount && !devourCond) return null;
	return { bargain, renown, devourCount, devourCond };
}

function applyWave4TextRewrite(str: string, opts: Wave4TextRewriteOpts): string {
	let out = str;
	if (opts.bargain) {
		out = out.replace(/\bbargained\b/gi, 'kicked');
	}
	if (opts.renown) {
		out = out.replace(/\brenowned\b/gi, 'monstrous');
	}
	if (opts.devourCount) {
		out = out.replace(/\bfor each creature (?:it|~) devoured\b/gi, 'for each time it was kicked');
	}
	if (opts.devourCond) {
		out = out.replace(/\bif (?:it|~) devoured a creature\b/gi, 'if ~ is monstrous');
	}
	return out;
}

function rewriteNormalizedLine(line: NormalizedLine, opts: Wave4TextRewriteOpts): NormalizedLine {
	const newText = applyWave4TextRewrite(line.text, opts);
	const newBody = applyWave4TextRewrite(line.body, opts);
	const start = line.span.start;
	const bodyOffset = line.bodySpan.start - line.span.start;
	const bodyStart = start + Math.min(bodyOffset, newText.length);
	const newSpan: Span = { start, end: start + newText.length };
	const newBodySpan: Span = { start: bodyStart, end: bodyStart + newBody.length };
	return {
		...line,
		text: newText,
		span: newSpan,
		body: newBody,
		bodySpan: newBodySpan,
		sentences: splitSentences(newBody, bodyStart)
	};
}

function mapAmountWave4(amount: Amount, opts: Wave4TextRewriteOpts): Amount {
	if (opts.devourCount && amount.k === 'kickedCount') {
		const mult = amount.multiplier ?? 1;
		if (mult <= 1) return { k: 'devouredCount' };
		return {
			k: 'sum',
			args: Array.from({ length: mult }, () => ({ k: 'devouredCount' as const }))
		};
	}
	if (amount.k === 'sum' || amount.k === 'min' || amount.k === 'max') {
		return { ...amount, args: amount.args.map((a) => mapAmountWave4(a, opts)) };
	}
	if (amount.k === 'negate') {
		return { ...amount, of: mapAmountWave4(amount.of, opts) };
	}
	return amount;
}

function mapConditionWave4(cond: Condition, opts: Wave4TextRewriteOpts): Condition {
	if (opts.bargain && cond.k === 'kicked' && !cond.tag) {
		return { k: 'kicked', tag: 'bargain' };
	}
	if (opts.renown && cond.k === 'monstrous') {
		return { k: 'isRenowned' };
	}
	if (opts.devourCond && cond.k === 'monstrous') {
		return {
			k: 'compare',
			left: { k: 'devouredCount' },
			op: '>=',
			right: { k: 'const', n: 1 }
		};
	}
	if (cond.k === 'not') {
		return { k: 'not', of: mapConditionWave4(cond.of, opts) };
	}
	if (cond.k === 'and' || cond.k === 'or') {
		return { k: cond.k, of: cond.of.map((c) => mapConditionWave4(c, opts)) };
	}
	if (cond.k === 'compare') {
		return {
			...cond,
			left: mapAmountWave4(cond.left, opts),
			right: mapAmountWave4(cond.right, opts)
		};
	}
	return cond;
}

function mapStepWave4(step: EffectStep, opts: Wave4TextRewriteOpts): EffectStep {
	return {
		...step,
		...(step.amount ? { amount: mapAmountWave4(step.amount, opts) } : {}),
		...(step.condition ? { condition: mapConditionWave4(step.condition, opts) } : {}),
		...(step.params
			? {
					params: {
						...step.params,
						...(step.params.toughness
							? { toughness: mapAmountWave4(step.params.toughness, opts) }
							: {}),
						...(step.params.setPower
							? { setPower: mapAmountWave4(step.params.setPower, opts) }
							: {}),
						...(step.params.setToughness
							? { setToughness: mapAmountWave4(step.params.setToughness, opts) }
							: {}),
						...(step.params.count
							? { count: mapAmountWave4(step.params.count, opts) }
							: {})
					}
				}
			: {})
	};
}

function mapAbilityWave4(ab: AbilityDef, opts: Wave4TextRewriteOpts): AbilityDef {
	if (ab.kind === 'triggered') {
		const trigger: TriggerDef =
			opts.renown && ab.trigger.event === 'becameMonstrous'
				? { ...ab.trigger, event: 'becameRenowned' }
				: ab.trigger;
		return {
			...ab,
			trigger,
			...(ab.condition ? { condition: mapConditionWave4(ab.condition, opts) } : {}),
			effect: ab.effect.map((s) => mapStepWave4(s, opts)),
			...(ab.modal
				? {
						modal: {
							...ab.modal,
							modes: ab.modal.modes.map((m) => ({
								...m,
								effect: m.effect.map((s) => mapStepWave4(s, opts))
							}))
						}
					}
				: {})
		};
	}
	if (ab.kind === 'activated') {
		return {
			...ab,
			...(ab.activationCondition
				? { activationCondition: mapConditionWave4(ab.activationCondition, opts) }
				: {}),
			effect: ab.effect.map((s) => mapStepWave4(s, opts)),
			...(ab.modal
				? {
						modal: {
							...ab.modal,
							modes: ab.modal.modes.map((m) => ({
								...m,
								effect: m.effect.map((s) => mapStepWave4(s, opts))
							}))
						}
					}
				: {})
		};
	}
	if (ab.kind === 'spell') {
		return {
			...ab,
			effect: ab.effect.map((s) => mapStepWave4(s, opts)),
			...(ab.modal
				? {
						modal: {
							...ab.modal,
							modes: ab.modal.modes.map((m) => ({
								...m,
								effect: m.effect.map((s) => mapStepWave4(s, opts))
							}))
						}
					}
				: {})
		};
	}
	if (ab.kind === 'static') {
		const st = ab.static;
		const mappedCond = st.condition ? mapConditionWave4(st.condition, opts) : undefined;
		if (st.k === 'continuous' && (st.mod.k === 'pt' || st.mod.k === 'setBasePT')) {
			return {
				...ab,
				static: {
					...st,
					...(mappedCond ? { condition: mappedCond } : {}),
					mod: {
						...st.mod,
						power: mapAmountWave4(st.mod.power, opts),
						toughness: mapAmountWave4(st.mod.toughness, opts)
					}
				}
			};
		}
		if (mappedCond) {
			return { ...ab, static: { ...st, condition: mappedCond } };
		}
	}
	return ab;
}

function parseP12TriggerHeader(
	body: string,
	bodyStart: number
): { trigger: TriggerDef; effectStart: number } | null {
	const classLvl = body.match(/^when ~ becomes level (\d+),\s*/i);
	if (classLvl) {
		return {
			trigger: {
				event: 'classLevelGained',
				filter: { object: 'self', classLevel: parseInt(classLvl[1], 10) }
			},
			effectStart: bodyStart + classLvl[0].length
		};
	}
	const selfSolved = body.match(/^when ~ becomes solved,\s*/i);
	if (selfSolved) {
		return {
			trigger: { event: 'caseSolved', filter: { object: 'self' } },
			effectStart: bodyStart + selfSolved[0].length
		};
	}
	const anyCaseSolved = body.match(/^whenever you solve a case,\s*/i);
	if (anyCaseSolved) {
		return {
			trigger: { event: 'caseSolved', filter: { player: { relation: 'you' } } },
			effectStart: bodyStart + anyCaseSolved[0].length
		};
	}
	const selfRenowned = body.match(/^when ~ becomes renowned,\s*/i);
	if (selfRenowned) {
		return {
			trigger: { event: 'becameRenowned', filter: { object: 'self' } },
			effectStart: bodyStart + selfRenowned[0].length
		};
	}
	return null;
}

function triggerLine(ctx: Ctx, group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	if (!/^(when|whenever|at)\b/i.test(line.body)) return null;
	const rewrites = detectWave4Rewrites(
		ctx,
		group.map((l) => l.text)
	);
	if (rewrites) {
		const origSpan = groupSpan(group);
		const origText = group.map((l) => l.text).join('\n');
		const rewrittenGroup = group.map((l) => rewriteNormalizedLine(l, rewrites));
		const adapted = triggerLineCore(rewrittenGroup);
		if (adapted && adapted.every((a) => a.kind !== 'unsupported')) {
			return adapted.map((a) => {
				const mapped = mapAbilityWave4(a, rewrites);
				return mapped.kind === 'triggered'
					? { ...mapped, text: origText, span: origSpan }
					: mapped;
			});
		}
	}
	return triggerLineCore(group);
}

function triggerLineCore(group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	if (!/^(when|whenever|at)\b/i.test(line.body)) return null;
	const span = groupSpan(group);
	const fullText = group.map((l) => l.text).join('\n');

	const p12Head = parseP12TriggerHeader(line.body, line.bodySpan.start);
	let trigger: TriggerDef;
	let condition: Condition | undefined;
	let effectStart: number;

	if (p12Head) {
		trigger = p12Head.trigger;
		effectStart = p12Head.effectStart;
	} else {
		const head = parseTriggerHeader(line.body, line.bodySpan.start);
		if (!head || !head.trigger || head.unparsed.length > 0) {
			return [
				unsupported('unparsed', fullText, span, head?.unparsed.length ? head.unparsed : [line.bodySpan])
			];
		}
		trigger = head.trigger;
		condition = head.condition;
		effectStart = head.effectStart;
		if (runtimeTriggerProblem(trigger)) {
			const headSpan = { start: line.bodySpan.start, end: effectStart };
			return [unsupported('event_not_implemented', fullText, span, [headSpan])];
		}
	}

	let headerEffectText = line.text.slice(effectStart - line.span.start);
	const headerSentences = splitSentences(headerEffectText, effectStart);
	if (
		headerSentences.length >= 2 &&
		/^this ability triggers only once each turn\.?$/i.test(
			headerSentences[headerSentences.length - 1].text.trim()
		)
	) {
		trigger.onlyOncePerTurn = true;
		const lastSentence = headerSentences[headerSentences.length - 1];
		headerEffectText = headerEffectText.slice(0, lastSentence.span.start - effectStart).trimEnd();
	}
	if (group.length > 1) {
		const bullets = group.slice(1).map((b) => ({ text: b.text, start: b.span.start, end: b.span.end }));
		const modalParse = /^choose\b/i.test(headerEffectText.trim())
			? parseModal(headerEffectText, bullets, 'triggered', effectStart, trigger)
			: null;
		const modal = modalParse?.modal;
		const modesOk =
			Boolean(modalParse && modal) &&
			modalParse!.unparsed.length === 0 &&
			modal!.modes.length > 0 &&
			modal!.min >= 0 &&
			modal!.max >= modal!.min &&
			modal!.modes.every((m) => interpretableTrigger({ steps: m.effect, targets: m.targets, unparsed: [] }));
		if (!modesOk) {
			const gaps = modalParse?.unparsed.length
				? modalParse.unparsed
				: [{ start: effectStart, end: span.end }];
			return [{ ...unsupported('unparsed', fullText, span, gaps), trigger, condition }];
		}
		return [{ kind: 'triggered', trigger, condition, targets: [], effect: [], modal, text: fullText, span }];
	}

	const effect = parseEffects(headerEffectText, effectStart, 'triggered', trigger);
	if (!interpretableTrigger(effect)) {
		const gaps = effect.unparsed.length > 0 ? effect.unparsed : [{ start: effectStart, end: span.end }];
		return [{ ...unsupported('unparsed', fullText, span, gaps), trigger, condition }];
	}
	return [{ kind: 'triggered', trigger, condition, targets: effect.targets, effect: effect.steps, text: fullText, span }];
}

function interpretableTrigger(effect: EffectParse): boolean {
	return staticallyInterpretable(effect, true) && triggerTargetsSupported(effect.targets);
}

// ---- Activated abilities --------------------------------------------------------------------

/** A colon before any quotation mark: "{2}, {T}: Draw a card." (not 'have "{T}: Add {C}."'). */
function costColon(body: string): number {
	const quoteMatch = body.match(/(?:^|\s)['"“‘]/);
	const quote = quoteMatch ? (quoteMatch.index ?? 0) + (quoteMatch[0].startsWith(' ') ? 1 : 0) : -1;
	const colon = body.indexOf(':');
	return colon > 0 && (quote < 0 || colon < quote) ? colon : -1;
}

const ACTIVATED_RESTRICTION_SENTENCES: ReadonlyArray<[RegExp, ActivationRestriction]> = [
	[/^activate only once each turn\.?$/, 'onceEachTurn'],
	[/^activate only during your turn\.?$/, 'duringYourTurn'],
	[/^activate only during your upkeep\.?$/, 'duringYourUpkeep'],
	[/^activate only during combat\.?$/, 'duringCombat']
];

const ACTIVATED_ZONE_RESTRICTION_SENTENCE =
	/^(?:activate only if ~ is in your (hand|graveyard)(?: and only (as a sorcery|once each turn|during your turn|during your upkeep|during combat))?|activate only (as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if ~ is in your (hand|graveyard))\.?$/;

function extractActivatedTimingAndRestrictions(
	effectText: string,
	effectStart: number,
	isLoyalty: boolean,
	isMana: boolean
): {
	timing: Timing;
	activationRestrictions: ActivationRestriction[];
	activationCondition?: Condition;
	explicitActivationZones?: ZoneType[];
	cleanedModalHeader: string;
} {
	const sentences = splitSentences(effectText, effectStart);
	const lowerTexts = sentences.map((s) => s.text.toLowerCase());
	let sorcery = isLoyalty || lowerTexts.some((s) => /^(?:activate|equip) only as a sorcery\.?$/.test(s));
	const activationRestrictions: ActivationRestriction[] = [];
	const addRestriction = (tag: ActivationRestriction) => {
		if (!activationRestrictions.includes(tag)) activationRestrictions.push(tag);
	};
	for (const [re, tag] of ACTIVATED_RESTRICTION_SENTENCES) {
		if (lowerTexts.some((s) => re.test(s))) addRestriction(tag);
	}
	let explicitActivationZones: ZoneType[] | undefined;
	for (const s of lowerTexts) {
		const zm = s.match(ACTIVATED_ZONE_RESTRICTION_SENTENCE);
		if (!zm) continue;
		const zone = (zm[1] ?? zm[4]) as 'hand' | 'graveyard';
		explicitActivationZones = [zone];
		const extra = zm[2] ?? zm[3];
		if (extra === 'as a sorcery') sorcery = true;
		else if (extra === 'once each turn') addRestriction('onceEachTurn');
		else if (extra === 'during your turn') addRestriction('duringYourTurn');
		else if (extra === 'during your upkeep') addRestriction('duringYourUpkeep');
		else if (extra === 'during combat') addRestriction('duringCombat');
	}
	const activationConditions: Condition[] = [];
	const strippedSpans: Span[] = [];
	for (const sent of sentences) {
		const condSpec = parseActivatedIfConditionSentence(sent.text);
		if (!condSpec) continue;
		activationConditions.push(condSpec.condition);
		strippedSpans.push(sent.span);
		if (condSpec.extra === 'as a sorcery') sorcery = true;
		else if (condSpec.extra === 'once each turn') addRestriction('onceEachTurn');
		else if (condSpec.extra === 'during your turn') addRestriction('duringYourTurn');
		else if (condSpec.extra === 'during your upkeep') addRestriction('duringYourUpkeep');
		else if (condSpec.extra === 'during combat') addRestriction('duringCombat');
	}
	const activationCondition: Condition | undefined =
		activationConditions.length === 1
			? activationConditions[0]
			: activationConditions.length > 1
				? { k: 'and', of: activationConditions }
				: undefined;
	const timing: Timing = isMana ? 'mana' : sorcery ? 'sorcery' : 'instant';
	let modalBase = effectText;
	if (strippedSpans.length > 0) {
		let rebuilt = '';
		let cursor = 0;
		for (const sp of strippedSpans) {
			const relStart = Math.max(0, sp.start - effectStart);
			const relEnd = Math.min(effectText.length, sp.end - effectStart);
			rebuilt += effectText.slice(cursor, relStart) + ' ';
			cursor = relEnd;
		}
		rebuilt += effectText.slice(cursor);
		modalBase = rebuilt;
	}
	const cleanedModalHeader = modalBase
		.replace(
			/\bactivate only (?:if ~ is in your (?:hand|graveyard)(?: and only (?:as a sorcery|once each turn|during your turn|during your upkeep|during combat))?|(?:as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if ~ is in your (?:hand|graveyard))\.?\s*/gi,
			' '
		)
		.replace(/\b(?:activate|equip) only as a sorcery\.?\s*/gi, ' ')
		.replace(/\bactivate only (?:once each turn|during your turn|during your upkeep|during combat)\.?\s*/gi, ' ')
		.trim();
	return {
		timing,
		activationRestrictions,
		...(activationCondition ? { activationCondition } : {}),
		explicitActivationZones,
		cleanedModalHeader
	};
}

function inferActivatedZones(
	costDefs: CostDef[],
	effectSteps: EffectStep[],
	explicitActivationZones?: ZoneType[]
): ZoneType[] | undefined {
	if (explicitActivationZones) return explicitActivationZones;
	if (costDefs.some((d) => d.k === 'discard' && d.filter === 'self')) {
		return ['hand'];
	}
	if (
		costDefs.some((d) => d.k === 'exileFrom' && d.zone === 'graveyard' && d.filter === 'self') ||
		effectSteps.some((s) => s.verb === 'move' && s.subject.k === 'self' && s.params?.from === 'graveyard')
	) {
		return ['graveyard'];
	}
	return undefined;
}

function activatedLine(ctx: Ctx, group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	const colon = costColon(line.body);
	if (colon < 0 || /^(?:when|whenever|at|choose)\b/i.test(line.body)) return null;

	const rewrites = detectWave4Rewrites(
		ctx,
		group.map((l) => l.text)
	);
	if (rewrites) {
		const origSpan = groupSpan(group);
		const origText = group.map((l) => l.text).join('\n');
		const savedManaTap = ctx.manaTapTaken;
		const rewrittenGroup = group.map((l) => rewriteNormalizedLine(l, rewrites));
		const adapted = activatedLineCore(ctx, rewrittenGroup);
		if (adapted && adapted.every((a) => a.kind !== 'unsupported')) {
			return adapted.map((a) => {
				const mapped = mapAbilityWave4(a, rewrites);
				return mapped.kind === 'activated'
					? { ...mapped, text: origText, span: origSpan }
					: mapped;
			});
		}
		ctx.manaTapTaken = savedManaTap;
	}
	return activatedLineCore(ctx, group);
}

function activatedLineCore(ctx: Ctx, group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	const colon = costColon(line.body);
	if (colon < 0 || /^(?:when|whenever|at|choose)\b/i.test(line.body)) return null;

	const span = groupSpan(group);
	const fullText = group.map((l) => l.text).join('\n');
	let costText = line.body.slice(0, colon).trim();
	let costStartOffset = line.bodySpan.start;
	const effectStart = line.bodySpan.start + colon + 1;
	const effectText = line.body.slice(colon + 1);

	let costKeyword: string | undefined;
	let kwIdOverride: string | undefined;
	let forcedZones: ZoneType[] | undefined;

	const exhaustMatch = costText.match(/^Exhaust\s*—\s*([\s\S]+)$/i);
	const boastMatch = !exhaustMatch ? costText.match(/^Boast\s*—\s*([\s\S]+)$/i) : null;
	const forecastMatch =
		!exhaustMatch && !boastMatch ? costText.match(/^Forecast\s*—\s*([\s\S]+)$/i) : null;

	if (exhaustMatch) {
		costKeyword = 'exhaust';
		kwIdOverride = `exhaust_${line.rawIndex}`;
		costStartOffset += costText.length - exhaustMatch[1].length;
		costText = exhaustMatch[1].trim();
	} else if (boastMatch) {
		costKeyword = 'boast';
		kwIdOverride = `boast_${line.rawIndex}`;
		costStartOffset += costText.length - boastMatch[1].length;
		costText = boastMatch[1].trim();
	} else if (forecastMatch) {
		costKeyword = 'forecast';
		kwIdOverride = `forecast_${line.rawIndex}`;
		forcedZones = ['hand'];
		costStartOffset += costText.length - forecastMatch[1].length;
		costText = forecastMatch[1].trim();
	}

	const loyalty = !costKeyword && ctx.isPlaneswalker ? costText.match(/^([+−-]?)(\d+|X)$/) : null;

	let cost: { defs: CostDef[]; unparsed: Span[] };
	if (loyalty) {
		const n = loyalty[2] === 'X' ? NaN : parseInt(loyalty[2], 10);
		cost = Number.isNaN(n)
			? { defs: [], unparsed: [{ start: line.bodySpan.start, end: line.bodySpan.start + colon }] }
			: { defs: [{ k: 'loyalty', delta: loyalty[1] === '+' || loyalty[1] === '' ? n : -n }], unparsed: [] };
	} else if (costKeyword === 'forecast') {
		const revealSelfRe = /(?:,\s*|^)reveal\s+(?:~|this\s+[a-z]+)\s+from\s+your\s+hand\s*$/i;
		if (!revealSelfRe.test(costText)) {
			cost = {
				defs: [],
				unparsed: [{ start: costStartOffset, end: line.bodySpan.start + colon }]
			};
		} else {
			const strippedCost = costText.replace(revealSelfRe, '').trim();
			const selfRevealDef: CostDef = {
				k: 'revealFromHand',
				count: { k: 'const', n: 1 },
				filter: 'self'
			};
			if (!strippedCost || strippedCost === '{0}') {
				cost = { defs: [selfRevealDef], unparsed: [] };
			} else {
				const sub = parseCost(strippedCost, costStartOffset);
				cost = {
					defs: [...sub.defs, selfRevealDef],
					unparsed: sub.unparsed
				};
			}
		}
	} else {
		cost = parseCost(costText, costStartOffset);
	}

	const costComplete = cost.unparsed.length === 0;
	if (group.length > 1) {
		const id = kwIdOverride ?? (loyalty ? `loyalty_${line.rawIndex}` : `act_${line.rawIndex}`);
		const {
			timing,
			activationRestrictions,
			activationCondition,
			explicitActivationZones,
			cleanedModalHeader
		} = extractActivatedTimingAndRestrictions(effectText, effectStart, Boolean(loyalty), false);
		const bullets = group.slice(1).map((b) => ({ text: b.text, start: b.span.start, end: b.span.end }));
		const modalParse = /^choose\b/i.test(cleanedModalHeader)
			? parseModal(cleanedModalHeader, bullets, 'activated', effectStart)
			: null;
		const modal = modalParse?.modal;
		const modalSteps = modal ? modal.modes.flatMap((m) => m.effect) : [];
		const activationZones =
			forcedZones ?? inferActivatedZones(cost.defs, modalSteps, explicitActivationZones);
		const effectOk =
			Boolean(modalParse && modal) &&
			modalParse!.unparsed.length === 0 &&
			modal!.modes.length > 0 &&
			modal!.min >= 0 &&
			modal!.max >= modal!.min &&
			modal!.modes.every((m) => staticallyInterpretable({ steps: m.effect, targets: m.targets, unparsed: [] }));
		if (!costComplete || !effectOk) {
			const gaps = [
				...cost.unparsed,
				...(effectOk ? [] : modalParse?.unparsed.length ? modalParse.unparsed : [{ start: effectStart, end: span.end }])
			];
			return [
				{
					...unsupported('unparsed', fullText, span, gaps),
					id,
					cost: cost.defs,
					costComplete,
					timing,
					isMana: false,
					...(costKeyword ? { costKeyword } : {}),
					...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
					...(activationCondition ? { activationCondition } : {})
				}
			];
		}
		return [
			{
				kind: 'activated',
				id,
				cost: cost.defs,
				targets: [],
				effect: [],
				modal,
				timing,
				isMana: false,
				...(costKeyword ? { costKeyword } : {}),
				...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
				...(activationCondition ? { activationCondition } : {}),
				...(activationZones ? { activationZones } : {}),
				text: fullText,
				span
			}
		];
	}

	const effect = parseEffects(effectText, effectStart, 'activated');
	const isMana =
		!loyalty &&
		!costKeyword &&
		effect.steps.length > 0 &&
		effect.targets.length === 0 &&
		effect.steps.some((s) => s.verb === 'addMana') &&
		effect.steps.every(
			(s) =>
				s.verb === 'addMana' ||
				(s.verb === 'freezeUntap' && s.subject.k === 'self' && !s.condition && !s.optional)
		);
	const { timing, activationRestrictions, activationCondition, explicitActivationZones } =
		extractActivatedTimingAndRestrictions(effectText, effectStart, Boolean(loyalty), isMana);
	const activationZones =
		forcedZones ?? inferActivatedZones(cost.defs, effect.steps, explicitActivationZones);
	const isManaTap =
		isMana && !kwIdOverride && cost.defs.length === 1 && cost.defs[0].k === 'tapSelf' && !ctx.manaTapTaken;
	const id = isManaTap
		? 'mana_tap'
		: kwIdOverride ?? (loyalty ? `loyalty_${line.rawIndex}` : `act_${line.rawIndex}`);
	if (isManaTap) ctx.manaTapTaken = true;

	const effectOk = isMana ? effect.unparsed.length === 0 && effect.steps.every(manaStepComplete) : staticallyInterpretable(effect);
	if (!costComplete || !effectOk) {
		const gaps = [...cost.unparsed, ...(effectOk ? [] : effect.unparsed.length > 0 ? effect.unparsed : [{ start: effectStart, end: span.end }])];
		const manaSteps = isMana && effect.steps.every(manaStepComplete) ? effect.steps : undefined;
		return [
			{
				...unsupported('unparsed', fullText, span, gaps),
				id,
				cost: cost.defs,
				costComplete,
				timing,
				isMana,
				...(costKeyword ? { costKeyword } : {}),
				...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
				...(activationCondition ? { activationCondition } : {}),
				...(manaSteps ? { effect: manaSteps } : {}),
				...(effect.targets.length > 0 ? { targets: effect.targets } : {})
			}
		];
	}
	const ability: ActivatedAbility = {
		kind: 'activated',
		id,
		cost: cost.defs,
		targets: effect.targets,
		effect: effect.steps,
		timing,
		isMana,
		...(costKeyword ? { costKeyword } : {}),
		...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
		...(activationCondition ? { activationCondition } : {}),
		...(activationZones ? { activationZones } : {}),
		text: fullText,
		span
	};
	return [ability];
}

function manaStepComplete(step: EffectStep): boolean {
	if (step.verb === 'freezeUntap') {
		return step.subject.k === 'self' && !step.condition && !step.optional;
	}
	return Boolean(
		step.params?.mana ||
			step.params?.manaChoice ||
			step.params?.manaWithChosenColor ||
			step.params?.manaBundles ||
			step.params?.manaCombinationColors
	);
}

function intrinsicManaAbility(ctx: Ctx, color: ManaColor): ActivatedAbility {
	const span = { start: 0, end: 0 };
	const id = ctx.manaTapTaken ? `mana_${color.toLowerCase()}` : 'mana_tap';
	ctx.manaTapTaken = true;
	return {
		kind: 'activated',
		id,
		cost: [{ k: 'tapSelf' }],
		targets: [],
		effect: [{ verb: 'addMana', subject: { k: 'none' }, amount: { k: 'const', n: 1 }, params: { mana: [color] }, span }],
		timing: 'mana',
		isMana: true,
		intrinsic: true,
		span
	};
}

// ---- Spells ---------------------------------------------------------------------------------

/** "Cast ~ only during combat." and friends (CR 601.3). */
const CAST_RESTRICTIONS: Array<[RegExp, NonNullable<SpellAbility['castRestrictions']>[number]]> = [
	[/^cast (?:~|this spell) only during combat\.?$/i, 'duringCombat'],
	[/^cast (?:~|this spell) only during your turn\.?$/i, 'duringYourTurn'],
	[/^cast (?:~|this spell) only before attackers are declared\.?$/i, 'beforeAttackers']
];

function compileSpreeOrTieredSpell(
	kind: 'spree' | 'tiered',
	lines: NormalizedLine[],
	span: Span,
	text: string,
	statics: AbilityDef[],
	additionalCosts: CostDef[],
	castRestrictions: NonNullable<SpellAbility['castRestrictions']>,
	costComplete: boolean,
	priorUnparsed: Span[]
): AbilityDef[] {
	const modes: ModalDef['modes'] = [];
	const perModeCosts: CostDef[][] = [];
	const unparsed = [...priorUnparsed];
	let sawHeader = false;

	for (const line of lines) {
		const trimmed = line.text.trim();
		if (!sawHeader && new RegExp(`^${kind}$`, 'i').test(line.body.trim())) {
			sawHeader = true;
			continue;
		}
		if (kind === 'spree' && /^\+\s+/.test(trimmed)) {
			const m = line.text.match(/^\s*\+\s*([^—]+?)\s*—\s*([\s\S]+)$/);
			if (!m) {
				unparsed.push(line.span);
				continue;
			}
			const rawCost = m[1].trim();
			const rawEffect = m[2];
			const effectOffset = line.text.length - rawEffect.length;
			const effectStart = line.span.start + effectOffset;
			const parsedCost = parseCost(rawCost, line.span.start);
			const costOk =
				parsedCost.unparsed.length === 0 &&
				parsedCost.defs.length > 0 &&
				parsedCost.defs.every(
					(d) => isCastPayableCostDef(d) && (d.k !== 'mana' || !/\{X\}/i.test(d.cost))
				);
			if (!costOk) {
				unparsed.push(...(parsedCost.unparsed.length > 0 ? parsedCost.unparsed : [line.span]));
			}
			const eff = parseEffects(rawEffect, effectStart, 'spell');
			if (eff.unparsed.length > 0 || !staticallyInterpretable(eff)) {
				unparsed.push(...(eff.unparsed.length > 0 ? eff.unparsed : [{ start: effectStart, end: line.span.end }]));
			}
			modes.push({ targets: eff.targets, effect: eff.steps, span: line.span });
			perModeCosts.push(parsedCost.defs);
			continue;
		}
		if (kind === 'tiered' && line.text.startsWith('•')) {
			const m = line.text.match(/^•\s*([^—]+?)\s*—\s*([^—]+?)\s*—\s*([\s\S]+)$/);
			if (!m) {
				unparsed.push(line.span);
				continue;
			}
			const rawCost = m[2].trim();
			const rawEffect = m[3];
			const effectOffset = line.text.length - rawEffect.length;
			const effectStart = line.span.start + effectOffset;
			const parsedCost =
				rawCost === '{0}'
					? { defs: [] as CostDef[], unparsed: [] as Span[] }
					: parseCost(rawCost, line.span.start);
			const costOk =
				parsedCost.unparsed.length === 0 &&
				(rawCost === '{0}' ||
					(parsedCost.defs.length > 0 &&
						parsedCost.defs.every(
							(d) => isCastPayableCostDef(d) && (d.k !== 'mana' || !/\{X\}/i.test(d.cost))
						)));
			if (!costOk) {
				unparsed.push(...(parsedCost.unparsed.length > 0 ? parsedCost.unparsed : [line.span]));
			}
			const eff = parseEffects(rawEffect, effectStart, 'spell');
			if (eff.unparsed.length > 0 || !staticallyInterpretable(eff)) {
				unparsed.push(...(eff.unparsed.length > 0 ? eff.unparsed : [{ start: effectStart, end: line.span.end }]));
			}
			modes.push({ targets: eff.targets, effect: eff.steps, span: line.span });
			perModeCosts.push(parsedCost.defs);
			continue;
		}
		const allPreConsumed = line.sentences.every(
			(s) =>
				Boolean(parseCostModifierSentence(s.text)) ||
				/^(?:~|this spell) can(?:'t|not) be countered\.?$/i.test(s.text) ||
				Boolean(parseAdditionalCostSentence(s.text, s.span.start)) ||
				CAST_RESTRICTIONS.some(([re]) => re.test(s.text))
		);
		if (!allPreConsumed) {
			unparsed.push(line.span);
		}
	}

	if (!sawHeader || modes.length === 0 || unparsed.length > 0) {
		const gaps = unparsed.length > 0 ? unparsed : [span];
		const u = unsupported('unparsed', text, span, gaps);
		return [
			...statics,
			{
				...u,
				id: 'cast',
				cost: additionalCosts,
				costComplete,
				...(castRestrictions.length > 0 ? { castRestrictions } : {})
			}
		];
	}

	const modal: ModalDef = {
		min: 1,
		max: kind === 'spree' ? modes.length : 1,
		modes,
		perModeCosts
	};
	const spell: SpellAbility = {
		kind: 'spell',
		additionalCosts,
		targets: [],
		effect: [],
		modal,
		span
	};
	if (castRestrictions.length > 0) spell.castRestrictions = castRestrictions;
	return [...statics, spell];
}

/**
 * The spell ability of an instant or sorcery. Statics written on the spell (cost reductions, "can't
 * be countered") become their own abilities; additional costs and cast restrictions go on the spell.
 */
function spellAbility(ctx: Ctx, norm: NormalizedFace, lines: NormalizedLine[]): AbilityDef[] {
	const rewrites = detectWave4Rewrites(
		ctx,
		lines.map((l) => l.text)
	);
	if (rewrites) {
		const origSpan: Span = { start: lines[0].span.start, end: lines[lines.length - 1].span.end };
		const rewrittenText = applyWave4TextRewrite(norm.text, rewrites);
		const rewrittenNormLines = norm.lines.map((l) => rewriteNormalizedLine(l, rewrites));
		const rewrittenNorm: NormalizedFace = { text: rewrittenText, lines: rewrittenNormLines };
		const lineIndices = new Set(lines.map((l) => l.rawIndex));
		const rewrittenSpellLines = rewrittenNormLines.filter((l) => lineIndices.has(l.rawIndex));
		const adapted = spellAbilityCore(rewrittenNorm, rewrittenSpellLines);
		if (adapted.every((a) => a.kind !== 'unsupported')) {
			return adapted.map((a) => {
				const mapped = mapAbilityWave4(a, rewrites);
				return mapped.kind === 'spell' ? { ...mapped, span: origSpan } : mapped;
			});
		}
	}
	return spellAbilityCore(norm, lines);
}

function spellAbilityCore(norm: NormalizedFace, lines: NormalizedLine[]): AbilityDef[] {
	const span = { start: lines[0].span.start, end: lines[lines.length - 1].span.end };
	const text = norm.text.slice(span.start, span.end);
	const statics: AbilityDef[] = [];
	const additionalCosts: CostDef[] = [];
	const castRestrictions: NonNullable<SpellAbility['castRestrictions']> = [];
	const unparsed: Span[] = [];
	let costComplete = true;

	for (const line of lines) {
		for (const s of line.sentences) {
			const costModifier = parseCostModifierSentence(s.text);
			if (costModifier) {
				statics.push({ kind: 'static', static: costModifier, span: s.span });
				continue;
			}
			if (/^(?:~|this spell) can(?:'t|not) be countered\.?$/i.test(s.text)) {
				const st: StaticDef = { k: 'restriction', affected: 'self', restriction: 'cantBeCountered' };
				statics.push({ kind: 'static', static: st, span: s.span });
				continue;
			}
			if (/^if ~ would be put into a graveyard from anywhere\b/i.test(s.text)) {
				const parsed = parseStaticAbility(s.text, s.span.start);
				if (parsed.unparsed.length === 0 && parsed.items.length > 0) {
					for (const item of parsed.items) {
						statics.push(
							item.kind === 'static'
								? { kind: 'static', static: item.static, span: s.span }
								: { kind: 'replacement', replacement: item.replacement, span: s.span }
						);
					}
					continue;
				}
			}
			const additional = parseAdditionalCostSentence(s.text, s.span.start);
			if (additional) {
				additionalCosts.push(...additional.defs);
				if (additional.unparsed.length > 0) {
					costComplete = false;
					unparsed.push(...additional.unparsed);
				}
				continue;
			}
			const restriction = CAST_RESTRICTIONS.find(([re]) => re.test(s.text));
			if (restriction) castRestrictions.push(restriction[1]);
		}
	}

	if (lines.some((l) => /^spree$/i.test(l.body.trim()))) {
		return compileSpreeOrTieredSpell(
			'spree',
			lines,
			span,
			text,
			statics,
			additionalCosts,
			castRestrictions,
			costComplete,
			unparsed
		);
	}
	if (lines.some((l) => /^tiered$/i.test(l.body.trim()))) {
		return compileSpreeOrTieredSpell(
			'tiered',
			lines,
			span,
			text,
			statics,
			additionalCosts,
			castRestrictions,
			costComplete,
			unparsed
		);
	}

	const include = new Set(lines.map((l) => l.rawIndex));
	const effect = parseSpellFace(norm, (l) => include.has(l.rawIndex));
	unparsed.push(...effect.unparsed);
	const interpretable = effect.modal ? modalInterpretable(effect) : staticallyInterpretable(effect);
	if (unparsed.length > 0 || !interpretable) {
		const gaps = unparsed.length > 0 ? unparsed : [span];
		const u = unsupported('unparsed', text, span, gaps);
		const fallbackTargets =
			effect.targets.length > 0 ? effect.targets : extractUnparsedTargets(text);
		return [
			...statics,
			{
				...u,
				id: 'cast',
				cost: additionalCosts,
				costComplete,
				...(fallbackTargets.length > 0 ? { targets: fallbackTargets } : {}),
				...(castRestrictions.length > 0 ? { castRestrictions } : {})
			}
		];
	}
	const spell: SpellAbility = {
		kind: 'spell',
		additionalCosts,
		targets: effect.modal ? [] : effect.targets,
		effect: effect.modal ? [] : effect.steps,
		modal: effect.modal,
		span
	};
	if (castRestrictions.length > 0) spell.castRestrictions = castRestrictions;
	return [...statics, spell];
}

/** A modal spell resolves on the interpreter when every mode does. */
function modalInterpretable(effect: EffectParse): boolean {
	const modal = effect.modal!;
	if (modal.modes.length === 0 || modal.min < 0 || modal.max < modal.min) return false;
	return modal.modes.every((m) => staticallyInterpretable({ steps: m.effect, targets: m.targets, unparsed: [] }));
}

// ---- Statics --------------------------------------------------------------------------------

/**
 * Statics and replacement effects (compiler/statics.ts), with the cost-modifier grammar first. One
 * line such as "Creatures you control get +1/+1 and have haste." produces two StaticDefs.
 */
function staticGroup(ctx: Ctx, group: NormalizedLine[]): AbilityDef[] {
	const rewrites = detectWave4Rewrites(
		ctx,
		group.map((l) => l.text)
	);
	if (rewrites) {
		const origSpan = groupSpan(group);
		const rewrittenGroup = group.map((l) => rewriteNormalizedLine(l, rewrites));
		const adapted = staticGroupCore(rewrittenGroup);
		if (adapted.every((a) => a.kind !== 'unsupported')) {
			return adapted.map((a) => ({ ...mapAbilityWave4(a, rewrites), span: origSpan }));
		}
	}
	return staticGroupCore(group);
}

function staticGroupCore(group: NormalizedLine[]): AbilityDef[] {
	const span = groupSpan(group);
	const text = group.map((l) => l.text).join('\n');
	if (group.length === 1) {
		const line = group[0];
		const costModifier = parseCostModifierSentence(line.body);
		if (costModifier) return [{ kind: 'static', static: costModifier, span }];
		const parsed = parseStaticAbility(line.body, line.bodySpan.start);
		if (parsed.unparsed.length === 0 && parsed.items.length > 0) {
			return parsed.items.map((item): AbilityDef =>
				item.kind === 'static'
					? { kind: 'static', static: item.static, span }
					: { kind: 'replacement', replacement: item.replacement, span }
			);
		}
		// CR 118.8: A permanent spell's mandatory/optional additional cost.
		const additional = parseAdditionalCostSentence(line.body, line.bodySpan.start);
		if (additional) {
			if (
				additional.unparsed.length === 0 &&
				additional.defs.length > 0 &&
				additional.defs.every(isCastPayableCostDef)
			) {
				return [
					{
						kind: 'static',
						static: { k: 'additionalCastCost', costs: additional.defs },
						span
					}
				];
			}
			return [
				{
					...unsupported('static_not_compiled', text, span, [span]),
					id: 'cast',
					cost: additional.defs,
					costComplete: additional.unparsed.length === 0
				}
			];
		}
	}
	return [unsupported('static_not_compiled', text, span, [span])];
}

// ---- Characteristics ------------------------------------------------------------------------

function parseStat(v: string | undefined): number | undefined {
	return v !== undefined && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined;
}

export function buildCharacteristicsForFace(
	face: ScryfallCard | ScryfallCardFace,
	_topCard?: ScryfallCard,
	_layout?: CardLayout
): Characteristics {
	return buildCharacteristics(face);
}

export function buildCharacteristics(card: ScryfallCard | ScryfallCardFace): Characteristics {
	const [left, right = ''] = card.typeLine.split(/\s+—\s+/);
	const words = left.split(/\s+/).filter(Boolean);
	const chars: Characteristics = {
		manaCost: card.manaCost,
		types: words.filter((w) => !SUPERTYPES.has(w)),
		subtypes: right.split(/\s+/).filter(Boolean),
		supertypes: words.filter((w) => SUPERTYPES.has(w)),
		colors: [...card.colors]
	};
	if (card.colorIndicator && card.colorIndicator.length > 0) {
		chars.colorIndicator = [...card.colorIndicator];
	}
	const power = parseStat(card.power);
	const toughness = parseStat(card.toughness);
	const loyalty = parseStat(card.loyalty);
	if (power !== undefined) chars.power = power;
	if (toughness !== undefined) chars.toughness = toughness;
	if (loyalty !== undefined) chars.loyalty = loyalty;
	if ((card.power !== undefined && power === undefined) || (card.toughness !== undefined && toughness === undefined)) {
		chars.ptDefinedByAbility = true;
	}
	return chars;
}

// ---- Helpers --------------------------------------------------------------------------------

function unsupported(reason: UnsupportedReason, text: string, span: Span, unparsed: Span[]): UnsupportedAbility {
	return { kind: 'unsupported', reason, text, span, unparsed: dedupeSpans(unparsed) };
}

function dedupeSpans(spans: Span[]): Span[] {
	const seen = new Set<string>();
	return spans
		.filter((s) => {
			const key = `${s.start}:${s.end}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.start - b.start);
}

export type { TargetSpec };
