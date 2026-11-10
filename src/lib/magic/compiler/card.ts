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
	SpellAbility,
	Span,
	StaticDef,
	TargetSpec,
	Timing,
	UnsupportedAbility,
	UnsupportedReason
} from '../ir.ts';
import type { ManaColor, ScryfallCard } from '../types.ts';
import { parseAdditionalCostSentence, parseCost, parseCostModifierSentence, parseObjectPhrase } from './costs.ts';
import { extractUnparsedTargets, parseEffects, parseSpellFace, type EffectParse } from './effects.ts';
import { staticallyInterpretable, triggerTargetsSupported } from './interpretable.ts';
import { normalizeFace, splitSentences, type NormalizedFace, type NormalizedLine } from './normalize.ts';
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

/**
 * Keywords the runtime implements. Anything else that parses as a keyword compiles to `unsupported`
 * with reason `keyword_not_implemented`. Partner is enforced at deck construction.
 */
const IMPLEMENTED_KEYWORDS = new Set([
	'changeling',
	'deathtouch',
	'defender',
	'double strike',
	'enchant',
	'equip',
	'fear',
	'first strike',
	'flash',
	'flying',
	'haste',
	'hexproof',
	'horsemanship',
	'indestructible',
	'infect',
	'intimidate',
	'lifelink',
	'menace',
	'overload',
	'partner',
	'protection',
	'prowess',
	'reach',
	'shadow',
	'shroud',
	'suspend',
	'trample',
	'vigilance',
	'ward'
]);

/** Keyword abilities (CR 702) recognised on a keyword line, whether or not they're implemented. */
const KNOWN_KEYWORDS = [
	...IMPLEMENTED_KEYWORDS,
	'absorb', 'affinity', 'afflict', 'afterlife', 'amplify', 'annihilator', 'ascend', 'aura swap',
	'awaken', 'backup', 'banding', 'bargain', 'battle cry', 'bestow', 'blitz', 'bloodthirst',
	'boast', 'bushido', 'buyback', 'cascade', 'casualty', 'champion', 'cipher', 'cleave',
	'companion', 'compleated', 'conspire', 'convoke', 'craft', 'crew', 'cumulative upkeep',
	'cycling', 'dash', 'daybound', 'decayed', 'delve', 'demonstrate', 'dethrone', 'devoid',
	'devour', 'disguise', 'disturb', 'double team', 'dredge', 'echo', 'embalm', 'emerge',
	'encore', 'enlist', 'entwine', 'epic', 'escalate', 'escape', 'eternalize', 'evoke', 'evolve',
	'exalted', 'exploit', 'extort', 'fabricate', 'fading', 'fear', 'flanking', 'flashback',
	'for mirrodin!', 'forecast', 'foretell', 'fortify', 'frenzy', 'friends forever', 'fuse',
	'gift', 'graft', 'gravestorm', 'haunt', 'hidden agenda', 'hideaway', 'horsemanship',
	'improvise', 'impending', 'ingest', 'intimidate', 'jump-start', 'kicker', 'landwalk',
	'level up', 'living metal', 'living weapon', 'madness', 'megamorph', 'melee', 'mentor',
	'miracle', 'modular', 'morph', 'more than meets the eye', 'multikicker', 'mutate', 'myriad',
	'nightbound', 'ninjutsu', 'offering', 'offspring', 'outlast', 'persist', 'phasing',
	'plot', 'poisonous', 'prototype', 'provoke', 'prowess', 'prowl', 'rampage', 'ravenous',
	'read ahead', 'rebound', 'reconfigure', 'recover', 'reinforce', 'renown', 'replicate',
	'retrace', 'riot', 'ripple', 'saddle', 'scavenge', 'shadow', 'skulk', 'soulbond',
	'soulshift', 'space sculptor', 'spectacle', 'splice', 'split second', 'squad', 'storm',
	'sunburst', 'surge', 'totem armor', 'training', 'transfigure', 'transmute', 'tribute',
	'umbra armor', 'undaunted', 'undying', 'unearth', 'unleash', 'vanishing', 'visit', 'ward',
	'wither', 'plainswalker', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk',
	'basic landcycling', 'landcycling', 'typecycling', 'toxic', 'station', 'exhaust', 'harmonize',
	'mobilize', 'web-slinging', 'sneak', 'firebending', 'waterbend', 'job select', 'warp'
].sort((a, b) => b.length - a.length);

// ---- Entry point ----------------------------------------------------------------------------

export function compileFaces(card: ScryfallCard): FaceDefinition[] {
	const characteristics = buildCharacteristics(card);
	const norm = normalizeFace(card.name, card.oracleText);

	if (card.backFace || card.oracleText.includes('\n//\n')) {
		const span = { start: 0, end: norm.text.length };
		return [{ name: card.name, characteristics, abilities: [unsupported('multiface', norm.text, span, [])] }];
	}

	const ctx: Ctx = {
		isSpell: characteristics.types.includes('Instant') || characteristics.types.includes('Sorcery'),
		isPlaneswalker: characteristics.types.includes('Planeswalker'),
		manaTapTaken: false
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
		// Saga chapter abilities ("I, II — ...") aren't modelled.
		if (line.abilityWord && /^[IVX]+(, [IVX]+)*$/.test(line.abilityWord)) {
			abilities.push(unsupported('unparsed', line.text, line.span, [line.bodySpan]));
			continue;
		}
		const out = keywordLine(line) ?? triggerLine(line) ?? activatedLine(ctx, line);
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

	return [{ name: card.name, characteristics, abilities }];
}

interface Ctx {
	isSpell: boolean;
	isPlaneswalker: boolean;
	/** The first "{T}: Add ..." ability gets the id `mana_tap`. */
	manaTapTaken: boolean;
}

// ---- Grouping -------------------------------------------------------------------------------

/** A modal header ("Choose one —") and its bullet lines form one ability. */
function groupLines(lines: NormalizedLine[]): NormalizedLine[][] {
	const groups: NormalizedLine[][] = [];
	for (const line of lines) {
		const prev = groups[groups.length - 1];
		if (prev && line.text.startsWith('•') && /—$/.test(prev[0].text)) prev.push(line);
		else groups.push([line]);
	}
	return groups;
}

function groupSpan(group: NormalizedLine[]): Span {
	return { start: group[0].span.start, end: group[group.length - 1].span.end };
}

// ---- Keywords -------------------------------------------------------------------------------

function parseKeyword(part: string): KeywordDef | null {
	const low = part.toLowerCase();
	for (const kw of KNOWN_KEYWORDS) {
		if (low === kw) return { name: kw };
		if (!low.startsWith(kw)) continue;
		const rest = part.slice(kw.length);
		if (!/^[\s—-]/.test(rest)) continue;
		const rawArg = rest.replace(/^\s*[—-]?\s*/, '').trim();
		const arg = kw === 'ward' ? rawArg.replace(/\.$/, '').trim() : rawArg;
		if (/^(\{[^}]+\})+$/.test(arg)) return { name: kw, cost: arg };
		if (/^\d+$/.test(arg)) return { name: kw, n: parseInt(arg, 10) };
		const nCost = arg.match(/^(\d+)\s*—\s*((?:\{[^}]+\})+)$/);
		if (nCost) return { name: kw, n: parseInt(nCost[1], 10), cost: nCost[2] };
		if (/^from\b/i.test(arg) || kw === 'enchant' || kw === 'protection') {
			return { name: kw, param: arg.replace(/^from\s+/i, '') };
		}
		if (arg && !arg.endsWith('.')) return { name: kw, param: arg };
	}
	return null;
}

/** "Flying, vigilance", "Equip {2}", "Protection from black". A trailing period means an effect. */
function keywordLine(line: NormalizedLine): AbilityDef[] | null {
	if (line.abilityWord || (/\.$/.test(line.body) && !/^ward\s*[—-]/i.test(line.body))) return null;
	// "Enchant creature, land, or planeswalker" and "Protection from white, from blue" are one keyword.
	const parts = /^(?:enchant|protection from|hexproof from)\b/i.test(line.body) ? [line.body] : line.body.split(/,\s*/);
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
		out.push({ kind: 'keyword', keyword, span, ...(keyword.name === 'equip' ? { id: `equip_${line.rawIndex}` } : {}) });
	});
	return out;
}

// ---- Triggered abilities --------------------------------------------------------------------

function triggerLine(line: NormalizedLine): AbilityDef[] | null {
	if (!/^(when|whenever|at)\b/i.test(line.body)) return null;
	const span = line.span;
	const head = parseTriggerHeader(line.body, line.bodySpan.start);
	if (!head || !head.trigger || head.unparsed.length > 0) {
		return [unsupported('unparsed', line.text, span, head?.unparsed.length ? head.unparsed : [line.bodySpan])];
	}
	const { trigger, condition } = head;
	if (runtimeTriggerProblem(trigger)) {
		const headSpan = { start: line.bodySpan.start, end: head.effectStart };
		return [unsupported('event_not_implemented', line.text, span, [headSpan])];
	}
	const effect = parseEffects(line.text.slice(head.effectStart - line.span.start), head.effectStart, 'triggered');
	if (!interpretableTrigger(effect)) {
		const gaps = effect.unparsed.length > 0 ? effect.unparsed : [{ start: head.effectStart, end: span.end }];
		return [{ ...unsupported('unparsed', line.text, span, gaps), trigger, condition }];
	}
	return [{ kind: 'triggered', trigger, condition, targets: effect.targets, effect: effect.steps, text: line.text, span }];
}

function interpretableTrigger(effect: EffectParse): boolean {
	return staticallyInterpretable(effect, true) && triggerTargetsSupported(effect.targets);
}

// ---- Activated abilities --------------------------------------------------------------------

/** A colon before any quotation mark: "{2}, {T}: Draw a card." (not 'have "{T}: Add {C}."'). */
function costColon(body: string): number {
	const quote = body.search(/["“]/);
	const colon = body.indexOf(':');
	return colon > 0 && (quote < 0 || colon < quote) ? colon : -1;
}

function activatedLine(ctx: Ctx, line: NormalizedLine): AbilityDef[] | null {
	const colon = costColon(line.body);
	if (colon < 0 || /^(?:when|whenever|at|choose)\b/i.test(line.body)) return null;

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

	const effect = parseEffects(effectText, effectStart, 'activated');
	const sentences = splitSentences(effectText, effectStart).map((s) => s.text.toLowerCase());
	const isMana =
		!loyalty &&
		effect.steps.length > 0 &&
		effect.targets.length === 0 &&
		effect.steps.every((s) => s.verb === 'addMana');
	const sorcery = Boolean(loyalty) || sentences.some((s) => /^(?:activate|equip) only as a sorcery\.?$/.test(s));
	const timing: Timing = isMana ? 'mana' : sorcery ? 'sorcery' : 'instant';
	const activationRestrictions: ActivationRestriction[] = [];
	if (sentences.some((s) => /^activate only once each turn\.?$/.test(s))) {
		activationRestrictions.push('onceEachTurn');
	}
	if (sentences.some((s) => /^activate only during your turn\.?$/.test(s))) {
		activationRestrictions.push('duringYourTurn');
	}
	if (sentences.some((s) => /^activate only during your upkeep\.?$/.test(s))) {
		activationRestrictions.push('duringYourUpkeep');
	}
	if (sentences.some((s) => /^activate only during combat\.?$/.test(s))) {
		activationRestrictions.push('duringCombat');
	}
	const isManaTap = isMana && cost.defs.length === 1 && cost.defs[0].k === 'tapSelf' && !ctx.manaTapTaken;
	const id = isManaTap ? 'mana_tap' : loyalty ? `loyalty_${line.rawIndex}` : `act_${line.rawIndex}`;
	if (isManaTap) ctx.manaTapTaken = true;

	const costComplete = cost.unparsed.length === 0;
	const effectOk = isMana ? effect.unparsed.length === 0 && effect.steps.every(manaStepComplete) : staticallyInterpretable(effect);
	if (!costComplete || !effectOk) {
		const gaps = [...cost.unparsed, ...(effectOk ? [] : effect.unparsed.length > 0 ? effect.unparsed : [{ start: effectStart, end: line.span.end }])];
		const manaSteps = isMana && effect.steps.every(manaStepComplete) ? effect.steps : undefined;
		return [
			{
				...unsupported('unparsed', line.text, line.span, gaps),
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
		text: line.text,
		span: line.span
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

/** A modal spell resolves on the interpreter when every mode does (each with at most one target). */
function modalInterpretable(effect: EffectParse): boolean {
	const modal = effect.modal!;
	if (modal.modes.length === 0 || modal.min < 0 || modal.max < modal.min) return false;
	return modal.modes.every((m) => m.targets.length <= 1 && staticallyInterpretable({ steps: m.effect, targets: m.targets, unparsed: [] }));
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

export function buildCharacteristics(card: ScryfallCard): Characteristics {
	const [left, right = ''] = card.typeLine.split(/\s+—\s+/);
	const words = left.split(/\s+/).filter(Boolean);
	const chars: Characteristics = {
		manaCost: card.manaCost,
		types: words.filter((w) => !SUPERTYPES.has(w)),
		subtypes: right.split(/\s+/).filter(Boolean),
		supertypes: words.filter((w) => SUPERTYPES.has(w)),
		colors: [...card.colors]
	};
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
