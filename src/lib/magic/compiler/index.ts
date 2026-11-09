/**
 * Card compiler entry point (ENGINE_ARCHITECTURE_PLAN.md section 2.2).
 *
 * compileCard turns a card into a CardDefinition. Results are cached in memory per isolate, keyed
 * by oracle id + text hash + COMPILER_VERSION; nothing is persisted (section 2.6). The IR must never
 * be stored in GameState: stack items refer to abilities by id or index and the runtime looks the IR
 * up here.
 */
import type { ScryfallCard, StackItem } from '../types.ts';
import type { AbilityDef, Amount, CardDefinition, EffectStep, KeywordAbility, ModalDef, PlayerRef, Ref, Selector, TargetSpec } from '../ir.ts';
import { compileFaces } from './card.ts';
import { parseAbilityEffectText } from './effects.ts';
import { hashText } from './normalize.ts';
import { runtimeTriggers } from './triggers.ts';

/** Bump whenever the IR produced for the same text could change. */
export const COMPILER_VERSION = 4;

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
	name: string;
	manaCost: string;
	typeLine: string;
	oracleText: string;
	power: string | undefined;
	toughness: string | undefined;
	loyalty: string | undefined;
	colors: string[];
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

function memoMatches(m: CardMemo, card: ScryfallCard): boolean {
	const back = card.backFace;
	if (
		m.oracleId !== card.oracleId ||
		m.id !== card.id ||
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
	const colors = card.colors;
	if (m.colors.length !== colors.length) return false;
	for (let i = 0; i < colors.length; i++) if (m.colors[i] !== colors[i]) return false;
	return true;
}

function sourceText(card: ScryfallCard): string {
	const back = card.backFace;
	return [
		card.name,
		card.manaCost,
		card.typeLine,
		card.oracleText,
		card.power ?? '',
		card.toughness ?? '',
		card.loyalty ?? '',
		card.colors.join(''),
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
		name: card.name,
		manaCost: card.manaCost,
		typeLine: card.typeLine,
		oracleText: card.oracleText,
		power: card.power,
		toughness: card.toughness,
		loyalty: card.loyalty,
		colors: [...card.colors],
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

	const faces = compileFaces(card);
	const def: CardDefinition = {
		oracleId,
		compilerVersion: COMPILER_VERSION,
		textHash,
		name: card.name,
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

function effectOf(ab: AbilityDef | undefined): CompiledEffect | null {
	if (!ab) return null;
	if (ab.kind === 'spell') return { steps: ab.effect, targets: ab.targets, modal: ab.modal, unparsed: [] };
	if (ab.kind === 'activated' || ab.kind === 'triggered') return { steps: ab.effect, targets: ab.targets, unparsed: [] };
	if (ab.kind === 'keyword' && ab.keyword.name === 'equip') return equipEffect(ab);
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

/** The abilities of the card's (first) face. */
export function cardAbilities(card: ScryfallCard): AbilityDef[] {
	return compileCard(card).faces[0]?.abilities ?? [];
}

/** An ability of the card by its id (`act_3`, `loyalty_1`, `equip_2`, `mana_tap`; see ActivatedAbility.id). */
export function abilityById(card: ScryfallCard, id: string): AbilityDef | undefined {
	return cardAbilities(card).find(
		(a) => (a.kind === 'activated' || a.kind === 'unsupported' || a.kind === 'keyword') && a.id === id
	);
}

/** The compiled spell ability of an instant or sorcery, or null when it isn't automated. */
export function compileSpellEffects(card: ScryfallCard): CompiledEffect | null {
	if (card.backFace || card.oracleText.includes('\n//\n')) return null;
	return effectOf(cardAbilities(card).find((a) => a.kind === 'spell'));
}

/**
 * The compiled effect of a card's triggered ability, by the ability's index in
 * compileCard(card).faces[0].abilities (StackItem.triggeredAbilityIndex). Null when the ability
 * isn't automated (its effect is `unsupported`) or isn't a trigger the runtime runs itself (Ward).
 */
export function compiledTriggerEffect(card: ScryfallCard, abilityIndex: number): CompiledEffect | null {
	const t = runtimeTriggers(compileCard(card)).find((x) => x.abilityIndex === abilityIndex);
	return t?.effect ?? null;
}

function shiftRef(ref: Ref, offset: number): Ref {
	return ref.k === 'target' ? { k: 'target', index: ref.index + offset } : ref;
}

function shiftPlayerRef(ref: PlayerRef, offset: number): PlayerRef {
	if (ref.k === 'target') return { k: 'target', index: ref.index + offset };
	if (ref.k === 'controllerOf' || ref.k === 'ownerOf') return { k: ref.k, of: shiftRef(ref.of, offset) };
	return ref;
}

function shiftSelector(sel: Selector, offset: number): Selector {
	if (sel.k === 'target') return { k: 'target', index: sel.index + offset };
	if (sel.k === 'playerRef') return { k: 'playerRef', ref: shiftPlayerRef(sel.ref, offset) };
	return sel;
}

function shiftAmount(a: Amount, offset: number): Amount {
	if (a.k === 'stat') return { ...a, of: shiftRef(a.of, offset) };
	if (a.k === 'life' || a.k === 'cardsIn') return { ...a, of: shiftPlayerRef(a.of, offset) };
	if (a.k === 'negate') return { k: 'negate', of: shiftAmount(a.of, offset) };
	if (a.k === 'sum' || a.k === 'min' || a.k === 'max') return { k: a.k, args: a.args.map((x) => shiftAmount(x, offset)) };
	return a;
}

function shiftStepTargets(step: EffectStep, offset: number): EffectStep {
	if (offset === 0) return step;
	return {
		...step,
		subject: shiftSelector(step.subject, offset),
		...(step.actor ? { actor: shiftPlayerRef(step.actor, offset) } : {}),
		...(step.optional ? { optional: { chooser: shiftPlayerRef(step.optional.chooser, offset) } } : {}),
		...(step.amount ? { amount: shiftAmount(step.amount, offset) } : {})
	};
}

/**
 * The compiled effect of a resolving spell or activated ability, or null when it isn't automated.
 * Activated abilities are found by `StackItem.abilityId`. Items without one (built by hand in older
 * tests) fall back to compiling the item's effect text.
 */
export function compiledStackItemEffects(item: StackItem): CompiledEffect | null {
	if (item.kind === 'spell') {
		if (!/\b(?:Instant|Sorcery)\b/.test(item.card.typeLine)) return null;
		const spell = compileSpellEffects(item.card);
		if (spell?.modal && item.chosenModes) {
			const steps: EffectStep[] = [];
			const targets: TargetSpec[] = [];
			for (const idx of item.chosenModes) {
				const mode = spell.modal.modes[idx];
				if (!mode) return null;
				const offset = targets.length;
				targets.push(...mode.targets);
				steps.push(...mode.effect.map((s) => shiftStepTargets(s, offset)));
			}
			return { steps, targets, modal: spell.modal, unparsed: [] };
		}
		return spell;
	}
	if (item.kind !== 'activated') return null;
	if (item.abilityId) return effectOf(abilityById(item.card, item.abilityId));
	const parse = parseAbilityEffectText(item.card.name, item.oracleText ?? '');
	return parse.unparsed.length > 0 ? null : { steps: parse.steps, targets: parse.targets, unparsed: [] };
}

/** The `addMana` steps of a card's mana abilities (CR 106.7 "a land an opponent controls could produce"). */
export function cardManaSteps(card: ScryfallCard): EffectStep[] {
	return cardAbilities(card).flatMap((a) =>
		(a.kind === 'activated' || a.kind === 'unsupported') && a.isMana && a.effect
			? a.effect.filter((s) => s.verb === 'addMana')
			: []
	);
}

export { normalizeFace } from './normalize.ts';
