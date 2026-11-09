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
import type { DeckCardEntry, LobbyRulesConfig, MagicDeck, ScryfallCard, StackItem } from '../types.ts';
import { compileCard } from './index.ts';

/**
 * Step E2: what kind of ability isn't automated, which decides what the runtime does with it
 * (plan section 2.7):
 * - `spell`, `activated`, `triggered` (trigger head understood): it goes on the stack as usual and
 *   its controller resolves it manually (guided resolution).
 * - `triggerUnrecognised`: the trigger head isn't understood (or names an event the engine doesn't
 *   emit), so the engine can't tell when it triggers. Logged when the permanent enters; players
 *   apply it by hand ("Resolve manually" in the inspector).
 * - `static` (statics and replacement effects) and `keyword`: not enforced. Logged when the
 *   permanent enters.
 * - `mana`: a mana ability (it doesn't use the stack); the engine's approximation is used.
 * - `multiface`: a layout the engine doesn't support.
 */
export type UnsupportedAbilityKind = 'spell' | 'activated' | 'mana' | 'triggered' | 'triggerUnrecognised' | 'static' | 'keyword' | 'multiface';

export interface UnsupportedAbilityReport {
	/** Name of the face the ability is on. */
	face: string;
	kind: UnsupportedAbilityKind;
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
		const isSpell = face.characteristics.types.some((t) => t === 'Instant' || t === 'Sorcery');
		for (const ab of face.abilities) {
			if (ab.kind !== 'unsupported') continue;
			unsupported.push({
				face: face.name,
				kind: unsupportedKind(ab, isSpell),
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

const TRIGGER_WORD = /^(?:when|whenever|at)\b/i;
const MANA_EFFECT = /:\s*add\b/i;
/** "{T}: ...", "{2}{G}, Sacrifice ~: ...", "+1: ...": a cost, a colon, then an effect. */
const ACTIVATED_LINE = /^[^"“:]*?(?:\{[^}]+\}|[+−-]\d+|\b(?:tap|untap|sacrifice|discard|exile|pay|remove)\b)[^"“:]*:\s*\S/i;

function unsupportedKind(ab: Extract<CardDefinition['faces'][number]['abilities'][number], { kind: 'unsupported' }>, isSpell: boolean): UnsupportedAbilityKind {
	switch (ab.reason) {
		case 'static_not_compiled':
			return 'static';
		case 'keyword_not_implemented':
			return 'keyword';
		case 'multiface':
			return 'multiface';
		case 'event_not_implemented':
			return 'triggerUnrecognised';
	}
	const text = ab.text.trim();
	if (ab.trigger) return 'triggered';
	if (TRIGGER_WORD.test(text)) return 'triggerUnrecognised';
	if (isSpell && (ab.legacyId === undefined || ab.legacyId.startsWith('cast_'))) return 'spell';
	if (ab.legacyId !== undefined || ab.cost !== undefined || ACTIVATED_LINE.test(text)) {
		return MANA_EFFECT.test(text) ? 'mana' : 'activated';
	}
	if (isSpell) return 'spell';
	return 'static';
}

/** Inspector / log wording for an unsupported ability of this kind. */
export function unsupportedKindLabel(kind: UnsupportedAbilityKind): string {
	switch (kind) {
		case 'spell':
		case 'activated':
		case 'triggered':
			return 'Not automated: resolved manually';
		case 'triggerUnrecognised':
			return 'Not automated: apply it manually when it triggers';
		case 'static':
		case 'keyword':
			return 'Not enforced';
		case 'mana':
			return 'Not fully automated: the engine approximates this mana ability';
		case 'multiface':
			return 'Not automated: this card layout isn\'t supported';
	}
}

/**
 * Step E2: the abilities to mention when a permanent enters the battlefield (the engine can't act on
 * them itself): statics, replacements and keywords that aren't enforced, and triggered abilities whose
 * trigger isn't understood. Display text only (`~` shown as the face name).
 */
export function enteringNotices(card: ScryfallCard): Array<{ kind: UnsupportedAbilityKind; text: string }> {
	const report = cardSupportReport(card);
	const first = report.unsupported[0]?.face;
	return report.unsupported
		.filter((u) => u.face === first && u.text.trim().length > 0 && (u.kind === 'static' || u.kind === 'keyword' || u.kind === 'triggerUnrecognised'))
		.map((u) => ({ kind: u.kind, text: displayAbilityText(u.text, u.face) }));
}

/** The rules text a stack item shows (display only: prompts, logs). */
export function stackItemDisplayText(item: Pick<StackItem, 'card' | 'oracleText'>): string {
	return item.oracleText || item.card.oracleText || '';
}

/**
 * The text of one of a card's unsupported abilities (index into `cardSupportReport(card).unsupported`),
 * or the whole card's text without an index. Display only (the "Resolve manually" escape hatch).
 */
export function cardAbilityDisplayText(card: ScryfallCard, unsupportedIndex?: number): string {
	if (unsupportedIndex !== undefined) {
		const u = cardSupportReport(card).unsupported[unsupportedIndex];
		if (u) return displayAbilityText(u.text, u.face);
	}
	return card.oracleText || '';
}

/** Which of the card's abilities the engine won't automate. Never throws; a compiler error counts
 * as one unsupported ability covering the whole card. */
export function cardSupportReport(card: ScryfallCard): CardSupportReport {
	try {
		return definitionSupportReport(compileCard(card));
	} catch {
		return {
			fullySupported: false,
			unsupported: [{ face: card.name, kind: 'static', text: '', reason: 'unparsed', span: { start: 0, end: 0 }, unparsed: [] }]
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
	commanders: ScryfallCard[] | undefined,
	cards: DeckCardEntry[] | undefined
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
	for (const c of commanders ?? []) visit(c, true);
	for (const e of cards ?? []) visit(e.card, false);
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
