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
	Characteristics,
	CostDef,
	EffectStep,
	FaceDefinition,
	KeywordDef,
	ObjectFilter,
	SpellAbility,
	Span,
	StaticDef,
	TargetSpec,
	Timing,
	TriggerDef,
	UnsupportedAbility,
	UnsupportedReason
} from '../ir.ts';
import { getKeywordSpec, IMPLEMENTED_KEYWORDS, KNOWN_KEYWORDS } from '../keywords.ts';
import { getCardFaces } from '../scryfall.ts';
import type { CardLayout, ManaColor, ScryfallCard, ScryfallCardFace, ZoneType } from '../types.ts';
import { parseAdditionalCostSentence, parseCost, parseCostModifierSentence, parseObjectPhrase } from './costs.ts';
import { extractUnparsedTargets, parseEffects, parseModal, parseSpellFace, type EffectParse } from './effects.ts';
import { staticallyInterpretable, triggerTargetsSupported } from './interpretable.ts';
import { normalizeFace, splitSentences, type NormalizedFace, type NormalizedLine } from './normalize.ts';
import { canonicalKickerTag } from './triggers.ts';
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

	const ctx: Ctx = {
		isSpell: characteristics.types.includes('Instant') || characteristics.types.includes('Sorcery'),
		isPlaneswalker: characteristics.types.includes('Planeswalker'),
		manaTapTaken: false,
		hasReadAhead: false
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

	for (const group of groupLines(norm.lines)) {
		const line = group[0];
		const sagaOut = sagaChapterLine(group);
		if (sagaOut) {
			abilities.push(...sagaOut);
			continue;
		}
		const skipSpellDelayedTrigger =
			ctx.isSpell &&
			/^at (?:the beginning of (?:the next|that turn's)|(?:the )?end of combat)\b/i.test(line.body);
		const out =
			(group.length === 1 ? keywordLine(ctx, line) : null) ??
			(skipSpellDelayedTrigger ? null : triggerLine(group)) ??
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
		} else abilities.push(...staticGroup(group));
	}
	if (spellLines.length > 0) abilities.push(...spellAbility(norm, spellLines));

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
		...(ctx.hasReadAhead ? { hasReadAhead: true } : {})
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
	/** The first "{T}: Add ..." ability gets the id `mana_tap`. */
	manaTapTaken: boolean;
	hasReadAhead: boolean;
}

// ---- Grouping -------------------------------------------------------------------------------

/** A modal header and its bullet lines form one ability. */
function groupLines(lines: NormalizedLine[]): NormalizedLine[][] {
	const groups: NormalizedLine[][] = [];
	for (const line of lines) {
		const prev = groups[groups.length - 1];
		if (prev && line.text.startsWith('•')) prev.push(line);
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
			kw === 'cycling' ||
			kw === 'basic landcycling' ||
			kw === 'landcycling'
				? rawArg.replace(/\.$/, '').trim()
				: rawArg;
		if (/^(\{[^}]+\})+$/.test(arg)) return { name: kw, cost: arg };
		if (/^\d+$/.test(arg)) return { name: kw, n: parseInt(arg, 10) };
		const nCost = arg.match(/^(\d+)\s*—\s*((?:\{[^}]+\})+)$/);
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
		const filter = quality.toLowerCase() === 'type' ? null : parseObjectPhrase(quality);
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
	return parseObjectPhrase(phrase);
}

/** "Flying, vigilance", "Equip {2}", "Protection from black". A trailing period means an effect. */
function keywordLine(ctx: Ctx, line: NormalizedLine): AbilityDef[] | null {
	if (
		line.abilityWord ||
		(/\.$/.test(line.body) &&
			!/^(?:ward|flashback|kicker|multikicker|morph|megamorph|disguise|unearth|buyback|evoke|escape|cycling|(?:[a-z][a-z -]*\s+)?[a-z]*cycling)\s*[—-]/i.test(
				line.body
			))
	) {
		return null;
	}
	// "Enchant creature, land, or planeswalker", "Protection from white, from blue", and composite
	// dash costs ("Ward—...", "Flashback—...", "Kicker—...", "Morph—...", "Cycling—...", "Escape—...") are one keyword.
	const parts =
		/^(?:enchant|protection from|hexproof from|partner with|(?:ward|flashback|kicker|multikicker|morph|megamorph|disguise|unearth|buyback|evoke|escape|cycling|(?:[a-z][a-z -]*\s+)?[a-z]*cycling)\s*[—-])/i.test(
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
		// Equip is an activated ability (CR 702.6a): "Equip {N}" or "Equip [quality] {N}".
		if (keyword.name === 'equip' && !keyword.cost) {
			const q = keyword.param?.match(/^([A-Za-z ]+?)\s+creature\s*((?:\{[^}]+\})+)$/) ?? keyword.param?.match(/^([A-Za-z ]+?)\s*((?:\{[^}]+\})+)$/);
			if (q) {
				keyword.cost = q[2];
				const words = q[1].trim().split(/\s+/);
				keyword.equipFilter = {};
				for (const w of words) {
					if (/^legendary$/i.test(w)) keyword.equipFilter.supertypes = ['Legendary'];
					else if (!/^creature$/i.test(w)) keyword.equipFilter.subtypes = [...(keyword.equipFilter.subtypes ?? []), w[0].toUpperCase() + w.slice(1)];
				}
				delete keyword.param;
			} else implemented = false;
		}
		if (keyword.name === 'ward') {
			const wardCost = keyword.cost ?? keyword.param ?? '';
			const parsed = parseCost(wardCost);
			const singleDef = parsed.defs.length === 1 && parsed.unparsed.length === 0 ? parsed.defs[0] : undefined;
			const supportedWardCost = Boolean(
				singleDef &&
					((singleDef.k === 'mana' && !/\{X\}/i.test(singleDef.cost)) ||
						(singleDef.k === 'payLife' && singleDef.amount.k === 'const'))
			);
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
			keyword.name === 'escape'
		) {
			const kwCost = keyword.cost ?? keyword.param ?? '';
			const parsed = parseCost(kwCost);
			if (parsed.unparsed.length > 0 || parsed.defs.length === 0) {
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
		if (
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
				const filter = parseObjectPhrase((keyword.param ?? '').trim());
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
		const unearthId = i === 0 ? `unearth_${line.rawIndex}` : `unearth_${line.rawIndex}_${i}`;
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
						: keyword.name === 'unearth'
							? { id: unearthId }
							: {})
		});
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

function triggerLine(group: NormalizedLine[]): AbilityDef[] | null {
	const line = group[0];
	if (!/^(when|whenever|at)\b/i.test(line.body)) return null;
	const span = groupSpan(group);
	const fullText = group.map((l) => l.text).join('\n');
	const head = parseTriggerHeader(line.body, line.bodySpan.start);
	if (!head || !head.trigger || head.unparsed.length > 0) {
		return [unsupported('unparsed', fullText, span, head?.unparsed.length ? head.unparsed : [line.bodySpan])];
	}
	const { trigger, condition } = head;
	if (runtimeTriggerProblem(trigger)) {
		const headSpan = { start: line.bodySpan.start, end: head.effectStart };
		return [unsupported('event_not_implemented', fullText, span, [headSpan])];
	}

	let headerEffectText = line.text.slice(head.effectStart - line.span.start);
	const headerSentences = splitSentences(headerEffectText, head.effectStart);
	if (
		headerSentences.length >= 2 &&
		/^this ability triggers only once each turn\.?$/i.test(
			headerSentences[headerSentences.length - 1].text.trim()
		)
	) {
		trigger.onlyOncePerTurn = true;
		const lastSentence = headerSentences[headerSentences.length - 1];
		headerEffectText = headerEffectText.slice(0, lastSentence.span.start - head.effectStart).trimEnd();
	}
	if (group.length > 1) {
		const bullets = group.slice(1).map((b) => ({ text: b.text, start: b.span.start, end: b.span.end }));
		const modalParse = /^choose\b/i.test(headerEffectText.trim())
			? parseModal(headerEffectText, bullets, 'triggered', head.effectStart)
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
				: [{ start: head.effectStart, end: span.end }];
			return [{ ...unsupported('unparsed', fullText, span, gaps), trigger, condition }];
		}
		return [{ kind: 'triggered', trigger, condition, targets: [], effect: [], modal, text: fullText, span }];
	}

	const effect = parseEffects(headerEffectText, head.effectStart, 'triggered');
	if (!interpretableTrigger(effect)) {
		const gaps = effect.unparsed.length > 0 ? effect.unparsed : [{ start: head.effectStart, end: span.end }];
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
	const timing: Timing = isMana ? 'mana' : sorcery ? 'sorcery' : 'instant';
	const cleanedModalHeader = effectText
		.replace(
			/\bactivate only (?:if ~ is in your (?:hand|graveyard)(?: and only (?:as a sorcery|once each turn|during your turn|during your upkeep|during combat))?|(?:as a sorcery|once each turn|during your turn|during your upkeep|during combat) and only if ~ is in your (?:hand|graveyard))\.?\s*/gi,
			' '
		)
		.replace(/\b(?:activate|equip) only as a sorcery\.?\s*/gi, ' ')
		.replace(/\bactivate only (?:once each turn|during your turn|during your upkeep|during combat)\.?\s*/gi, ' ')
		.trim();
	return { timing, activationRestrictions, explicitActivationZones, cleanedModalHeader };
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

	const span = groupSpan(group);
	const fullText = group.map((l) => l.text).join('\n');
	const costText = line.body.slice(0, colon).trim();
	const effectStart = line.bodySpan.start + colon + 1;
	const effectText = line.body.slice(colon + 1);
	const loyalty = ctx.isPlaneswalker ? costText.match(/^([+−-]?)(\d+|X)$/) : null;

	let cost: { defs: CostDef[]; unparsed: Span[] };
	if (loyalty) {
		const n = loyalty[2] === 'X' ? NaN : parseInt(loyalty[2], 10);
		cost = Number.isNaN(n)
			? { defs: [], unparsed: [{ start: line.bodySpan.start, end: line.bodySpan.start + colon }] }
			: { defs: [{ k: 'loyalty', delta: loyalty[1] === '+' || loyalty[1] === '' ? n : -n }], unparsed: [] };
	} else {
		cost = parseCost(costText, line.bodySpan.start);
	}

	const costComplete = cost.unparsed.length === 0;
	if (group.length > 1) {
		const id = loyalty ? `loyalty_${line.rawIndex}` : `act_${line.rawIndex}`;
		const { timing, activationRestrictions, explicitActivationZones, cleanedModalHeader } =
			extractActivatedTimingAndRestrictions(effectText, effectStart, Boolean(loyalty), false);
		const bullets = group.slice(1).map((b) => ({ text: b.text, start: b.span.start, end: b.span.end }));
		const modalParse = /^choose\b/i.test(cleanedModalHeader)
			? parseModal(cleanedModalHeader, bullets, 'activated', effectStart)
			: null;
		const modal = modalParse?.modal;
		const modalSteps = modal ? modal.modes.flatMap((m) => m.effect) : [];
		const activationZones = inferActivatedZones(cost.defs, modalSteps, explicitActivationZones);
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
					...(activationRestrictions.length > 0 ? { activationRestrictions } : {})
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
				...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
				...(activationZones ? { activationZones } : {}),
				text: fullText,
				span
			}
		];
	}

	const effect = parseEffects(effectText, effectStart, 'activated');
	const isMana =
		!loyalty &&
		effect.steps.length > 0 &&
		effect.targets.length === 0 &&
		effect.steps.every((s) => s.verb === 'addMana');
	const { timing, activationRestrictions, explicitActivationZones } = extractActivatedTimingAndRestrictions(
		effectText,
		effectStart,
		Boolean(loyalty),
		isMana
	);
	const activationZones = inferActivatedZones(cost.defs, effect.steps, explicitActivationZones);
	const isManaTap = isMana && cost.defs.length === 1 && cost.defs[0].k === 'tapSelf' && !ctx.manaTapTaken;
	const id = isManaTap ? 'mana_tap' : loyalty ? `loyalty_${line.rawIndex}` : `act_${line.rawIndex}`;
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
				...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
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
		...(activationRestrictions.length > 0 ? { activationRestrictions } : {}),
		...(activationZones ? { activationZones } : {}),
		text: fullText,
		span
	};
	return [ability];
}

function manaStepComplete(step: EffectStep): boolean {
	return Boolean(step.params?.mana || step.params?.manaChoice);
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

/**
 * The spell ability of an instant or sorcery. Statics written on the spell (cost reductions, "can't
 * be countered") become their own abilities; additional costs and cast restrictions go on the spell.
 */
function spellAbility(norm: NormalizedFace, lines: NormalizedLine[]): AbilityDef[] {
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
function staticGroup(group: NormalizedLine[]): AbilityDef[] {
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
		// A permanent spell's additional cost. The IR has no ability kind for it, so it stays
		// unsupported but carries the parsed cost; the runtime still pays it (Phase 4).
		const additional = parseAdditionalCostSentence(line.body, line.bodySpan.start);
		if (additional) {
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
