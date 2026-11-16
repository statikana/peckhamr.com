import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from './index.ts';
import { cardSupportReport, deckUnsupportedCards } from './support.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { validateCommanderDeck } from '../scryfall.ts';

/**
 * Precon Assurance Ratchet:
 * Every card in `STAPLE_CARDS` and every deck in `PRECON_DECKS` (including decks imported via
 * `scripts/magic-add-archidekt-precon.ts` into `src/lib/magic/precons.archidekt.json`) MUST stay
 * 100% compiler- and runtime-supported (`fullySupported === true`) and Commander-legal.
 */
describe('Precon assurance ratchet (100% support & Commander legality)', () => {
	it('compiles 100% of STAPLE_CARDS with zero unsupported abilities', () => {
		const failures: string[] = [];
		for (const card of Object.values(STAPLE_CARDS).sort((a, b) => a.name.localeCompare(b.name))) {
			const def = compileCard(card);
			const report = cardSupportReport(card);
			if (!def.fullySupported || !report.fullySupported || report.unsupported.length > 0) {
				const details = report.unsupported
					.map(
						(u) =>
							`[${u.reason}] ${u.face}: ${u.text}${u.unparsed.length > 0 ? ` (unparsed: ${u.unparsed.join(' | ')})` : ''}`
					)
					.join('; ');
				failures.push(`${card.name} -> ${details || 'fullySupported=false'}`);
			}
		}
		assert.deepEqual(failures, []);
	});

	for (const deck of PRECON_DECKS) {
		it(`assures deck "${deck.name}" (${deck.id}) is Commander-legal and 100% supported`, () => {
			const legality = validateCommanderDeck(deck.commanders, deck.cards, deck.companion);
			assert.equal(
				legality.isLegal,
				true,
				`${deck.id} failed Commander legality: ${legality.errors.join('; ')}`
			);

			const unsupported = deckUnsupportedCards(deck.commanders, deck.cards);
			if (deck.companion) {
				const compReport = cardSupportReport(deck.companion);
				assert.equal(
					compReport.fullySupported,
					true,
					`${deck.id} companion "${deck.companion.name}" has unsupported abilities: ${JSON.stringify(compReport.unsupported)}`
				);
			}
			assert.deepEqual(
				unsupported.map((u) => ({
					card: u.card.name,
					reasons: u.report.unsupported.map((g) => `${g.reason}: ${g.text}`)
				})),
				[]
			);
		});
	}
});
