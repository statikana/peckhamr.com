/**
 * Card compiler entry point (ENGINE_ARCHITECTURE_PLAN.md section 2.2).
 *
 * compileCard turns a card into a CardDefinition. Results are cached in memory per isolate, keyed
 * by oracle id + text hash + COMPILER_VERSION; nothing is persisted (section 2.6). The IR must never
 * be stored in GameState.
 */
import type { ScryfallCard, StackItem } from '../types.ts';
import type { CardDefinition } from '../ir.ts';
import { adaptCard } from './adapter.ts';
import { compiledStackItemEffects, type EffectParse } from './effects.ts';
import { hashText } from './normalize.ts';
import { runtimeTriggers } from './triggers.ts';

/** Bump whenever the IR produced for the same text could change. */
export const COMPILER_VERSION = 3;

const CACHE = new Map<string, CardDefinition>();

export function clearCompileCache(): void {
	CACHE.clear();
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
	const oracleId = card.oracleId ?? card.id;
	const textHash = hashText(sourceText(card));
	const key = `${oracleId}:${textHash}:${COMPILER_VERSION}`;
	const cached = CACHE.get(key);
	if (cached) return cached;

	const faces = adaptCard(card);
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

export function compileSpellEffects(card: ScryfallCard): EffectParse | null {
	return compiledStackItemEffects({ kind: 'spell', card } as StackItem);
}

/**
 * The compiled effect of a card's triggered ability (steps + target specs), by the ability's index in
 * compileCard(card).faces[0].abilities (StackItem.triggeredAbilityIndex). Null if the effect grammar
 * didn't produce one (Ward, or an ability the adapter never compiled). Cached with the
 * CardDefinition, so the runtime never reads rules text.
 */
export function compiledTriggerEffect(card: ScryfallCard, abilityIndex: number): EffectParse | null {
	return runtimeTriggers(compileCard(card)).find((t) => t.abilityIndex === abilityIndex)?.effect ?? null;
}

export { normalizeFace } from './normalize.ts';
