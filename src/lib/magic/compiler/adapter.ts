/**
 * Phase 1 adapter (ENGINE_ARCHITECTURE_PLAN.md section 3, Phase 1 step 2).
 *
 * Converts what today's parsers (getCardRuleTree, parseActivatedAbilities,
 * parseStructuredTriggeredAbilities, parseSpellOrAbilityEffects) understand about a card into IR.
 * It doesn't change behaviour; it measures it. Every ability line or effect sentence the legacy
 * parsers don't claim becomes an `unsupported` ability, so coverage is reported honestly.
 *
 * Rules for this file:
 * - Legacy parsers always get the original card (they match on the card's name). Normalised text is
 *   only used for spans, sentence splitting and templates.
 * - Legacy parsers always get a fixed WUBRG commander identity. Identity-dependent mana is
 *   represented symbolically, so the result doesn't depend on whose deck the card is in.
 *
 * Phase 3 onwards replaces this file one ability type at a time with a real grammar.
 */
import {
	detectTargetRequirement,
	parseAdditionalCostsAndRestrictions,
	parseDelayedTriggersFromSpell,
	parseSpellOrAbilityEffects,
	parseStructuredTriggeredAbilities
} from '../oracle.ts';
import { parseAdditionalCostSentence, parseCost, parseCostModifierSentence } from './costs.ts';
import {
	getCardRuleTree,
	type ActionRuleNode,
	type BoardModifierHookNode,
	type CardRuleTree,
	type TriggerRuleNode
} from '../ruleTree.ts';
import type {
	LibrarySearchSpec,
	ManaColor,
	ParsedEffect,
	ScryfallCard,
	StructuredTriggeredAbility,
	TargetRequirementInfo,
	TriggerCondition
} from '../types.ts';
import type {
	AbilityDef,
	ActivatedAbility,
	Amount,
	Characteristics,
	Condition,
	CostDef,
	EffectStep,
	FaceDefinition,
	KeywordDef,
	ModalDef,
	ObjectFilter,
	Ref,
	Selector,
	Span,
	StaticDef,
	TargetSpec,
	TriggerDef,
	UnsupportedAbility,
	UnsupportedReason
} from '../ir.ts';
import {
	denormalize,
	normalizeFace,
	splitSentences,
	type NormalizedLine,
	type NormalizedSentence
} from './normalize.ts';
import { parseTriggerHeader, runtimeTriggerProblem, setLegacyTriggerExecution } from './triggers.ts';

const ALL_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Elite', 'Host']);
const CARD_TYPES = new Set([
	'Artifact',
	'Battle',
	'Creature',
	'Enchantment',
	'Instant',
	'Kindred',
	'Land',
	'Planeswalker',
	'Sorcery',
	'Tribal'
]);
const BASIC_LAND_MANA: Record<string, ManaColor> = {
	Plains: 'W',
	Island: 'U',
	Swamp: 'B',
	Mountain: 'R',
	Forest: 'G'
};

/**
 * Keywords the runtime implements today. Anything else that parses as a keyword compiles to
 * `unsupported` with reason `keyword_not_implemented`. Partner is enforced at deck construction.
 */
const IMPLEMENTED_KEYWORDS = new Set([
	'changeling',
	'deathtouch',
	'defender',
	'double strike',
	'enchant',
	'equip',
	'first strike',
	'flash',
	'flying',
	'haste',
	'hexproof',
	'indestructible',
	'infect',
	'lifelink',
	'menace',
	'overload',
	'partner',
	'protection',
	'reach',
	'shroud',
	'suspend',
	'trample',
	'vigilance'
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

// Sentences the legacy parsers handle as part of a neighbouring sentence or as a timing rule.
const NEUTRAL_SENTENCES: RegExp[] = [
	/^then shuffle\.$/i,
	/^you may shuffle\.$/i,
	// The engine has no regeneration, so "can't be regenerated" always holds.
	/^(?:it|they) can't be regenerated\.$/i,
	/^activate only as a sorcery\.$/i,
	/^equip only as a sorcery\.$/i
];

// ---- Entry point ----------------------------------------------------------------------------

/** What the adapter decided about one cost, for comparing against the cost grammar. */
export interface LegacyCostClaim {
	kind: 'activated' | 'additional';
	/** Index of the line in the original rules text. */
	rawIndex: number;
	/** Normalised cost text. */
	text: string;
	defs: CostDef[];
	/** True if every part of the cost was understood. */
	complete: boolean;
}

/** What the adapter decided about one trigger condition, for comparing against the trigger grammar. */
export interface LegacyTriggerClaim {
	rawIndex: number;
	trigger: TriggerDef;
	condition?: Condition;
	/** False when the legacy parser matched the line but the runtime would not honour it as written. */
	complete: boolean;
}

/** What the adapter decided about one ability's effect, for comparing against the effect grammar. */
export interface LegacyEffectClaim {
	kind: 'spell' | 'activated' | 'triggered';
	/** Index of the (first) line in the original rules text. */
	rawIndex: number;
	steps: EffectStep[];
	modal?: ModalDef;
	/** True if every effect sentence was claimed and translated. */
	complete: boolean;
}

/** Decisions the adapter made, collected for the grammar comparison scripts. */
export interface AdapterLog {
	costs: LegacyCostClaim[];
	triggers: LegacyTriggerClaim[];
	/** Optional so older callers needn't pass it (scripts/magic-effects-diff.ts does). */
	effects?: LegacyEffectClaim[];
}

/** Pass `log` to collect the adapter's decisions (scripts/magic-costs-diff.ts, magic-triggers-diff.ts). */
export function adaptCard(card: ScryfallCard, log?: AdapterLog): FaceDefinition[] {
	const characteristics = buildCharacteristics(card);

	if (card.backFace || card.oracleText.includes('\n//\n')) {
		const norm = normalizeFace(card.name, card.oracleText);
		const span = { start: 0, end: norm.text.length };
		return [
			{
				name: card.name,
				characteristics,
				abilities: [unsupported('multiface', norm.text, span, [])]
			}
		];
	}

	const norm = normalizeFace(card.name, card.oracleText);
	const ctx = new AdapterContext(card, log);
	const abilities: AbilityDef[] = [];
	const spellLines: NormalizedLine[] = [];

	for (const typeName of characteristics.subtypes) {
		const color = BASIC_LAND_MANA[typeName];
		if (color && characteristics.types.includes('Land')) {
			abilities.push(intrinsicManaAbility(color));
		}
	}

	for (const group of groupLines(norm.lines)) {
		const line = group[0];
		// Saga chapter abilities ("I, II — ...") are triggered abilities the legacy code doesn't model.
		if (line.abilityWord && /^[IVX]+(, [IVX]+)*$/.test(line.abilityWord)) {
			abilities.push(unsupported('unparsed', line.text, line.span, [line.bodySpan]));
			continue;
		}
		const out = adaptKeywordLine(line) ?? adaptTrigger(ctx, line) ?? adaptActivated(ctx, line);
		if (out) {
			abilities.push(...out);
		} else if (ctx.isInstantOrSorcery) {
			spellLines.push(...group);
		} else {
			abilities.push(adaptStatic(ctx, group));
		}
	}

	if (spellLines.length > 0) abilities.push(...adaptSpell(ctx, spellLines));

	return [{ name: card.name, characteristics, abilities }];
}

class AdapterContext {
	readonly card: ScryfallCard;
	readonly isInstantOrSorcery: boolean;
	readonly tree: CardRuleTree;
	readonly structured: Array<{ type: 'etb' | 'attack' | 'dies' | 'upkeep' | 'end_step'; ab: StructuredTriggeredAbility }>;
	readonly log?: AdapterLog;
	private manaTapClaimed = false;

	constructor(card: ScryfallCard, log?: AdapterLog) {
		this.card = card;
		this.log = log;
		this.isInstantOrSorcery = card.typeLine.includes('Instant') || card.typeLine.includes('Sorcery');
		this.tree = getCardRuleTree(card, ALL_COLORS);
		this.structured = (['etb', 'attack', 'dies', 'upkeep', 'end_step'] as const).flatMap((type) =>
			parseStructuredTriggeredAbilities(card, type).map((ab) => ({ type, ab }))
		);
	}

	/** The legacy `mana_tap` ability covers one "{T}: Add ..." line; only the first can claim it. */
	claimManaTap(): ActionRuleNode | undefined {
		if (this.manaTapClaimed) return undefined;
		const node = this.tree.actions.find((a) => a.id === 'mana_tap');
		if (node) this.manaTapClaimed = true;
		return node;
	}
}

// ---- Grouping -------------------------------------------------------------------------------

/** A modal header ("Choose one —") and its bullet lines form one ability. */
function groupLines(lines: NormalizedLine[]): NormalizedLine[][] {
	const groups: NormalizedLine[][] = [];
	for (const line of lines) {
		const prev = groups[groups.length - 1];
		if (prev && line.text.startsWith('•') && /—$/.test(prev[0].text)) {
			prev.push(line);
		} else {
			groups.push([line]);
		}
	}
	return groups;
}

function groupSpan(group: NormalizedLine[]): Span {
	return { start: group[0].span.start, end: group[group.length - 1].span.end };
}

function groupText(group: NormalizedLine[]): string {
	return group.map((l) => l.text).join('\n');
}

// ---- Keywords -------------------------------------------------------------------------------

function parseKeyword(part: string): KeywordDef | null {
	const low = part.toLowerCase();
	for (const kw of KNOWN_KEYWORDS) {
		if (low === kw) return { name: kw };
		if (!low.startsWith(kw)) continue;
		const rest = part.slice(kw.length);
		if (!/^[\s—-]/.test(rest)) continue;
		const arg = rest.replace(/^\s*[—-]?\s*/, '').trim();
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
function adaptKeywordLine(line: NormalizedLine): AbilityDef[] | null {
	if (line.abilityWord || /\.$/.test(line.body)) return null;
	// "Enchant creature, land, or planeswalker" and "Protection from white, from blue" are one keyword.
	const parts = /^(?:enchant|protection from|hexproof from)\b/i.test(line.body)
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
		const implemented =
			IMPLEMENTED_KEYWORDS.has(keyword.name) &&
			!(keyword.name === 'hexproof' && keyword.param) &&
			!(keyword.name === 'equip' && keyword.param);
		out.push(
			implemented
				? { kind: 'keyword', keyword, span }
				: unsupported('keyword_not_implemented', part, span, [span])
		);
	});
	return out;
}

// ---- Triggered abilities --------------------------------------------------------------------

function adaptTrigger(ctx: AdapterContext, line: NormalizedLine): AbilityDef[] | null {
	if (!/^(when|whenever|at)\b/i.test(line.body)) return null;
	const span = line.span;

	// Legacy decisions, for the effects (the ParsedEffect execution shim) and the diff scripts' log.
	const node = ctx.tree.triggers.find((t) => t.id.endsWith(`_${line.rawIndex}`));
	const structured = ctx.structured.find((s) => s.ab.clause === line.raw);
	if (structured) {
		const legacyTrigger = structuredTriggerDef(structured.type, structured.ab);
		const legacyCondition = structured.ab.condition ? translateCondition(structured.ab.condition) : undefined;
		// The pre-Phase-5 engine read etb/dies/attack triggers through parseTriggeredEffects, which
		// dropped conditional ones; only upkeep and end-step triggers checked intervening-if conditions.
		const conditionHonoured =
			!structured.ab.condition ||
			(Boolean(legacyCondition) && (structured.type === 'upkeep' || structured.type === 'end_step'));
		ctx.log?.triggers.push({
			rawIndex: line.rawIndex,
			trigger: legacyTrigger,
			condition: legacyCondition,
			complete: conditionHonoured
		});
	} else if (node) {
		ctx.log?.triggers.push({ rawIndex: line.rawIndex, trigger: ruleNodeTriggerDef(node), complete: true });
	}

	// Phase 5: the trigger and its intervening-if condition come from the trigger grammar.
	const head = parseTriggerHeader(line.body, line.bodySpan.start);
	if (!head || !head.trigger || head.unparsed.length > 0) {
		return [unsupported('unparsed', line.text, span, head?.unparsed.length ? head.unparsed : [line.bodySpan])];
	}
	const { trigger, condition } = head;
	if (runtimeTriggerProblem(trigger)) {
		const headSpan = { start: line.bodySpan.start, end: head.effectStart };
		return [unsupported('event_not_implemented', line.text, span, [headSpan])];
	}

	const effectSentences = splitSentences(
		line.text.slice(head.effectStart - line.span.start),
		head.effectStart
	);
	const effectText = effectSentences.map((s) => s.text).join(' ');
	const legacyEffects = structured?.ab.effects ?? node?.effects;
	const effects = legacyEffects ?? parseSpellOrAbilityEffects(ctx.card, denormalize(effectText, ctx.card.name)).effects;
	const unparsed = unclaimedSentences(ctx, effectSentences, effects);
	const targets = targetSpecs(detectTargetRequirement(denormalize(effectText, ctx.card.name)));
	const effect = translateEffects(effects, span, 'trigger');
	ctx.log?.effects?.push({
		kind: 'triggered',
		rawIndex: line.rawIndex,
		steps: effect,
		complete: unparsed.length === 0 && effect.length > 0
	});
	const ability: AbilityDef =
		unparsed.length > 0 || effect.length === 0
			? {
					...unsupported('unparsed', line.text, span, unparsed.length > 0 ? unparsed : [line.bodySpan]),
					trigger,
					condition
				}
			: { kind: 'triggered', trigger, condition, targets, effect, span };
	setLegacyTriggerExecution(ability, { effects, clause: line.raw, legacyClaimed: Boolean(legacyEffects) });
	return [ability];
}

function structuredTriggerDef(
	type: 'etb' | 'attack' | 'dies' | 'upkeep' | 'end_step',
	ab: StructuredTriggeredAbility
): TriggerDef {
	switch (type) {
		case 'etb':
			return { event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } };
		case 'dies':
			return { event: 'zoneChange', filter: { object: 'self', from: 'battlefield', to: 'graveyard' } };
		case 'attack':
			return { event: 'attacks', filter: { object: 'self' } };
		case 'upkeep':
		case 'end_step': {
			const def: TriggerDef = {
				event: 'phaseBegin',
				filter: { phase: type === 'upkeep' ? 'upkeep' : 'end_step' },
				scope: ab.scope
			};
			// The engine checks upkeep triggers of cards in graveyards (Nether Shadow) when the effect
			// returns the card itself from the graveyard.
			if (ab.effects.some((e) => e.kind === 'return_self_from_graveyard')) def.fromZone = 'graveyard';
			return def;
		}
	}
}

function ruleNodeTriggerDef(node: TriggerRuleNode): TriggerDef {
	const subjectFilter = (name: string | undefined): ObjectFilter =>
		name === undefined ? {} : CARD_TYPES.has(name) ? { types: [name] } : { subtypes: [name] };

	switch (node.path) {
		case 'trigger.on_landfall':
			return {
				event: 'zoneChange',
				filter: { object: { types: ['Land'], controller: 'you' }, to: 'battlefield' }
			};
		case 'trigger.on_etb': {
			const object: ObjectFilter = {
				...subjectFilter(node.enteredCardTypeFilter),
				controller: 'you',
				other: true
			};
			if (node.nontokenOnly) object.token = false;
			return {
				event: 'zoneChange',
				filter: { object, to: 'battlefield', orSelf: node.includeSelf || undefined }
			};
		}
		case 'trigger.on_cast': {
			const spell: ObjectFilter =
				node.spellFilter === 'InstantOrSorcery'
					? { types: ['Instant', 'Sorcery'] }
					: node.spellFilter === 'Creature'
						? { types: ['Creature'] }
						: node.spellFilter === 'Noncreature'
							? { notTypes: ['Creature'] }
							: {};
			return {
				event: 'cast',
				filter: {
					object: spell,
					player: { relation: node.casterFilter === 'any' ? 'any' : 'you' }
				}
			};
		}
		case 'trigger.on_counter_placed':
			return { event: 'counterPlaced', filter: { object: 'self', counter: '+1/+1' } };
		case 'trigger.on_attack':
			return {
				event: 'attacks',
				filter: {
					object: { ...subjectFilter(node.attackerSubtypeFilter), controller: 'you' },
					oneOrMore: node.id.startsWith('trig_obs_atk_') && !node.id.startsWith('trig_obs_atk_each_')
						? true
						: undefined
				}
			};
		case 'trigger.on_combat_damage_player':
			return { event: 'dealsDamage', filter: { object: 'self', combat: true, damageTo: 'player' } };
		case 'trigger.on_attach':
			return { event: 'attached', filter: { object: node.appliesToSelfOnly ? 'self' : {} } };
		default:
			return { event: 'zoneChange', filter: { object: 'self' } };
	}
}

function translateCondition(cond: TriggerCondition): Condition | undefined {
	switch (cond.kind) {
		case 'life_at_least':
			return {
				k: 'compare',
				left: { k: 'life', of: { k: 'you' } },
				op: '>=',
				right: { k: 'const', n: cond.amount }
			};
		case 'controls_count_at_least':
			return {
				k: 'compare',
				left: { k: 'count', of: { ...typeOrSubtype(cond.cardType), controller: 'you' } },
				op: '>=',
				right: { k: 'const', n: cond.count }
			};
		case 'graveyard_creatures_above_at_least':
			return { k: 'graveyardAbove', filter: { types: ['Creature'] }, count: cond.count };
		case 'unrecognized':
			return undefined;
	}
}

// ---- Activated abilities --------------------------------------------------------------------

function adaptActivated(ctx: AdapterContext, line: NormalizedLine): AbilityDef[] | null {
	const isManaLine = /^\{T\}:\s*Add\b/i.test(line.raw);
	const node = isManaLine
		? ctx.claimManaTap()
		: ctx.tree.actions.find((a) => /^(act|loyalty|equip)_/.test(a.id) && a.id.endsWith(`_${line.rawIndex}`));

	// A colon inside quotes belongs to a granted ability ('have "{T}: Add {C}"'), not to this line.
	const quote = line.body.search(/["“]/);
	const colon = line.body.indexOf(':');
	const isCostColon = colon > 0 && (quote < 0 || colon < quote);
	if (!node) {
		// Looks like an activated ability ("cost: effect") that nothing claimed.
		if (isCostColon && !/^(when|whenever|at)\b/i.test(line.body) && !/^choose\b/i.test(line.body)) {
			return [unsupported('unparsed', line.text, line.span, [line.bodySpan])];
		}
		return null;
	}

	if (node.id.startsWith('equip_')) return null; // a keyword line, handled by adaptKeywordLine

	const costText = line.body.slice(0, colon).trim();
	const effectStart = line.bodySpan.start + colon + 1;
	const effectText = line.body.slice(colon + 1).trim();
	const effectSentences = splitSentences(line.body.slice(colon + 1), effectStart);

	const cost = translateCost(node, costText, line.bodySpan.start);
	const unparsed = [...cost.unparsed];
	ctx.log?.costs.push({
		kind: 'activated',
		rawIndex: line.rawIndex,
		text: costText,
		defs: cost.defs,
		complete: cost.unparsed.length === 0
	});

	let effect: EffectStep[];
	if (node.path === 'activated.mana') {
		effect = [manaStep(effectText, node, line.span)];
		if (!effect[0].params) unparsed.push(...effectSentences.map((s) => s.span));
	} else {
		unparsed.push(...unclaimedSentences(ctx, effectSentences));
		effect = translateEffects(node.action.effects, line.span, 'ability');
		if (effect.length === 0 && unparsed.length === 0) unparsed.push(line.bodySpan);
	}

	ctx.log?.effects?.push({
		kind: 'activated',
		rawIndex: line.rawIndex,
		steps: effect,
		// The effect is judged on its own; cost gaps are the cost grammar's report.
		complete: unparsed.length === cost.unparsed.length && effect.length > 0
	});
	if (unparsed.length > 0) {
		// Phase 4: the runtime still pays the cost of an ability whose effect the legacy path resolves.
		const u = unsupported('unparsed', line.text, line.span, unparsed);
		return [{ ...u, legacyId: node.id, cost: cost.defs, costComplete: cost.unparsed.length === 0 }];
	}

	const ability: ActivatedAbility = {
		kind: 'activated',
		cost: cost.defs,
		targets: node.targetAmount.max > 0 ? targetSpecs(node.targetLegality.targetInfo) : [],
		effect,
		timing: node.timing,
		isMana: node.path === 'activated.mana',
		legacyId: node.id,
		span: line.span
	};
	return [ability];
}

function translateCost(
	node: ActionRuleNode,
	costText: string,
	offset: number
): { defs: CostDef[]; unparsed: Span[] } {
	const defs: CostDef[] = [];
	const unparsed: Span[] = [];
	if (node.loyaltyCost !== null) {
		defs.push({ k: 'loyalty', delta: node.loyaltyCost });
		return { defs, unparsed };
	}

	// Phase 4: the cost grammar (compiler/costs.ts) replaces the legacy cost translation.
	return parseCost(costText, offset);
}

function manaStep(effectText: string, node: ActionRuleNode, span: Span): EffectStep {
	const low = effectText.toLowerCase();
	const symbols = (effectText.match(/\{([WUBRGC])\}/g) || []).map((s) => s[1] as ManaColor);
	const params: EffectStep['params'] = {};
	let amount = node.action.producesAmount ?? 1;
	if (/^add one mana of any color in your commander's color identity\.$/.test(low)) {
		params.manaChoice = 'commanderIdentity';
	} else if (/^add one mana of any color\.$/.test(low)) {
		params.manaChoice = 'any';
	} else if (/^add (\{[WUBRGC]\})+\.$/i.test(effectText)) {
		params.mana = symbols;
		amount = symbols.length;
	} else if (/^add \{[WUBRGC]\}(, \{[WUBRGC]\})*,? or \{[WUBRGC]\}\.$/i.test(effectText)) {
		params.manaChoice = symbols;
		amount = 1;
	}
	let dynamic: Amount | undefined;
	// The engine computes these two amounts in getDynamicManaProducedAmount.
	const forEach = effectText.match(/^Add \{([WUBRGC])\} for each ([A-Z][a-z]+) (you control|on the battlefield)\.$/);
	const power = effectText.match(/^Add an amount of \{([WUBRGC])\} equal to ~'s power\.$/);
	if (forEach) {
		params.mana = [forEach[1] as ManaColor];
		dynamic = {
			k: 'count',
			of: { zone: 'battlefield', ...typeOrSubtype(singular(forEach[2])), ...(forEach[3] === 'you control' ? { controller: 'you' as const } : {}) }
		};
	} else if (power) {
		params.mana = [power[1] as ManaColor];
		dynamic = { k: 'stat', of: { k: 'self' }, stat: 'power' };
	}
	return {
		verb: 'addMana',
		subject: { k: 'none' },
		amount: dynamic ?? { k: 'const', n: amount },
		params: params.mana || params.manaChoice ? params : undefined,
		span
	};
}

function intrinsicManaAbility(color: ManaColor): ActivatedAbility {
	const span = { start: 0, end: 0 };
	return {
		kind: 'activated',
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

function adaptSpell(ctx: AdapterContext, lines: NormalizedLine[]): AbilityDef[] {
	const castNode = ctx.tree.actions.find((a) => a.id === 'cast_normal');
	const span = { start: lines[0].span.start, end: lines[lines.length - 1].span.end };
	const text = lines.map((l) => l.text).join('\n');
	const additional = parseAdditionalCostsAndRestrictions(ctx.card);
	const statics: AbilityDef[] = [];
	let hasAdditionalCost = false;
	let additionalCostComplete = true;

	const unparsed: Span[] = [];
	const additionalCosts: CostDef[] = [];
	const effectSentences: NormalizedSentence[] = [];
	const delayed: NonNullable<EffectStep['delayed']>[] = [];
	const legacyDelayed = parseDelayedTriggersFromSpell(ctx.card);
	let modal: ModalDef | undefined;

	for (const group of groupLines(lines)) {
		if (group.length > 1) {
			const m = adaptModes(ctx, group);
			modal = m.modal;
			unparsed.push(...m.unparsed);
			continue;
		}
		for (const s of group[0].sentences) {
			const low = s.text.toLowerCase();
			const costModifier = parseCostModifierSentence(s.text);
			if (costModifier) {
				statics.push({ kind: 'static', static: costModifier, span: s.span });
			} else if (low.startsWith('as an additional cost to cast ~,')) {
				// Phase 4: the cost grammar replaces the legacy additional-cost translation.
				const parsed = parseAdditionalCostSentence(s.text, s.span.start) ?? { defs: [], unparsed: [s.span] };
				unparsed.push(...parsed.unparsed);
				hasAdditionalCost = true;
				if (parsed.unparsed.length > 0) additionalCostComplete = false;
				ctx.log?.costs.push({
					kind: 'additional',
					rawIndex: group[0].rawIndex,
					text: s.text,
					defs: parsed.defs,
					complete: parsed.unparsed.length === 0
				});
				additionalCosts.push(...parsed.defs);
			} else if (
				(low === 'cast ~ only during combat.' && additional.onlyDuringCombat) ||
				(low === 'cast ~ only during your turn.' && additional.onlyDuringYourTurn) ||
				(low === 'cast ~ only before attackers are declared.' && additional.onlyBeforeAttackersDeclared)
			) {
				// Timing restriction, enforced by the cast legality check.
			} else if (
				/^at the beginning of (?:that turn's|the next) end step, you lose the game\.$/.test(low) &&
				legacyDelayed.some((d) => d.effects.some((e) => e.kind === 'lose_the_game_self'))
			) {
				delayed.push({
					trigger: {
						event: 'phaseBegin',
						filter: { phase: 'end_step' },
						scope: low.includes("that turn's") ? 'controller_turn' : 'each_turn'
					},
					effect: [{ verb: 'lose', subject: { k: 'player', filter: { relation: 'you' } }, span: s.span }]
				});
			} else {
				effectSentences.push(s);
			}
		}
	}

	unparsed.push(...unclaimedSentences(ctx, effectSentences));
	const effect = castNode ? translateEffects(castNode.action.effects, span, 'spell') : [];
	if (!modal && effect.length === 0 && unparsed.length === 0) unparsed.push(span);
	if (!castNode || castNode.requiresGuidedResolution) unparsed.push(span);

	if (delayed.length > 0 && effect.length > 0) effect[effect.length - 1].delayed = delayed[0];
	ctx.log?.effects?.push({
		kind: 'spell',
		rawIndex: lines[0].rawIndex,
		steps: modal ? [] : effect,
		modal,
		complete: unparsed.length === 0
	});
	if (unparsed.length > 0) {
		const u = unsupported('unparsed', text, span, dedupeSpans(unparsed));
		// Phase 4: the runtime still pays the additional cost of a spell the legacy path resolves.
		const costInfo = hasAdditionalCost
			? { legacyId: 'cast_normal', cost: additionalCosts, costComplete: additionalCostComplete }
			: {};
		return [...statics, { ...u, ...costInfo }];
	}
	return [
		...statics,
		{
			kind: 'spell',
			additionalCosts,
			targets: modal ? [] : castNode ? targetSpecsFromNode(castNode) : [],
			effect: modal ? [] : effect,
			modal,
			span
		}
	];
}

function adaptModes(ctx: AdapterContext, group: NormalizedLine[]): { modal?: ModalDef; unparsed: Span[] } {
	const header = group[0].text.toLowerCase();
	const counts: Record<string, [number, number]> = {
		'choose one —': [1, 1],
		'choose two —': [2, 2],
		'choose one or both —': [1, 2],
		'choose one or more —': [1, group.length - 1],
		'choose any number —': [0, group.length - 1]
	};
	const range = counts[header];
	if (!range) return { unparsed: [groupSpan(group)] };

	const unparsed: Span[] = [];
	const modes: ModalDef['modes'] = [];
	for (const line of group.slice(1)) {
		const body = line.text.replace(/^•\s*/, '');
		const start = line.span.start + (line.text.length - body.length);
		const sentences = splitSentences(body, start);
		const bad = unclaimedSentences(ctx, sentences);
		const parsed = parseSpellOrAbilityEffects(ctx.card, denormalize(body, ctx.card.name));
		const effect = translateEffects(parsed.effects, line.span, 'spell');
		if (bad.length > 0 || effect.length === 0) {
			unparsed.push(...(bad.length > 0 ? bad : [line.span]));
			continue;
		}
		modes.push({ targets: targetSpecs(parsed.targetInfo), effect, span: line.span });
	}
	return { modal: { min: range[0], max: range[1], modes }, unparsed };
}

// ---- Statics --------------------------------------------------------------------------------

/**
 * Statics are compiled in Phases 6/7. The only ones the legacy compiler models are the board hooks
 * (cost modifiers and multipliers), found by compiling the line on its own.
 */
function adaptStatic(ctx: AdapterContext, group: NormalizedLine[]): AbilityDef {
	const span = groupSpan(group);
	const text = groupText(group);
	if (group.length === 1) {
		const costModifier = parseCostModifierSentence(group[0].body);
		if (costModifier) return { kind: 'static', static: costModifier, span };
		// A permanent spell's additional cost. The IR has no ability kind for it yet, so it stays
		// unsupported but carries the parsed cost for the runtime (Phase 4).
		const additional = parseAdditionalCostSentence(group[0].body, group[0].bodySpan.start);
		if (additional) {
			return {
				...unsupported('static_not_compiled', text, span, [span]),
				legacyId: 'cast_normal',
				cost: additional.defs,
				costComplete: additional.unparsed.length === 0
			};
		}
		const lineTree = getCardRuleTree({ ...ctx.card, oracleText: group[0].raw }, ALL_COLORS);
		const defs = lineTree.hooks.map(translateHook).filter((d): d is StaticDef => d !== null);
		if (defs.length === 1) return { kind: 'static', static: defs[0], span };
	}
	return unsupported('static_not_compiled', text, span, [span]);
}

function translateHook(hook: BoardModifierHookNode): StaticDef | null {
	switch (hook.path) {
		case 'hook.cost_modifier': {
			const condition: Condition | undefined = hook.requiresArtifactCountAtLeast
				? {
						k: 'compare',
						left: { k: 'count', of: { types: ['Artifact'], controller: 'you' } },
						op: '>=',
						right: { k: 'const', n: hook.requiresArtifactCountAtLeast }
					}
				: undefined;
			const affects =
				hook.targetPath === 'activated.attach'
					? { k: 'ability' as const, keyword: 'equip' }
					: {
							k: 'spell' as const,
							filter: {
								...(hook.cardTypeFilter === 'InstantOrSorcery'
									? { types: ['Instant', 'Sorcery'] }
									: hook.cardTypeFilter === 'Noncreature'
										? { notTypes: ['Creature'] }
										: typeOrSubtype(hook.cardTypeFilter ?? '')),
								other: hook.excludeSelf || undefined
							}
						};
			return {
				k: 'costModifier',
				affects,
				delta: {
					mode: hook.costMode === 'set_zero' ? 'setZero' : hook.costMode === 'increase_generic' ? 'increase' : 'reduce',
					generic: hook.costDeltaGeneric ?? 0
				},
				who: { relation: 'you' },
				activeZones: hook.activeZones.length > 1 ? [...hook.activeZones] : undefined,
				condition
			};
		}
		case 'hook.counter_multiplier':
			return { k: 'multiplier', what: 'counters', factor: hook.multiplier ?? 2, filter: { controller: 'you' } };
		case 'hook.trigger_multiplier':
			return { k: 'multiplier', what: 'triggers', factor: hook.multiplier ?? 2, filter: { controller: 'you' } };
		default:
			return null;
	}
}

// ---- Sentence coverage ----------------------------------------------------------------------

/** Sentences for which the legacy effect parser finds nothing. */
function unclaimedSentences(
	ctx: AdapterContext,
	sentences: NormalizedSentence[],
	effects: ParsedEffect[] = []
): Span[] {
	const out: Span[] = [];
	for (const s of sentences) {
		if (NEUTRAL_SENTENCES.some((re) => re.test(s.text))) continue;
		// parseStructuredTriggeredAbilities recognises "sacrifice ~" itself.
		if (/^sacrifice ~\.$/i.test(s.text) && effects.some((e) => e.kind === 'sacrifice_self')) continue;
		const parsed = parseSpellOrAbilityEffects(ctx.card, denormalize(s.text, ctx.card.name));
		if (parsed.effects.length === 0) out.push(s.span);
	}
	return out;
}

// ---- Targets --------------------------------------------------------------------------------

function targetSpecsFromNode(node: ActionRuleNode): TargetSpec[] {
	return node.targetAmount.max > 0 ? targetSpecs(node.targetLegality.targetInfo) : [];
}

function targetSpecs(info: TargetRequirementInfo): TargetSpec[] {
	if (!info.requiresTarget) return [];
	const controller = info.controllerFilter;
	const typed = (types: string[]): ObjectFilter => ({ types, controller });
	const base = { min: info.minTargets, max: info.maxTargets };

	switch (info.targetKind) {
		case 'any':
			return [{ kind: 'objectOrPlayer', filter: { zone: 'battlefield', types: ['Creature', 'Planeswalker', 'Battle'] }, player: { relation: 'any' }, ...base }];
		case 'player':
			return [{ kind: 'player', filter: {}, player: { relation: controller === 'opponent' ? 'opponent' : 'any' }, ...base }];
		case 'creature':
			return [{ kind: 'object', filter: { zone: 'battlefield', ...typed(['Creature']) }, ...base }];
		case 'controlled_creature':
			return [{ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' }, ...base }];
		case 'permanent':
			return [{ kind: 'object', filter: { zone: 'battlefield', ...typedOrAny(info.cardTypeFilter), controller }, ...base }];
		case 'nonland_permanent':
			return [{ kind: 'object', filter: { zone: 'battlefield', notTypes: ['Land'], controller }, ...base }];
		case 'artifact_or_enchantment':
			return [{ kind: 'object', filter: { zone: 'battlefield', ...typed(['Artifact', 'Enchantment']) }, ...base }];
		case 'spell':
			return [{ kind: 'object', filter: { zone: 'stack', ...typedOrAny(info.cardTypeFilter), controller }, ...base }];
		case 'graveyard_card':
			return [
				{
					kind: 'object',
					filter: { zone: 'graveyard', ...typedOrAny(info.cardTypeFilter), owner: controller },
					sameOwner: info.sameGraveyard || undefined,
					...base
				}
			];
		case 'none':
			return [];
	}
}

function typedOrAny(cardType: string | undefined): ObjectFilter {
	return cardType && cardType !== 'Permanent' && cardType !== 'Card' ? typeOrSubtype(cardType) : {};
}

function singular(word: string): string {
	if (word === 'Elves') return 'Elf';
	if (word === 'Dwarves') return 'Dwarf';
	return word.endsWith('s') ? word.slice(0, -1) : word;
}

function typeOrSubtype(name: string): ObjectFilter {
	if (!name) return {};
	return CARD_TYPES.has(name) ? { types: [name] } : { subtypes: [name] };
}

// ---- Effects --------------------------------------------------------------------------------

type EffectContext = 'spell' | 'ability' | 'trigger';

function translateEffects(effects: ParsedEffect[], span: Span, ctx: EffectContext): EffectStep[] {
	return effects.flatMap((e) => translateEffect(e, span, ctx));
}

const T0: Selector = { k: 'target', index: 0 };
const T0_REF: Ref = { k: 'target', index: 0 };
const YOU: Selector = { k: 'player', filter: { relation: 'you' } };
const EACH_OPPONENT: Selector = { k: 'player', filter: { relation: 'each_opponent' } };
const NONE: Selector = { k: 'none' };
const YOUR_CREATURES: Selector = { k: 'all', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' } };
const ALL_CREATURES: Selector = { k: 'all', filter: { zone: 'battlefield', types: ['Creature'] } };

function n(value: number): Amount {
	return { k: 'const', n: value };
}

function formulaAmount(e: ParsedEffect): Amount {
	const f = e.dynamicFormula;
	if (!f) return n(e.amount);
	const [name, arg] = f.split(':');
	switch (name) {
		case 'count_subtype':
			return { k: 'count', of: { zone: 'battlefield', ...typeOrSubtype(arg), controller: 'you' } };
		case 'attacking_subtype_count':
			return { k: 'count', of: { zone: 'battlefield', ...typeOrSubtype(arg), controller: 'you', attacking: true } };
		case 'combat_damage_dealt':
			return { k: 'eventAmount' };
		case 'entered_power':
			return { k: 'stat', of: { k: 'eventObject' }, stat: 'power' };
		case 'target_power':
			return { k: 'stat', of: T0_REF, stat: 'power', lki: true };
		default:
			return n(e.amount);
	}
}

function searchSpec(spec: LibrarySearchSpec) {
	const filter: ObjectFilter = {};
	if (spec.allowedTypes.length) filter.types = [...spec.allowedTypes];
	if (spec.allowedSubtypes.length) filter.subtypes = [...spec.allowedSubtypes];
	const notTypes = spec.disallowedTypes.filter((t) => t !== 'Basic');
	if (notTypes.length) filter.notTypes = notTypes;
	const supertypes = [spec.requireBasic && 'Basic', spec.requireLegendary && 'Legendary'].filter(Boolean) as string[];
	if (supertypes.length) filter.supertypes = supertypes;
	if (spec.allowedColors?.length) filter.colors = [...spec.allowedColors];
	if (spec.maxCmc !== undefined) filter.manaValue = { op: '<=', value: n(spec.maxCmc) };
	if (spec.exactCmc !== undefined) filter.manaValue = { op: '=', value: n(spec.exactCmc) };
	return {
		filter,
		count: spec.count,
		upTo: spec.upTo,
		statedQuality: spec.statedQuality,
		destinations: spec.destinations.map((d) => ({ ...d }))
	};
}

function translateEffect(e: ParsedEffect, span: Span, ctx: EffectContext): EffectStep[] {
	const step = (verb: EffectStep['verb'], subject: Selector, extra: Partial<EffectStep> = {}): EffectStep[] => [
		{ verb, subject, ...extra, span }
	];
	const targetController = e.recipient === 'target_controller';
	const actorPlayer: Selector = targetController
		? { k: 'playerRef', ref: { k: 'controllerOf', of: T0_REF } }
		: YOU;
	const itRef: Selector = ctx === 'trigger' ? { k: 'eventObject' } : T0;
	const eot = { duration: 'endOfTurn' as const };

	switch (e.kind) {
		case 'draw':
			return step('draw', YOU, { amount: formulaAmount(e) });
		case 'scry':
			return step('scry', YOU, { amount: n(e.amount) });
		case 'rearrange_top':
			return step('lookAndReorder', YOU, { amount: n(e.amount), params: e.mayShuffle ? { mayShuffle: true } : undefined });
		case 'mill':
			return step('mill', YOU, { amount: n(e.amount) });
		case 'gain_life':
			if (e.dynamicFormula === 'target_power') {
				return step('gainLife', actorPlayer, { amount: formulaAmount(e) });
			}
			return e.amount < 0
				? step('loseLife', YOU, { amount: n(-e.amount) })
				: step('gainLife', actorPlayer, { amount: n(e.amount) });
		case 'lose_life_opponents':
			return step('loseLife', EACH_OPPONENT, { amount: formulaAmount(e) });
		case 'damage_target':
			return step('damage', T0, { amount: n(e.amount) });
		case 'damage_each_opponent':
			return step('damage', EACH_OPPONENT, { amount: formulaAmount(e) });
		case 'damage_all_creatures':
			return step('damage', ALL_CREATURES, { amount: n(e.amount) });
		case 'destroy_target':
			return step('destroy', T0);
		case 'destroy_all_creatures':
			return step('destroy', ALL_CREATURES);
		case 'exile_target':
			return step('exile', ctx === 'trigger' ? itRef : T0);
		case 'exile_all_graveyards':
			return step('exile', { k: 'all', filter: { zone: 'graveyard' } });
		case 'counter_target_spell':
			return step('counterSpell', T0);
		case 'bounce_target':
			return step('bounce', T0);
		case 'search_land_to_battlefield':
		case 'search_library_to_hand':
			return step('search', actorPlayer, {
				amount: n(e.amount),
				params: e.searchSpec ? { search: searchSpec(e.searchSpec), tapped: e.tapped || undefined } : undefined
			});
		case 'create_token':
			return step('createToken', NONE, {
				amount: formulaAmount(e),
				actor: targetController ? { k: 'controllerOf', of: T0_REF } : undefined,
				params: e.tokenSpec ? { token: { ...e.tokenSpec, colors: [...e.tokenSpec.colors], keywords: [...e.tokenSpec.keywords] } } : undefined
			});
		case 'copy_target_permanent':
			return step('copyPermanent', itRef);
		case 'copy_target_spell':
			return step('copySpell', T0);
		case 'proliferate':
			return step('proliferate', NONE);
		case 'add_counters_self':
			return step('putCounters', { k: 'self' }, { amount: n(e.amount), params: { counter: e.counterType } });
		case 'add_counters_target':
			return step('putCounters', T0, { amount: n(e.amount), params: { counter: e.counterType } });
		case 'add_counters_team':
			return step('putCounters', YOUR_CREATURES, { amount: n(e.amount), params: { counter: e.counterType } });
		case 'pump_self_eot':
			return step('pump', { k: 'self' }, { amount: n(e.amount), params: { toughness: n(e.toughnessAmount ?? 0), ...eot } });
		case 'pump_target_eot':
			return step('pump', T0, { amount: n(e.amount), params: { toughness: n(e.toughnessAmount ?? 0), ...eot } });
		case 'pump_team_eot': {
			const amt = formulaAmount(e);
			const out = step('pump', YOUR_CREATURES, {
				amount: amt,
				params: { toughness: e.dynamicFormula ? amt : n(e.toughnessAmount ?? 0), ...eot }
			});
			if (e.grantedKeyword) {
				out.unshift(...step('grant', YOUR_CREATURES, { params: { keywords: [e.grantedKeyword.toLowerCase()], ...eot } }));
			}
			return out;
		}
		case 'grant_keyword_target_eot':
			return step('grant', T0, { params: { keywords: [(e.grantedKeyword ?? '').toLowerCase()], ...eot } });
		case 'add_mana':
			return step('addMana', NONE, { amount: n(e.amount), params: e.manaColors ? { mana: [...e.manaColors] } : undefined });
		case 'reanimate_target':
			if (e.dynamicFormula === 'top_creature_of_graveyard') {
				return step('move', { k: 'all', filter: { zone: 'graveyard', types: ['Creature'], owner: 'you' } }, {
					params: { from: 'graveyard', to: 'battlefield', topmostOnly: true }
				});
			}
			return step('move', T0, { params: { from: 'graveyard', to: 'battlefield' } });
		case 'return_from_graveyard_to_hand':
			return step('move', T0, { params: { from: 'graveyard', to: 'hand' } });
		case 'return_self_from_graveyard':
			return step('move', { k: 'self' }, { params: { from: 'graveyard', to: 'battlefield' } });
		case 'equip_target':
			return step('attach', T0);
		case 'end_the_turn':
			return step('endTurn', NONE);
		case 'may_end_the_turn':
			return step('endTurn', NONE, { params: { activePlayerMay: true } });
		case 'extra_turn':
			return step('extraTurn', YOU);
		case 'phase_out_target':
			return step('phaseOut', T0);
		case 'phase_out_team':
			return step('phaseOut', { k: 'all', filter: { zone: 'battlefield', controller: 'you' } });
		case 'switch_pt_target':
			return step('switchPT', T0, { params: eot });
		case 'suspend_tick_down':
			return step('suspendTick', { k: 'self' });
		case 'suspend_cast_free':
			return step('suspendCast', { k: 'self' });
		case 'win_the_game':
			return step('win', YOU, {
				params:
					e.dynamicFormula === 'devotion_blue_gte_library'
						? {
								condition: {
									k: 'compare',
									left: { k: 'devotion', colors: ['U'] },
									op: '>=',
									right: { k: 'cardsIn', zone: 'library', of: { k: 'you' } }
								}
							}
						: undefined
			});
		case 'lose_the_game_self':
			return step('lose', YOU);
		case 'sacrifice_self':
			return step('sacrifice', { k: 'self' });
	}
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
