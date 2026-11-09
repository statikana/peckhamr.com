/**
 * Unsupported-ability reports (ENGINE_ARCHITECTURE_PLAN.md section 2.7, roadmap step E1).
 *
 * Says which of a card's abilities the engine won't automate, for the deck-builder warning, the
 * in-game inspector marker and the `allowUnsupportedCards` lobby rule. It counts exactly what
 * `scripts/magic-coverage.ts` counts (that script uses it), so the numbers match COVERAGE.md.
 *
 * Lives in the compiler because the report carries ability text, which only the compiler and the
 * UI (for display) may read.
 */
import type { CardDefinition, Span, UnsupportedReason } from '../ir.ts';
import type { DeckCardEntry, LobbyRulesConfig, MagicDeck, ScryfallCard } from '../types.ts';
import { compileCard } from './index.ts';

export interface UnsupportedAbilityReport {
	/** Name of the face the ability is on. */
	face: string;
	/** The whole ability's normalised text (self-references appear as `~`). */
	text: string;
	reason: UnsupportedReason;
	/** Offsets into the face's normalised text. */
	span: Span;
	/**
	 * The parts of `text` the compiler didn't understand, when narrower than the whole ability.
	 * Empty when the whole ability is the gap (a keyword, a static, a multiface layout).
	 */
	unparsed: string[];
}

export interface CardSupportReport {
	/** Same value as `CardDefinition.fullySupported`. */
	fullySupported: boolean;
	unsupported: UnsupportedAbilityReport[];
}

/** Keyed by the cached CardDefinition, so it follows compileCard's cache key and is dropped with it. */
const REPORTS = new WeakMap<CardDefinition, CardSupportReport>();

/** Report for an already-compiled definition. */
export function definitionSupportReport(def: CardDefinition): CardSupportReport {
	const cached = REPORTS.get(def);
	if (cached) return cached;
	const unsupported: UnsupportedAbilityReport[] = [];
	for (const face of def.faces) {
		for (const ab of face.abilities) {
			if (ab.kind !== 'unsupported') continue;
			unsupported.push({
				face: face.name,
				text: ab.text,
				reason: ab.reason,
				span: ab.span,
				unparsed: ab.unparsed
					.map((u) => ab.text.slice(u.start - ab.span.start, u.end - ab.span.start).trim())
					.filter((t) => t.length > 0 && t !== ab.text.trim())
			});
		}
	}
	const report: CardSupportReport = { fullySupported: def.fullySupported, unsupported };
	REPORTS.set(def, report);
	return report;
}

/** Which of the card's abilities the engine won't automate. Never throws; a compiler error counts
 * as one unsupported ability covering the whole card. */
export function cardSupportReport(card: ScryfallCard): CardSupportReport {
	try {
		return definitionSupportReport(compileCard(card));
	} catch {
		return {
			fullySupported: false,
			unsupported: [{ face: card.name, text: '', reason: 'unparsed', span: { start: 0, end: 0 }, unparsed: [] }]
		};
	}
}

/** Ability text for display: `~` (CARDNAME) shown as the face's name. */
export function displayAbilityText(text: string, faceName: string): string {
	return text.replace(/~/g, faceName);
}

export interface DeckUnsupportedCard {
	card: ScryfallCard;
	isCommander: boolean;
	report: CardSupportReport;
}

/** The deck's distinct cards (commanders first) that have at least one unsupported ability. */
export function deckUnsupportedCards(
	commanders: ScryfallCard[],
	cards: DeckCardEntry[]
): DeckUnsupportedCard[] {
	const out: DeckUnsupportedCard[] = [];
	const seen = new Set<string>();
	const visit = (card: ScryfallCard, isCommander: boolean) => {
		const key = card.oracleId ?? card.id ?? card.name;
		if (seen.has(key)) return;
		seen.add(key);
		const report = cardSupportReport(card);
		if (!report.fullySupported) out.push({ card, isCommander, report });
	};
	for (const c of commanders) visit(c, true);
	for (const e of cards) visit(e.card, false);
	return out;
}

/** Most card names listed per seat in the start-refused message. */
const MAX_NAMES_PER_SEAT = 10;

/**
 * Lobby rule `allowUnsupportedCards`: the reason the game can't start, or null if it can. Lobbies
 * saved before the rule existed have no value, which means allowed. Bot seats follow the same rule.
 */
export function unsupportedCardsStartError(
	rules: Pick<LobbyRulesConfig, 'allowUnsupportedCards'>,
	seats: Array<{ username: string; deck: Pick<MagicDeck, 'name' | 'commanders' | 'cards'> }>
): string | null {
	if (rules.allowUnsupportedCards !== false) return null;
	const problems: string[] = [];
	for (const { username, deck } of seats) {
		const bad = deckUnsupportedCards(deck.commanders, deck.cards);
		if (bad.length === 0) continue;
		const names = bad.slice(0, MAX_NAMES_PER_SEAT).map((b) => b.card.name);
		const more = bad.length - names.length;
		problems.push(
			`${username}'s deck "${deck.name}" has ${bad.length} card${bad.length === 1 ? '' : 's'} with abilities that won't be automated: ` +
				`${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
		);
	}
	if (problems.length === 0) return null;
	return `This lobby doesn't allow cards with unsupported abilities. ${problems.join(' ')} Switch decks or allow unsupported cards in the lobby rules.`;
}
