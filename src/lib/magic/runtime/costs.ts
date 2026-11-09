/**
 * Cost legality and payment from IR CostDefs (ENGINE_ARCHITECTURE_PLAN.md section 2, Phase 4).
 *
 * Costs come from the compiled card (compiler/costs.ts via compileCard); this module never reads
 * rules text or card names. Paying works in two steps so nothing is paid unless everything can be:
 *
 * 1. `planCosts` resolves choices between costs and the objects each cost needs. A choice the player
 *    hasn't made yet is returned as a `question` (the engine turns it into a `cost_choice` prompt for
 *    humans; bots answer in ai.ts). A choice with exactly one legal answer is made automatically.
 * 2. `payPlannedCosts` pays a complete plan: tap/untap costs first (so auto-tapping for mana can't
 *    use the same permanents), then mana, then the rest (CR 601.2h: random costs last).
 *
 * Zone changes go through runtime/zones.ts `moveObject`.
 */
import { compileCard } from '../compiler/index.ts';
import type { AbilityDef, Amount, CostDef, KeywordDef, ObjectFilter, StaticDef } from '../ir.ts';
import { parseManaCost, type ManaCostRequirement } from '../oracle.ts';
import { evaluatePermanent } from '../ruleTree.ts';
import type {
	CardInstance,
	CostPayment,
	CounterType,
	GameState,
	ParsedActivatedAbility,
	PlayerGameState,
	ScryfallCard
} from '../types.ts';
import { evaluateAmount, evaluateCondition, matchesObjectFilter, type FilterContext } from './objectFilter.ts';
import { moveObject, type PlayerZone } from './zones.ts';

// ---- Where costs come from ------------------------------------------------------------------

export interface CostSource {
	defs: CostDef[];
	/** False if part of the cost is unparsed. The parsed parts are still paid; the rest isn't enforced. */
	complete: boolean;
}

function abilitiesOf(card: ScryfallCard): AbilityDef[] {
	return compileCard(card).faces[0]?.abilities ?? [];
}

/**
 * The cost of an activated ability, by its legacy id. Abilities the compiler doesn't produce
 * (mana abilities granted by type-changing effects, basic land types, abilities whose line the
 * adapter couldn't match) fall back to a translation of the legacy fields, which is data, not text.
 */
export function activatedAbilityCost(card: ScryfallCard, ab: ParsedActivatedAbility): CostSource {
	const ir = abilitiesOf(card).find(
		(a) => (a.kind === 'activated' || a.kind === 'unsupported') && a.legacyId === ab.id
	);
	if (ir?.kind === 'activated') return { defs: ir.cost, complete: true };
	if (ir?.kind === 'unsupported' && ir.cost) return { defs: ir.cost, complete: ir.costComplete ?? false };
	return { defs: legacyCostDefs(ab), complete: true };
}

/** The keyword table: costs that come from a keyword ("Equip {2}", "Overload {6}{U}"). */
export function legacyCostDefs(ab: ParsedActivatedAbility): CostDef[] {
	const defs: CostDef[] = [];
	if (ab.loyaltyCost !== null) defs.push({ k: 'loyalty', delta: ab.loyaltyCost });
	if (ab.manaCost && ab.manaCost !== '{0}') defs.push({ k: 'mana', cost: ab.manaCost });
	if (ab.requiresTap) defs.push({ k: 'tapSelf' });
	if (ab.lifeCost > 0) defs.push({ k: 'payLife', amount: { k: 'const', n: ab.lifeCost } });
	if (ab.requiresSacrificeSelf) defs.push({ k: 'sacrifice', count: { k: 'const', n: 1 }, filter: 'self' });
	return defs;
}

/** The additional cost of casting a spell ("As an additional cost to cast ~, ..."), if it has one. */
export function spellAdditionalCost(card: ScryfallCard): CostSource | null {
	for (const a of abilitiesOf(card)) {
		if (a.kind === 'spell' && a.additionalCosts.length > 0) return { defs: a.additionalCosts, complete: true };
		if (a.kind === 'unsupported' && a.legacyId === 'cast_normal') {
			return { defs: a.cost ?? [], complete: a.costComplete ?? false };
		}
	}
	return null;
}

/** A keyword's cost from the compiled card, e.g. `keywordCost(card, 'overload')` → '{6}{U}'. */
export function keywordCost(card: ScryfallCard, name: string): string | null {
	for (const a of abilitiesOf(card)) {
		if (a.kind === 'keyword' && a.keyword.name === name && a.keyword.cost) return a.keyword.cost;
	}
	return null;
}

/** Keyword abilities that are alternative costs for casting a spell (CR 118.9). */
export const ALTERNATIVE_COST_KEYWORDS: Record<string, { targetsBecomeEach: boolean }> = {
	// CR 702.96a: "You may choose to pay [cost] rather than pay this spell's mana cost" and
	// "target" becomes "each".
	overload: { targetsBecomeEach: true }
};

export function keywordsOf(card: ScryfallCard): KeywordDef[] {
	return abilitiesOf(card).flatMap((a) => (a.kind === 'keyword' ? [a.keyword] : []));
}

/** The cost-modifying statics of a card (CR 601.2f). */
export function costModifiersOf(card: ScryfallCard): Array<Extract<StaticDef, { k: 'costModifier' }>> {
	const out: Array<Extract<StaticDef, { k: 'costModifier' }>> = [];
	for (const a of abilitiesOf(card)) {
		if (a.kind === 'static' && a.static.k === 'costModifier') out.push(a.static);
	}
	return out;
}

/**
 * Computes the effective mana cost requirement for casting `inst` (CR 601.2f): base mana cost (or
 * alternative keyword cost such as Overload from `ALTERNATIVE_COST_KEYWORDS`), plus Commander Tax
 * from the command zone, plus active `StaticDef{k:'costModifier'}` reductions/increases from the
 * spell itself, the battlefield, and the command zone (Eminence).
 */
export function effectiveSpellManaCost(
	state: GameState,
	player: PlayerGameState,
	inst: CardInstance,
	xValue = 0,
	isOverload = false
): ManaCostRequirement {
	const card = inst.copiableCard ?? inst.card;
	const baseCostStr = isOverload ? (keywordCost(card, 'overload') ?? card.manaCost) : card.manaCost;
	const effectiveX = isOverload ? 0 : xValue;

	let forceZeroCost = false;
	let genericReduction = 0;
	let genericIncrease = 0;

	const applyDelta = (mod: Extract<StaticDef, { k: 'costModifier' }>, ctx: FilterContext) => {
		const perAmount = mod.delta.per ?? mod.delta.times;
		const factor = perAmount ? Math.max(0, evaluateAmount(perAmount, ctx)) : 1;
		if (factor === 0 && perAmount) return;
		if (mod.delta.mode === 'setZero') {
			forceZeroCost = true;
		} else if (mod.delta.mode === 'reduce' && mod.delta.generic) {
			genericReduction += mod.delta.generic * factor;
		} else if (mod.delta.mode === 'increase' && mod.delta.generic) {
			genericIncrease += mod.delta.generic * factor;
		}
	};

	const matchesWho = (mod: Extract<StaticDef, { k: 'costModifier' }>, sourceControllerId: string): boolean => {
		if (mod.who.relation === 'you') return sourceControllerId === player.playerId;
		if (mod.who.relation === 'opponent' || mod.who.relation === 'each_opponent') {
			return sourceControllerId !== player.playerId;
		}
		return true;
	};

	const matchesSpell = (
		mod: Extract<StaticDef, { k: 'costModifier' }>,
		sourceControllerId: string,
		sourceInst: CardInstance
	): boolean => {
		if (mod.affects.k !== 'spell') return false;
		if (mod.affects.filter.other && sourceInst.instanceId === inst.instanceId) {
			return false;
		}
		const fctx: FilterContext = {
			state,
			controllerId: sourceControllerId,
			source: sourceInst,
			xValue: effectiveX
		};
		return matchesObjectFilter(inst, mod.affects.filter, fctx);
	};

	// 1. Self cost modifiers on the spell itself ("This spell costs {1} less to cast for each ...").
	const selfCtx: FilterContext = {
		state,
		controllerId: player.playerId,
		source: inst,
		xValue: effectiveX
	};
	for (const mod of costModifiersOf(card)) {
		if (mod.affects.k !== 'self') continue;
		if (mod.condition && !evaluateCondition(mod.condition, selfCtx)) continue;
		applyDelta(mod, selfCtx);
	}

	// 2. Active cost modifiers on the battlefield and in the command zone (Eminence).
	for (const p of state.players) {
		if (p.lost) continue;
		for (const perm of p.battlefield) {
			if (perm.phasedOut || evaluatePermanent(state, perm).losesAllAbilities) continue;
			const pCard = perm.copiableCard ?? perm.card;
			const ctx: FilterContext = { state, controllerId: p.playerId, source: perm, xValue: effectiveX };
			for (const mod of costModifiersOf(pCard)) {
				const zones = mod.activeZones ?? ['battlefield'];
				if (!zones.includes('battlefield')) continue;
				if (!matchesWho(mod, p.playerId)) continue;
				if (mod.condition && !evaluateCondition(mod.condition, ctx)) continue;
				if (!matchesSpell(mod, p.playerId, perm)) continue;
				applyDelta(mod, ctx);
			}
		}
		for (const cmd of p.command) {
			const cCard = cmd.copiableCard ?? cmd.card;
			const ctx: FilterContext = { state, controllerId: p.playerId, source: cmd, xValue: effectiveX };
			for (const mod of costModifiersOf(cCard)) {
				if (!mod.activeZones?.includes('command')) continue;
				if (!matchesWho(mod, p.playerId)) continue;
				if (mod.condition && !evaluateCondition(mod.condition, ctx)) continue;
				if (!matchesSpell(mod, p.playerId, cmd)) continue;
				applyDelta(mod, ctx);
			}
		}
	}

	// 3. Commander Tax from the command zone (CR 903.8).
	if (inst.isCommander && inst.zone === 'command') {
		const castCount = player.commanderCastCounts?.[inst.instanceId] ?? inst.commanderCastCount ?? 0;
		if (castCount > 0) {
			genericIncrease += castCount * state.rules.commanderTaxIncrement;
		}
	}

	if (forceZeroCost) return parseManaCost('', 0, genericIncrease, genericReduction);
	return parseManaCost(baseCostStr, effectiveX, genericIncrease, genericReduction);
}

/**
 * The amount of mana a mana ability adds, if the IR says it's dynamic ("for each Elf you control",
 * "equal to ~'s power"). Null if the IR has no amount for it (the caller uses the legacy amount).
 */
export function manaAbilityAmount(card: ScryfallCard, ab: ParsedActivatedAbility): Amount | null {
	const abilities = abilitiesOf(card);
	const ir =
		abilities.find((a) => a.kind === 'activated' && a.legacyId === ab.id) ??
		(ab.id === 'mana_tap' ? abilities.find((a) => a.kind === 'activated' && a.isMana && !a.intrinsic) : undefined);
	if (ir?.kind !== 'activated') return null;
	const step = ir.effect.find((e) => e.verb === 'addMana');
	return step?.amount && step.amount.k !== 'const' ? step.amount : null;
}

// ---- Describing costs (display only) ---------------------------------------------------------

function amountText(a: Amount): string {
	return a.k === 'const' ? String(a.n) : a.k === 'x' ? 'X' : 'N';
}

function filterText(f: ObjectFilter, n: Amount): string {
	const plural = !(n.k === 'const' && n.n === 1);
	const words: string[] = [];
	if (f.other) words.push('another');
	if (f.tapped === false) words.push('untapped');
	if (f.token === false) words.push('nontoken');
	if (f.supertypes) words.push(...f.supertypes.map((s) => s.toLowerCase()));
	if (f.notTypes) words.push(...f.notTypes.map((t) => `non${t.toLowerCase()}`));
	const nouns = [...(f.subtypes ?? []), ...(f.types ?? []).map((t) => t.toLowerCase())];
	words.push(nouns.length > 0 ? nouns.join(' or ') : 'permanent');
	let text = words.join(' ');
	if (f.power) text += ` with power ${f.power.op} ${amountText(f.power.value)}`;
	if (f.manaValue) text += ` with mana value ${f.manaValue.op} ${amountText(f.manaValue.value)}`;
	return plural ? `${amountText(n)} × ${text}` : text;
}

/** A short English description of a cost, for prompts and logs. */
export function describeCost(defs: CostDef[]): string {
	if (defs.length === 0) return "Don't pay";
	return defs
		.map((d): string => {
			switch (d.k) {
				case 'mana':
					return `Pay ${d.cost}`;
				case 'tapSelf':
					return '{T}';
				case 'untapSelf':
					return '{Q}';
				case 'tapOthers':
					return `Tap ${filterText(d.filter, d.count)}`;
				case 'sacrifice':
					return d.filter === 'self' ? 'Sacrifice this' : `Sacrifice ${filterText(d.filter, d.count)}`;
				case 'discard':
					return `Discard ${amountText(d.count)} card(s)${d.filter ? ` (${filterText(d.filter, d.count)})` : ''}${d.random ? ' at random' : ''}`;
				case 'payLife':
					return `Pay ${amountText(d.amount)} life`;
				case 'loyalty':
					return d.delta >= 0 ? `+${d.delta}` : `${d.delta}`;
				case 'removeCounters':
					return `Remove ${amountText(d.count)} ${d.counter} counter(s)`;
				case 'exileFrom':
					return d.filter === 'self'
						? `Exile this from ${d.zone}`
						: `Exile ${amountText(d.count)} card(s) from your ${d.zone}`;
				case 'choice':
					return d.options.map((o) => describeCost(o)).join(' or ');
				case 'optional':
					return `You may: ${describeCost(d.cost)}`;
				default: {
					const extra = d as { k: string; count?: Amount };
					if (extra.k === 'mill' && extra.count) {
						return `Mill ${amountText(extra.count)} card(s)`;
					}
					return '';
				}
			}
		})
		.join(', ');
}

// ---- Planning --------------------------------------------------------------------------------

export interface CostContext {
	state: GameState;
	player: PlayerGameState;
	/** The spell being cast or the permanent whose ability is activated. */
	source: CardInstance;
	xValue: number;
	/** The source is a spell being cast: it can't pay its own discard/exile costs. */
	isSpell: boolean;
	/**
	 * The effective requirement of the top-level mana costs (after cost modifiers), computed by the
	 * caller; top-level `mana` defs are not added again. Mana inside a chosen option is added.
	 */
	baseMana: ManaCostRequirement | null;
	canPayMana: (req: ManaCostRequirement) => boolean;
	payMana: (req: ManaCostRequirement) => boolean;
}

export type CostQuestion =
	| { kind: 'option'; index: number; labels: string[]; optional: boolean }
	| { kind: 'objects'; index: number; label: string; count: number; candidateIds: string[] };

type ObjectCostDef = Extract<CostDef, { k: 'tapOthers' | 'sacrifice' | 'discard' | 'exileFrom' }>;

/** One cost part of a complete plan, with the objects it uses. */
export type PlannedCost =
	| { def: CostDef; objects?: CardInstance[]; random?: { candidates: CardInstance[]; count: number } };

export type CostPlan =
	| { ok: false; error: string }
	| { ok: true; question: CostQuestion; parts?: undefined; mana?: undefined }
	| { ok: true; question?: undefined; parts: PlannedCost[]; mana: ManaCostRequirement | null };

function n(amount: Amount, ctx: CostContext): number {
	return Math.max(0, evaluateAmount(amount, filterCtx(ctx)));
}

function filterCtx(ctx: CostContext): FilterContext {
	return { state: ctx.state, controllerId: ctx.player.playerId, source: ctx.source, xValue: ctx.xValue };
}

function zoneOf(player: PlayerGameState, zone: PlayerZone): CardInstance[] {
	return player[zone];
}

function hasHaste(state: GameState, perm: CardInstance): boolean {
	return evaluatePermanent(state, perm).activeKeywords.some((k) => k.toLowerCase() === 'haste');
}

function sourceOnBattlefield(ctx: CostContext): boolean {
	return !ctx.isSpell && ctx.player.battlefield.some((c) => c.instanceId === ctx.source.instanceId);
}

/** Does this cost need the player to choose objects, and which objects could pay it? */
function objectCandidates(def: ObjectCostDef, ctx: CostContext, used: Set<string>): CardInstance[] | null {
	const fctx = filterCtx(ctx);
	const free = (c: CardInstance) => !used.has(c.instanceId) && !(ctx.isSpell && c.instanceId === ctx.source.instanceId);
	switch (def.k) {
		case 'tapOthers':
			return ctx.player.battlefield.filter(
				(c) => free(c) && !c.phasedOut && !c.tapped && matchesObjectFilter(c, def.filter, fctx)
			);
		case 'sacrifice':
			if (def.filter === 'self') return null;
			return ctx.player.battlefield.filter(
				(c) => free(c) && matchesObjectFilter(c, { ...(def.filter as ObjectFilter), controller: 'you' }, fctx)
			);
		case 'discard':
			return ctx.player.hand.filter((c) => free(c) && (!def.filter || matchesObjectFilter(c, def.filter, fctx)));
		case 'exileFrom': {
			if (def.filter === 'self') return null;
			if (def.zone !== 'graveyard' && def.zone !== 'hand' && def.zone !== 'battlefield') return [];
			const filter = def.filter as ObjectFilter | undefined;
			return zoneOf(ctx.player, def.zone).filter((c) => free(c) && (!filter || matchesObjectFilter(c, filter, fctx)));
		}
	}
}

/** Checks a cost part that doesn't involve choosing objects. Returns an error or null. */
function checkSimple(def: CostDef, ctx: CostContext): string | null {
	const src = ctx.source;
	const name = src.card.name;
	switch (def.k) {
		case 'tapSelf':
		case 'untapSelf': {
			if (!sourceOnBattlefield(ctx)) return `${name} must be on the battlefield.`;
			if (def.k === 'tapSelf' && src.tapped) return `${name} is already tapped.`;
			if (def.k === 'untapSelf' && !src.tapped) return `${name} is already untapped.`;
			// CR 302.6: {T}/{Q} abilities of a creature need it to have been under your control since your
			// most recent turn began (or haste). Tapping *other* creatures for a cost doesn't.
			if (evaluatePermanent(ctx.state, src).isCreature && src.summoningSick && !hasHaste(ctx.state, src)) {
				return `${name} has summoning sickness and cannot use {${def.k === 'tapSelf' ? 'T' : 'Q'}} abilities yet.`;
			}
			return null;
		}
		case 'payLife': {
			const amount = n(def.amount, ctx);
			if (amount === 0) return null; // CR 119.4b
			// CR 119.8: a player who can't lose life can't pay life.
			if (ctx.player.lifeTotalCannotChangeThisTurn) return `Your life total can't change, so you can't pay ${amount} life.`;
			// CR 119.4: life total >= payment.
			if (ctx.player.life < amount) return `Not enough life to pay ${amount} life.`;
			return null;
		}
		case 'loyalty':
			if (def.delta < 0 && src.counters.loyalty < -def.delta) return 'Not enough loyalty counters.';
			return null;
		case 'removeCounters': {
			if (def.from !== 'self') return 'Removing counters from other objects is not supported yet.';
			const amount = n(def.count, ctx);
			if ((src.counters[def.counter as CounterType] || 0) < amount) {
				return `${name} doesn't have ${amount} ${def.counter} counter(s).`;
			}
			return null;
		}
		case 'sacrifice':
			if (def.filter === 'self' && !sourceOnBattlefield(ctx)) return `${name} must be on the battlefield to be sacrificed.`;
			return null;
		case 'exileFrom':
			if (def.filter === 'self') {
				const zone = def.zone as PlayerZone;
				if (!zoneOf(ctx.player, zone)?.some((c) => c.instanceId === src.instanceId)) {
					return `${name} must be in your ${def.zone} to be exiled.`;
				}
			}
			return null;
		default: {
			const extra = def as { k: string; count?: Amount };
			if (extra.k === 'mill' && extra.count) {
				const amount = n(extra.count, ctx);
				if (ctx.player.library.length < amount) {
					return `Not enough cards in library to mill ${amount}.`;
				}
			}
			return null;
		}
	}
}

function addRequirements(a: ManaCostRequirement | null, b: ManaCostRequirement): ManaCostRequirement {
	if (!a) return b;
	const colored = { ...a.colored };
	for (const c of Object.keys(colored) as Array<keyof typeof colored>) colored[c] += b.colored[c];
	return {
		colored,
		generic: a.generic + b.generic,
		hasX: a.hasX || b.hasX,
		xCount: a.xCount + b.xCount,
		totalCmc: a.totalCmc + b.totalCmc
	};
}

interface Flat {
	def: CostDef;
	/** A `mana` def from the ability's own cost (covered by ctx.baseMana). */
	topLevel: boolean;
}

/**
 * Resolves choices with the given answers. Returns the flattened costs, or the first open
 * question. `decide` is called for a choice without an answer and returns the option index if it can
 * be decided automatically.
 */
function flatten(
	defs: CostDef[],
	options: number[] | undefined,
	decide: (prefix: Flat[], rest: CostDef[], choice: Extract<CostDef, { k: 'choice' | 'optional' }>, index: number) =>
		| { option: number }
		| { error: string }
		| { question: CostQuestion }
): { flat: Flat[] } | { error: string } | { question: CostQuestion } {
	const flat: Flat[] = [];
	const work: Array<{ def: CostDef; topLevel: boolean }> = defs.map((def) => ({ def, topLevel: true }));
	let choiceIndex = 0;
	while (work.length > 0) {
		const { def, topLevel } = work.shift()!;
		if (def.k !== 'choice' && def.k !== 'optional') {
			flat.push({ def, topLevel });
			continue;
		}
		const opts = def.k === 'choice' ? def.options : [def.cost, []];
		const index = choiceIndex++;
		let chosen = options?.[index];
		if (chosen === undefined) {
			const d = decide(flat, work.map((w) => w.def), def, index);
			if ('error' in d || 'question' in d) return d;
			chosen = d.option;
		}
		if (!Number.isInteger(chosen) || chosen < 0 || chosen >= opts.length) {
			return { error: 'Invalid cost choice.' };
		}
		work.unshift(...opts[chosen].map((d) => ({ def: d, topLevel: false })));
	}
	return { flat };
}

/**
 * Plans paying `defs`. With no `payment`, every choice must be forced (one legal answer); otherwise
 * the first open choice is returned as `question`.
 */
export function planCosts(ctx: CostContext, defs: CostDef[], payment?: CostPayment): CostPlan {
	const flattened = flatten(defs, payment?.options, (prefix, rest, choice, index) => {
		const opts = choice.k === 'choice' ? choice.options : [choice.cost, []];
		// An option is legal if the whole cost can be paid with it (later choices still open).
		const legal = opts
			.map((o, i) => ({ i, ok: canPayCosts(ctx, [...prefix.map((f) => f.def), ...o, ...rest]) }))
			.filter((o) => o.ok)
			.map((o) => o.i);
		if (legal.length === 0) return { error: `Can't pay the cost: ${describeCost([choice])}.` };
		// "You may" is the player's decision whenever paying is possible; otherwise it isn't paid.
		if (legal.length === 1 && !(choice.k === 'optional' && legal[0] === 0)) return { option: legal[0] };
		return {
			question: {
				kind: 'option',
				index,
				labels: opts.map((o) => describeCost(o)),
				optional: choice.k === 'optional'
			}
		};
	});
	if ('error' in flattened) return { ok: false, error: flattened.error };
	if ('question' in flattened) return { ok: true, question: flattened.question };
	return planFlat(ctx, flattened.flat, payment?.objects);
}

function planFlat(ctx: CostContext, flat: Flat[], objects: string[][] | undefined): CostPlan {
	const parts: PlannedCost[] = [];
	const used = new Set<string>();
	let mana: ManaCostRequirement | null = ctx.baseMana;
	let objectIndex = 0;
	// CR 118.3: with {T} in the cost, the source can't also be tapped for "Tap an untapped ...".
	const tapsSelf = flat.some((f) => f.def.k === 'tapSelf');

	for (const { def, topLevel } of flat) {
		const err = checkSimple(def, ctx);
		if (err) return { ok: false, error: err };
		if (def.k === 'mana') {
			if (!topLevel || !ctx.baseMana) mana = addRequirements(mana, parseManaCost(def.cost, ctx.xValue));
			parts.push({ def });
			continue;
		}
		if (def.k !== 'tapOthers' && def.k !== 'sacrifice' && def.k !== 'discard' && def.k !== 'exileFrom') {
			parts.push({ def });
			continue;
		}
		const exclude = def.k === 'tapOthers' && tapsSelf ? new Set([...used, ctx.source.instanceId]) : used;
		const candidates = objectCandidates(def, ctx, exclude);
		if (!candidates) {
			parts.push({ def });
			if (def.filter === 'self') used.add(ctx.source.instanceId);
			continue;
		}
		const count = n(def.count, ctx);
		if (candidates.length < count) {
			return { ok: false, error: `Can't pay the cost: ${describeCost([def])} (not enough to choose from).` };
		}
		if (def.k === 'discard' && def.random) {
			// Random isn't a choice; the cards are picked when the cost is paid.
			parts.push({ def, random: { candidates, count } });
			for (const c of candidates) used.add(c.instanceId); // conservatively reserved
			continue;
		}
		const index = objectIndex++;
		const chosenIds = objects?.[index];
		let chosen: CardInstance[];
		if (chosenIds) {
			if (new Set(chosenIds).size !== chosenIds.length || chosenIds.length !== count) {
				return { ok: false, error: `Choose exactly ${count} for: ${describeCost([def])}.` };
			}
			const byId = new Map(candidates.map((c) => [c.instanceId, c]));
			if (chosenIds.some((id) => !byId.has(id))) {
				return { ok: false, error: `Illegal choice for: ${describeCost([def])}.` };
			}
			chosen = chosenIds.map((id) => byId.get(id)!);
		} else if (candidates.length === count) {
			chosen = candidates;
		} else {
			return {
				ok: true,
				question: {
					kind: 'objects',
					index,
					label: describeCost([def]),
					count,
					candidateIds: candidates.map((c) => c.instanceId)
				}
			};
		}
		for (const c of chosen) used.add(c.instanceId);
		parts.push({ def, objects: chosen });
	}

	if (mana && !canPayManaAfterTaps(ctx, parts, mana)) {
		return { ok: false, error: 'Insufficient mana to pay the cost.' };
	}
	return { ok: true, parts, mana };
}

/** Mana is paid after tap costs, so permanents tapped for the cost can't also tap for mana. */
function canPayManaAfterTaps(ctx: CostContext, parts: PlannedCost[], mana: ManaCostRequirement): boolean {
	const toTap = tapTargets(ctx, parts).filter((c) => !c.tapped);
	for (const c of toTap) c.tapped = true;
	try {
		return ctx.canPayMana(mana);
	} finally {
		for (const c of toTap) c.tapped = false;
	}
}

function tapTargets(ctx: CostContext, parts: PlannedCost[]): CardInstance[] {
	const out: CardInstance[] = [];
	for (const p of parts) {
		if (p.def.k === 'tapSelf') out.push(ctx.source);
		if (p.def.k === 'tapOthers') out.push(...(p.objects ?? []));
	}
	return out;
}

/**
 * Picks a legal `CostPayment` greedily (for bots and legality checks): first legal option for
 * choices (declining optional costs), and tokens-first then lowest-CMC for objects. Returns null if
 * the cost can't be paid.
 */
export function chooseCostPayment(ctx: CostContext, defs: CostDef[]): CostPayment | null {
	const options: number[] = [];
	const result = flatten(defs, undefined, (prefix, rest, choice, index) => {
		const opts = choice.k === 'choice' ? choice.options : [choice.cost, []];
		const order = choice.k === 'optional' ? [1, 0] : opts.map((_, i) => i);
		for (const i of order) {
			if (canPayCosts(ctx, [...prefix.map((f) => f.def), ...opts[i], ...rest])) {
				options[index] = i;
				return { option: i };
			}
		}
		return { error: 'unpayable' };
	});
	if (!('flat' in result)) return null;
	// Choose objects greedily: tokens first, then cheapest (any legal choice proves payability).
	const greedy = (ids: CardInstance[], count: number) =>
		[...ids]
			.sort((a, b) => (a.isToken !== b.isToken ? (a.isToken ? -1 : 1) : a.card.cmc - b.card.cmc))
			.slice(0, count)
			.map((c) => c.instanceId);
	const objects: string[][] = [];
	for (;;) {
		const plan = planFlat(ctx, result.flat, objects);
		if (!plan.ok) return null;
		if (!plan.question) {
			return {
				...(options.length > 0 ? { options } : {}),
				...(objects.length > 0 ? { objects } : {})
			};
		}
		if (plan.question.kind !== 'objects') return null;
		const q = plan.question;
		const candidates = q.candidateIds
			.map((id) => findById(ctx, id))
			.filter((c): c is CardInstance => c !== undefined);
		objects[q.index] = greedy(candidates, q.count);
	}
}

/** Can `defs` be paid in some way? Object choices are made greedily (tokens first, then cheapest). */
export function canPayCosts(ctx: CostContext, defs: CostDef[]): boolean {
	return chooseCostPayment(ctx, defs) !== null;
}

function findById(ctx: CostContext, id: string): CardInstance | undefined {
	for (const z of ['battlefield', 'hand', 'graveyard', 'exile'] as const) {
		const c = ctx.player[z].find((x) => x.instanceId === id);
		if (c) return c;
	}
	return undefined;
}

// ---- Paying ----------------------------------------------------------------------------------

export interface PaidCosts {
	/** What was paid, for the caller's log ("sacrificed Llanowar Elves", "paid 3 life"). */
	descriptions: string[];
}

function sacrifice(ctx: CostContext, perm: CardInstance): void {
	// CR 701.21a: to its owner's graveyard. Same bookkeeping as movePermanentToZone.
	moveObject(ctx.state, perm, 'graveyard', {
		from: 'anyBattlefield',
		detachAttachments: true,
		graveyardReplacement: true,
		commanderRedirect: true,
		leaveBattlefieldReset: true,
		bumpVersion: true,
		newTimestamp: true,
		insert: (actual) => (actual === 'library' ? 'start' : 'end'),
		ceaseToExist: 'tokens'
	});
}

function moveFromZone(ctx: CostContext, card: CardInstance, zone: PlayerZone, to: 'graveyard' | 'exile'): void {
	if (zone === 'battlefield') {
		moveObject(ctx.state, card, to, {
			from: 'anyBattlefield',
			detachAttachments: true,
			graveyardReplacement: true,
			commanderRedirect: true,
			leaveBattlefieldReset: true,
			bumpVersion: true,
			newTimestamp: true,
			ceaseToExist: 'tokens'
		});
		return;
	}
	moveObject(ctx.state, card, to, {
		from: { player: ctx.player, zone },
		graveyardReplacement: to === 'graveyard',
		newTimestamp: true,
		bumpVersion: true
	});
}

/** Pays a complete plan from `planCosts`. */
export function payPlannedCosts(ctx: CostContext, plan: Extract<CostPlan, { parts: PlannedCost[] }>): PaidCosts {
	const descriptions: string[] = [];
	const { player, source } = ctx;

	// 1. Tap and untap costs.
	for (const part of plan.parts) {
		if (part.def.k === 'tapSelf') source.tapped = true;
		if (part.def.k === 'untapSelf') source.tapped = false;
		if (part.def.k === 'tapOthers') {
			for (const c of part.objects ?? []) c.tapped = true;
			descriptions.push(`tapped ${(part.objects ?? []).map((c) => c.card.name).join(', ')}`);
		}
	}
	// 2. Mana (planCosts checked it can be paid with these permanents already tapped).
	if (plan.mana) ctx.payMana(plan.mana);

	// 3. Everything else; random costs last (CR 601.2h).
	const ordered = [...plan.parts.filter((p) => !p.random), ...plan.parts.filter((p) => p.random)];
	for (const part of ordered) {
		const def = part.def;
		switch (def.k) {
			case 'payLife': {
				const amount = n(def.amount, ctx);
				if (amount > 0) {
					player.life -= amount;
					descriptions.push(`paid ${amount} life`);
				}
				break;
			}
			case 'loyalty':
				source.counters.loyalty += def.delta;
				source.usedLoyaltyThisTurn = true;
				break;
			case 'removeCounters': {
				const amount = n(def.count, ctx);
				const key = def.counter as CounterType;
				source.counters[key] = Math.max(0, (source.counters[key] || 0) - amount);
				descriptions.push(`removed ${amount} ${def.counter} counter(s)`);
				break;
			}
			case 'sacrifice': {
				const perms = def.filter === 'self' ? [source] : part.objects ?? [];
				for (const p of perms) sacrifice(ctx, p);
				if (def.filter !== 'self') descriptions.push(`sacrificed ${perms.map((c) => c.card.name).join(', ')}`);
				break;
			}
			case 'discard': {
				let cards = part.objects ?? [];
				if (part.random) {
					const pool = [...part.random.candidates];
					cards = [];
					for (let i = 0; i < part.random.count && pool.length > 0; i++) {
						cards.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
					}
				}
				for (const c of cards) moveFromZone(ctx, c, 'hand', 'graveyard');
				descriptions.push(`discarded ${cards.map((c) => c.card.name).join(', ')}${part.random ? ' at random' : ''}`);
				break;
			}
			case 'exileFrom': {
				const zone = def.zone as PlayerZone;
				const cards = def.filter === 'self' ? [source] : part.objects ?? [];
				for (const c of cards) moveFromZone(ctx, c, zone, 'exile');
				descriptions.push(`exiled ${cards.map((c) => c.card.name).join(', ')} from ${def.zone}`);
				break;
			}
			default: {
				const extra = def as { k: string; count?: Amount };
				if (extra.k === 'mill' && extra.count) {
					const amount = n(extra.count, ctx);
					const milled: CardInstance[] = [];
					for (let i = 0; i < amount && player.library.length > 0; i++) {
						const top = player.library[0];
						moveFromZone(ctx, top, 'library', 'graveyard');
						milled.push(top);
					}
					if (milled.length > 0) {
						descriptions.push(`milled ${milled.map((c) => c.card.name).join(', ')}`);
					}
				}
				break;
			}
		}
	}
	return { descriptions };
}
