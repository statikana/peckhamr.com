/**
 * Card compiler entry point (ENGINE_ARCHITECTURE_PLAN.md section 2.2).
 *
 * compileCard turns a card into a CardDefinition. Results are cached in memory per isolate, keyed
 * by oracle id + text hash + COMPILER_VERSION; nothing is persisted (section 2.6). The IR must never
 * be stored in GameState: stack items refer to abilities by id or index and the runtime looks the IR
 * up here.
 */
import type { CardLayout, CompiledDelayedEffect, ManaColor, ScryfallCard, StackItem } from '../types.ts';
import type {
	AbilityDef,
	Amount,
	CardDefinition,
	Compare,
	Condition,
	CostDef,
	EffectStep,
	FaceDefinition,
	KeywordAbility,
	ModalDef,
	ObjectFilter,
	PlayerRef,
	Ref,
	Selector,
	TargetSpec
} from '../ir.ts';
import { getKeywordSpec } from '../keywords.ts';
import { resolveCardOverride } from '../overrides/index.ts';
import { getCardFaces } from '../scryfall.ts';
import { compileFaces } from './card.ts';
import { parseAbilityEffectText } from './effects.ts';
import { hashText, normalizeFace, printedText } from './normalize.ts';
import { runtimeTriggers } from './triggers.ts';

/** Bump whenever the IR produced for the same text could change. */
export const COMPILER_VERSION = 41;

const CACHE = new Map<string, CardDefinition>();

/**
 * Phase 6d: the definition last returned for each card object, so repeat calls with the same object
 * skip rebuilding and hashing the source text. A hit also requires every field `sourceText` and the
 * key read to be unchanged, so a card mutated in place still recompiles.
 */
interface CardMemo {
	def: CardDefinition;
	oracleId: string | undefined;
	id: string;
	layout: CardLayout | undefined;
	name: string;
	manaCost: string;
	typeLine: string;
	oracleText: string;
	power: string | undefined;
	toughness: string | undefined;
	loyalty: string | undefined;
	colors: string[];
	colorIndicator: ManaColor[] | undefined;
	faces: ScryfallCard['faces'];
	facesDigest: string;
	backFace: ScryfallCard['backFace'];
	backName: string | undefined;
	backManaCost: string | undefined;
	backTypeLine: string | undefined;
	backOracleText: string | undefined;
}

let BY_CARD = new WeakMap<ScryfallCard, CardMemo>();

export function clearCompileCache(): void {
	CACHE.clear();
	BY_CARD = new WeakMap();
}

function facesSourceText(faces: ScryfallCard['faces']): string {
	if (!faces || faces.length === 0) return '';
	return faces
		.map((f) =>
			[
				f.name,
				f.manaCost,
				f.cmc ?? '',
				f.typeLine,
				f.oracleText,
				f.colors.join(''),
				f.colorIndicator?.join('') ?? '',
				f.keywords?.join(',') ?? '',
				f.power ?? '',
				f.toughness ?? '',
				f.loyalty ?? '',
				f.defense ?? ''
			].join('\u0001')
		)
		.join('\u0002');
}

function sameOptionalArray<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function memoMatches(m: CardMemo, card: ScryfallCard): boolean {
	const back = card.backFace;
	if (
		m.oracleId !== card.oracleId ||
		m.id !== card.id ||
		m.layout !== card.layout ||
		m.name !== card.name ||
		m.manaCost !== card.manaCost ||
		m.typeLine !== card.typeLine ||
		m.oracleText !== card.oracleText ||
		m.power !== card.power ||
		m.toughness !== card.toughness ||
		m.loyalty !== card.loyalty ||
		m.backFace !== back ||
		m.backName !== back?.name ||
		m.backManaCost !== back?.manaCost ||
		m.backTypeLine !== back?.typeLine ||
		m.backOracleText !== back?.oracleText
	) {
		return false;
	}
	if (!sameOptionalArray(m.colors, card.colors)) return false;
	if (!sameOptionalArray(m.colorIndicator, card.colorIndicator)) return false;
	if (m.faces !== card.faces || (card.faces && m.facesDigest !== facesSourceText(card.faces))) {
		return false;
	}
	return true;
}

function sourceText(card: ScryfallCard): string {
	const back = card.backFace;
	return [
		card.layout ?? '',
		card.name,
		card.manaCost,
		card.typeLine,
		card.oracleText,
		card.power ?? '',
		card.toughness ?? '',
		card.loyalty ?? '',
		card.colors.join(''),
		card.colorIndicator?.join('') ?? '',
		facesSourceText(card.faces),
		back ? [back.name, back.manaCost, back.typeLine, back.oracleText].join('\u0001') : ''
	].join('\u0000');
}

export function compileCard(card: ScryfallCard): CardDefinition {
	const memo = BY_CARD.get(card);
	if (memo && memoMatches(memo, card)) return memo.def;
	const def = compileCardByText(card);
	const back = card.backFace;
	BY_CARD.set(card, {
		def,
		oracleId: card.oracleId,
		id: card.id,
		layout: card.layout,
		name: card.name,
		manaCost: card.manaCost,
		typeLine: card.typeLine,
		oracleText: card.oracleText,
		power: card.power,
		toughness: card.toughness,
		loyalty: card.loyalty,
		colors: [...card.colors],
		colorIndicator: card.colorIndicator ? [...card.colorIndicator] : undefined,
		faces: card.faces,
		facesDigest: facesSourceText(card.faces),
		backFace: back,
		backName: back?.name,
		backManaCost: back?.manaCost,
		backTypeLine: back?.typeLine,
		backOracleText: back?.oracleText
	});
	return def;
}

function compileCardByText(card: ScryfallCard): CardDefinition {
	const oracleId = card.oracleId ?? card.id;
	const textHash = hashText(sourceText(card));
	const key = `${oracleId}:${textHash}:${COMPILER_VERSION}`;
	const cached = CACHE.get(key);
	if (cached) return cached;

	const overridden = resolveCardOverride(oracleId, textHash, card.name, COMPILER_VERSION);
	if (overridden) {
		CACHE.set(key, overridden);
		return overridden;
	}

	const faces = compileFaces(card);
	const def: CardDefinition = {
		oracleId,
		compilerVersion: COMPILER_VERSION,
		textHash,
		name: card.name,
		...(card.layout && card.layout !== 'normal' ? { layout: card.layout } : {}),
		faces,
		fullySupported: faces.every((f) => f.abilities.every((a) => a.kind !== 'unsupported'))
	};
	CACHE.set(key, def);
	return def;
}

/**
 * What the interpreter runs for one ability: its steps, target specs and (spells) modes. Abilities
 * the compiler marked `unsupported` have none, so "has a CompiledEffect" and "is automated" are the
 * same thing (compiler/interpretable.ts decides both).
 */
export interface CompiledEffect {
	steps: EffectStep[];
	targets: TargetSpec[];
	modal?: ModalDef;
	unparsed: [];
}

export function effectOf(ab: AbilityDef | undefined): CompiledEffect | null {
	if (!ab) return null;
	if (ab.kind === 'spell') return { steps: ab.effect, targets: ab.targets, modal: ab.modal, unparsed: [] };
	if (ab.kind === 'activated' || ab.kind === 'triggered') {
		return { steps: ab.effect, targets: ab.targets, ...(ab.modal ? { modal: ab.modal } : {}), unparsed: [] };
	}
	if (ab.kind === 'keyword') {
		if (ab.keyword.name === 'equip') return equipEffect(ab);
		const spec = getKeywordSpec(ab.keyword.name);
		if (spec?.status === 'implemented' && spec.implementation?.kind === 'activated' && spec.implementation.buildActivated) {
			const built = spec.implementation.buildActivated(ab.keyword, ab.id ?? '', ab.span);
			if (built) return { steps: built.ability.effect, targets: built.ability.targets, unparsed: [] };
		}
	}
	return null;
}

/** CR 702.6a: "[Cost]: Attach this permanent to target [quality] creature you control." */
function equipEffect(ab: KeywordAbility): CompiledEffect {
	const span = ab.span;
	return {
		steps: [{ verb: 'attach', subject: { k: 'target', index: 0 }, span }],
		targets: [{ kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you', ...(ab.keyword.equipFilter ?? {}) }, min: 1, max: 1 }],
		unparsed: []
	};
}

/** The abilities of the card's face (`faceIndex`, defaulting to 0). */
export function cardAbilities(card: ScryfallCard, faceIndex = 0): AbilityDef[] {
	return compileCard(card).faces[faceIndex]?.abilities ?? [];
}

/** An ability of the card by its id (`act_3`, `loyalty_1`, `equip_2`, `mana_tap`, or `f<idx>:<id>`). */
export function abilityById(card: ScryfallCard, id: string, faceIndex = 0): AbilityDef | undefined {
	const prefixed = /^f(\d+):(.+)$/.exec(id);
	const resolvedFace = prefixed ? Number(prefixed[1]) : faceIndex;
	const rawId = prefixed ? prefixed[2] : id;
	return cardAbilities(card, resolvedFace).find(
		(a) => (a.kind === 'activated' || a.kind === 'unsupported' || a.kind === 'keyword') && a.id === rawId
	);
}

/** A granted activated ability inside a `grantAbility` static on `card`, by its compile-time id (`granted_0`, ...). */
export function grantedAbilityById(
	card: ScryfallCard,
	localId: string,
	faceIndex?: number
): AbilityDef | undefined {
	const faces = faceIndex !== undefined ? [compileCard(card).faces[faceIndex]].filter(Boolean) : compileCard(card).faces;
	for (const face of faces) {
		for (const a of face.abilities) {
			if (
				a.kind === 'static' &&
				a.static.k === 'continuous' &&
				a.static.mod.k === 'grantAbility' &&
				a.static.mod.ability.kind === 'activated' &&
				a.static.mod.ability.id === localId
			) {
				return a.static.mod.ability;
			}
		}
	}
	return undefined;
}

/** The compiled spell ability of an instant or sorcery face (or fused split halves), or null when not automated. */
export function compileSpellEffects(card: ScryfallCard, faceIndex = 0, fused = false): CompiledEffect | null {
	const def = compileCard(card);
	if (fused) {
		const left = effectOf(def.faces[0]?.abilities.find((a) => a.kind === 'spell'));
		const right = effectOf(def.faces[1]?.abilities.find((a) => a.kind === 'spell'));
		if (!left || !right || left.modal || right.modal) return null;
		const targetOffset = left.targets.length;
		const stepOffset = left.steps.length;
		return {
			steps: [...left.steps, ...right.steps.map((s) => shiftStepTargets(s, targetOffset, stepOffset))],
			targets: [...left.targets, ...right.targets],
			unparsed: []
		};
	}
	return effectOf(def.faces[faceIndex]?.abilities.find((a) => a.kind === 'spell'));
}

/**
 * The compiled effect of a card's triggered ability, by the ability's index in
 * compileCard(card).faces[faceIndex].abilities (StackItem.triggeredAbilityIndex). Null when the
 * ability isn't automated (its effect is `unsupported`) or isn't a trigger the runtime runs itself
 * (Ward).
 */
export function compiledTriggerEffect(
	card: ScryfallCard,
	abilityIndex: number,
	grantedKeyword?: string,
	faceIndex = 0,
	chosenModes?: number[]
): CompiledEffect | null {
	if (grantedKeyword || abilityIndex === -1) {
		const spec = getKeywordSpec(grantedKeyword ?? 'prowess');
		if (spec?.status === 'implemented' && spec.implementation?.kind === 'trigger') {
			return spec.implementation.buildTriggers({ name: spec.name }, abilityIndex, { start: 0, end: 0 })[0]?.effect ?? null;
		}
		return null;
	}
	const t = runtimeTriggers(compileCard(card), faceIndex).find((x) => x.abilityIndex === abilityIndex);
	if (t?.effect?.modal && chosenModes) {
		return expandModalEffects(t.effect.modal, chosenModes);
	}
	return t?.effect ?? null;
}

/**
 * Dynamically recompile and walk `stepPath` to recover the `EffectStep[]` for a `compiledDelayed`
 * trigger (CR 603.7) without storing IR in `GameState`.
 */
export function resolveCompiledDelayedSteps(eff: CompiledDelayedEffect): CompiledEffect | null {
	const faceIdx = eff.faceIndex ?? 0;
	let root: CompiledEffect | null = null;
	if (eff.abilityKind === 'spell') {
		const spell = compileSpellEffects(eff.sourceCard, faceIdx, eff.fused ?? false);
		root = spell?.modal && eff.chosenModes ? expandModalEffects(spell.modal, eff.chosenModes) : spell;
	} else if (eff.abilityKind === 'activated') {
		if (eff.abilityId) {
			const base =
				eff.grantSourceCard && eff.abilityId.startsWith('granted:')
					? effectOf(grantedAbilityById(eff.grantSourceCard, eff.abilityId.slice(eff.abilityId.lastIndexOf(':') + 1)))
					: effectOf(abilityById(eff.sourceCard, eff.abilityId, faceIdx));
			root = base?.modal && eff.chosenModes ? expandModalEffects(base.modal, eff.chosenModes) : base;
		}
	} else if (eff.abilityKind === 'triggered') {
		if (eff.grantedKeyword || eff.abilityIndex !== undefined) {
			root = compiledTriggerEffect(
				eff.sourceCard,
				eff.abilityIndex ?? -1,
				eff.grantedKeyword,
				faceIdx,
				eff.chosenModes
			);
		}
	}
	if (!root || eff.stepPath.length === 0) return null;
	let steps: EffectStep[] = root.steps;
	// --- Precon Bragos Spirit: negative tags descend into inline branches (die-roll rows, coin flips),
	// matching `stepPathPrefix` from the runtime's inline branch runner (resolveReflexiveSpecFromCompiled) ---
	let branchHost: EffectStep | undefined;
	for (let i = 0; i < eff.stepPath.length; i++) {
		const idx = eff.stepPath[i];
		if (idx < 0) {
			if (!branchHost) return null;
			const branch =
				idx === -1
					? branchHost.params?.winFlipEffect
					: idx === -2
						? branchHost.params?.loseFlipEffect
						: idx <= -10
							? branchHost.params?.dieRollTable?.[-(idx + 10)]?.effect
							: undefined;
			if (!branch) return null;
			steps = branch;
			branchHost = undefined;
			continue;
		}
		const step = steps[idx];
		if (!step) return null;
		if (i + 1 < eff.stepPath.length && eff.stepPath[i + 1] < 0) {
			branchHost = step;
			continue;
		}
		if (!step.delayed) return null;
		steps = step.delayed.effect;
	}
	// --- End Precon Bragos Spirit ---
	return { steps, targets: root.targets, unparsed: [] };
}

function shiftRef(ref: Ref, offset: number): Ref {
	return ref.k === 'target' ? { k: 'target', index: ref.index + offset } : ref;
}

function shiftPlayerRef(ref: PlayerRef, offset: number): PlayerRef {
	if (ref.k === 'target') return { k: 'target', index: ref.index + offset };
	if (ref.k === 'controllerOf' || ref.k === 'ownerOf') return { k: ref.k, of: shiftRef(ref.of, offset) };
	return ref;
}

function shiftCompare(cmp: Compare, offset: number): Compare {
	return { ...cmp, value: shiftAmount(cmp.value, offset) };
}

function shiftObjectFilter(filter: ObjectFilter, offset: number): ObjectFilter {
	let changed = false;
	const out: ObjectFilter = { ...filter };
	if (filter.controllerRef) {
		out.controllerRef = shiftPlayerRef(filter.controllerRef, offset);
		changed = true;
	}
	if (filter.manaValue) {
		out.manaValue = shiftCompare(filter.manaValue, offset);
		changed = true;
	}
	if (filter.power) {
		out.power = shiftCompare(filter.power, offset);
		changed = true;
	}
	if (filter.toughness) {
		out.toughness = shiftCompare(filter.toughness, offset);
		changed = true;
	}
	return changed ? out : filter;
}

function shiftSelector(sel: Selector, offset: number): Selector {
	if (sel.k === 'target') return { k: 'target', index: sel.index + offset };
	if (sel.k === 'playerRef') return { k: 'playerRef', ref: shiftPlayerRef(sel.ref, offset) };
	if (sel.k === 'libraryTop' && sel.player) return { k: 'libraryTop', player: shiftPlayerRef(sel.player, offset) };
	if (sel.k === 'all') return { k: 'all', filter: shiftObjectFilter(sel.filter, offset) };
	return sel;
}

function shiftAmount(a: Amount, offset: number): Amount {
	if (a.k === 'count') return { k: 'count', of: shiftObjectFilter(a.of, offset) };
	if (a.k === 'stat') return { ...a, of: shiftRef(a.of, offset) };
	if (a.k === 'countersOn') return { ...a, of: shiftRef(a.of, offset) };
	if (a.k === 'life' || a.k === 'cardsIn') return { ...a, of: shiftPlayerRef(a.of, offset) };
	if (a.k === 'energyCount') return { k: 'energyCount', player: shiftPlayerRef(a.player, offset) };
	if (a.k === 'negate') return { k: 'negate', of: shiftAmount(a.of, offset) };
	if (a.k === 'sum' || a.k === 'min' || a.k === 'max') return { k: a.k, args: a.args.map((x) => shiftAmount(x, offset)) };
	return a;
}

function shiftCondition(cond: Condition, offset: number): Condition {
	if (cond.k === 'compare') return { ...cond, left: shiftAmount(cond.left, offset), right: shiftAmount(cond.right, offset) };
	if (cond.k === 'graveyardAbove') return { ...cond, filter: shiftObjectFilter(cond.filter, offset) };
	if (cond.k === 'isTurnOf') return { ...cond, player: shiftPlayerRef(cond.player, offset) };
	if (cond.k === 'isMonarch') return cond.player ? { ...cond, player: shiftPlayerRef(cond.player, offset) } : cond;
	if (cond.k === 'not') return { k: 'not', of: shiftCondition(cond.of, offset) };
	if (cond.k === 'and' || cond.k === 'or') return { k: cond.k, of: cond.of.map((c) => shiftCondition(c, offset)) };
	return cond;
}

function shiftCostDef(cost: CostDef, offset: number): CostDef {
	if (cost.k === 'payLife') return { ...cost, amount: shiftAmount(cost.amount, offset) };
	if (cost.k === 'payEnergy') return { ...cost, count: shiftAmount(cost.count, offset) };
	if (cost.k === 'tapOthers') {
		return { ...cost, count: shiftAmount(cost.count, offset), filter: shiftObjectFilter(cost.filter, offset) };
	}
	if (cost.k === 'tapSubsetSum') {
		return { ...cost, minTotal: shiftAmount(cost.minTotal, offset), filter: shiftObjectFilter(cost.filter, offset) };
	}
	if (cost.k === 'sacrifice' || cost.k === 'discard' || cost.k === 'exileFrom' || cost.k === 'revealFromHand') {
		return {
			...cost,
			count: shiftAmount(cost.count, offset),
			...(cost.filter && cost.filter !== 'self' ? { filter: shiftObjectFilter(cost.filter, offset) } : {})
		};
	}
	if (cost.k === 'removeCounters') {
		return {
			...cost,
			count: shiftAmount(cost.count, offset),
			...(cost.from !== 'self' ? { from: shiftObjectFilter(cost.from, offset) } : {})
		};
	}
	if (cost.k === 'choice') return { k: 'choice', options: cost.options.map((opt) => opt.map((c) => shiftCostDef(c, offset))) };
	if (cost.k === 'optional') return { k: 'optional', cost: cost.cost.map((c) => shiftCostDef(c, offset)) };
	return cost;
}

function shiftTargetSpec(spec: TargetSpec, offset: number): TargetSpec {
	if (offset === 0) return spec;
	return {
		...spec,
		filter: shiftObjectFilter(spec.filter, offset),
		...(spec.condition ? { condition: shiftCondition(spec.condition, offset) } : {})
	};
}

function shiftStepTargets(step: EffectStep, offset: number, stepOffset = 0): EffectStep {
	if (offset === 0 && stepOffset === 0) return step;
	return {
		...step,
		subject: shiftSelector(step.subject, offset),
		...(step.actor ? { actor: shiftPlayerRef(step.actor, offset) } : {}),
		...(step.optional
			? {
					optional: {
						...step.optional,
						chooser: shiftPlayerRef(step.optional.chooser, offset),
						...(step.optional.cost ? { cost: step.optional.cost.map((c) => shiftCostDef(c, offset)) } : {})
					}
				}
			: {}),
		...(step.amount ? { amount: shiftAmount(step.amount, offset) } : {}),
		...(step.condition ? { condition: shiftCondition(step.condition, offset) } : {}),
		...(step.params
			? {
					params: {
						...step.params,
						...(step.params.with ? { with: shiftSelector(step.params.with, offset) } : {}),
						...(step.params.damageSource ? { damageSource: shiftSelector(step.params.damageSource, offset) } : {}),
						...(step.params.toughness ? { toughness: shiftAmount(step.params.toughness, offset) } : {}),
						...(step.params.setPower ? { setPower: shiftAmount(step.params.setPower, offset) } : {}),
						...(step.params.setToughness ? { setToughness: shiftAmount(step.params.setToughness, offset) } : {}),
						...(step.params.count ? { count: shiftAmount(step.params.count, offset) } : {}),
						...(step.params.condition ? { condition: shiftCondition(step.params.condition, offset) } : {}),
						...(step.params.search
							? { search: { ...step.params.search, filter: shiftObjectFilter(step.params.search.filter, offset) } }
							: {}),
						...(step.params.coerciveDiscard
							? {
									coerciveDiscard: {
										...step.params.coerciveDiscard,
										chooser: shiftPlayerRef(step.params.coerciveDiscard.chooser, offset),
										...(step.params.coerciveDiscard.filter
											? { filter: shiftObjectFilter(step.params.coerciveDiscard.filter, offset) }
											: {})
									}
								}
							: {})
					}
				}
			: {}),
		...(step.delayed
			? {
					delayed: {
						...step.delayed,
						effect: step.delayed.effect.map((s) => shiftStepTargets(s, offset, stepOffset))
					}
				}
			: {}),
		...(step.ifPrecedingAccepted !== undefined
			? { ifPrecedingAccepted: step.ifPrecedingAccepted + stepOffset }
			: {}),
		...(step.ifPrecedingDeclined !== undefined
			? { ifPrecedingDeclined: step.ifPrecedingDeclined + stepOffset }
			: {})
	};
}

/** Expand chosen mode indices into a sequential CompiledEffect with re-indexed targets & steps. */
export function expandModalEffects(modal: ModalDef, chosenModes: number[]): CompiledEffect | null {
	const steps: EffectStep[] = [];
	const targets: TargetSpec[] = [];
	for (const idx of chosenModes) {
		const mode = modal.modes[idx];
		if (!mode) return null;
		const offset = targets.length;
		const stepOffset = steps.length;
		targets.push(...mode.targets.map((spec) => shiftTargetSpec(spec, offset)));
		steps.push(...mode.effect.map((s) => shiftStepTargets(s, offset, stepOffset)));
	}
	return { steps, targets, modal, unparsed: [] };
}

/** Return the `ModalDef` for an activated ability (printed or granted), if it is modal. */
export function getAbilityModal(
	card: ScryfallCard,
	abilityId: string,
	faceIndex = 0,
	grantSourceCard?: ScryfallCard
): ModalDef | undefined {
	if (grantSourceCard && abilityId.startsWith('granted:')) {
		const localId = abilityId.slice(abilityId.lastIndexOf(':') + 1);
		const ab = grantedAbilityById(grantSourceCard, localId);
		return ab?.kind === 'activated' ? ab.modal : undefined;
	}
	const ab = abilityById(card, abilityId, faceIndex);
	return ab?.kind === 'activated' ? ab.modal : undefined;
}

/** Human-readable bullet descriptions for a `ModalDef` without leaking raw `oracleText` into runtime/UI. */
export function describeModalModes(card: ScryfallCard, modal: ModalDef, faceIndex = 0): string[] {
	const face = getCardFaces(card)[faceIndex] ?? getCardFaces(card)[0];
	const faceName = face?.name ?? card.name;
	const oracleText = face?.oracleText ?? '';
	const normText = oracleText ? normalizeFace(faceName, oracleText).text : '';
	return modal.modes.map((mode, idx) => {
		if (!normText || mode.span.end <= mode.span.start) return `Mode ${idx + 1}`;
		const raw = normText.slice(mode.span.start, mode.span.end).replace(/^•\s*/, '').trim();
		if (!raw) return `Mode ${idx + 1}`;
		return printedText(raw, faceName, oracleText);
	});
}

function isSpellFaceDef(face: FaceDefinition | undefined): boolean {
	return !!face && (face.characteristics.types.includes('Instant') || face.characteristics.types.includes('Sorcery'));
}

/**
 * The compiled effect of a resolving spell or activated ability, or null when it isn't automated.
 * Activated abilities are found by `StackItem.abilityId`. Items without one (built by hand in older
 * tests) fall back to compiling the item's effect text.
 */
export function compiledStackItemEffects(item: StackItem): CompiledEffect | null {
	if (item.kind === 'spell') {
		const def = compileCard(item.card);
		const faceIdx = item.faceIndex ?? 0;
		if (item.fused) {
			if (!isSpellFaceDef(def.faces[0]) || !isSpellFaceDef(def.faces[1])) return null;
		} else if (!isSpellFaceDef(def.faces[faceIdx])) {
			return null;
		}
		const spell = compileSpellEffects(item.card, faceIdx, item.fused ?? false);
		if (spell?.modal && item.chosenModes) {
			return expandModalEffects(spell.modal, item.chosenModes);
		}
		return spell;
	}
	if (item.kind !== 'activated') return null;
	const faceIdx = item.faceIndex ?? 0;
	if (item.abilityId) {
		const base =
			item.grantSourceCard && item.abilityId.startsWith('granted:')
				? effectOf(grantedAbilityById(item.grantSourceCard, item.abilityId.slice(item.abilityId.lastIndexOf(':') + 1)))
				: effectOf(abilityById(item.card, item.abilityId, faceIdx));
		if (base?.modal && item.chosenModes) {
			return expandModalEffects(base.modal, item.chosenModes);
		}
		return base;
	}
	const faceName = item.card.faces?.[faceIdx]?.name ?? item.card.name;
	const parse = parseAbilityEffectText(faceName, item.oracleText ?? '');
	return parse.unparsed.length > 0 ? null : { steps: parse.steps, targets: parse.targets, unparsed: [] };
}

/** The `addMana` steps of a card's mana abilities across all faces (CR 106.7 "a land an opponent controls could produce"). */
export function cardManaSteps(card: ScryfallCard): EffectStep[] {
	return compileCard(card).faces.flatMap((face) =>
		face.abilities.flatMap((a) =>
			(a.kind === 'activated' || a.kind === 'unsupported') && a.isMana && a.effect
				? a.effect.filter((s) => s.verb === 'addMana')
				: []
		)
	);
}

export { normalizeFace } from './normalize.ts';
