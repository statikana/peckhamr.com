import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileCard } from './index.ts';
import {
	cardSupportReport,
	deckUnsupportedCards,
	displayAbilityText,
	unsupportedCardsStartError
} from './support.ts';
import { PRECON_DECKS, STAPLE_CARDS } from '../precons.ts';
import { validateCommanderDeck } from '../scryfall.ts';
import { DEFAULT_LOBBY_RULES, type DeckCardEntry, type ScryfallCard } from '../types.ts';

/** Plan section 2.7, roadmap step E1: unsupported-ability warnings and the lobby rule. */

function synthetic(overrides: Partial<ScryfallCard> & { name: string }): ScryfallCard {
	return {
		id: `synthetic_${overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		manaCost: '{1}{G}',
		cmc: 2,
		typeLine: 'Creature — Elf',
		oracleText: '',
		colors: ['G'],
		colorIdentity: ['G'],
		keywords: [],
		imageUrl: '',
		artCropUrl: '',
		legalCommander: true,
		canBeCommander: false,
		hasPartner: false,
		hasChooseBackground: false,
		isBackground: false,
		...overrides
	};
}

// Invented names, so nothing can depend on a real card.
const SUPPORTED = synthetic({
	name: 'Glimmerfen Grazer',
	oracleText: 'Trample\nWhen Glimmerfen Grazer enters, draw a card.'
});
const UNSUPPORTED_STATIC = synthetic({
	name: 'Hushwater Sentinel',
	oracleText: "Players can't gain life during your turn."
});
const SADDLED_TRIGGER = synthetic({
	name: 'Dunetrot Charger',
	typeLine: 'Creature — Horse Mount',
	oracleText: 'Whenever Dunetrot Charger attacks while saddled, draw a card.'
});
const PARTLY_PARSED_SPELL = synthetic({
	name: 'Quillbright Surge',
	typeLine: 'Instant',
	oracleText:
		'Target creature gets +2/+2 until end of turn. If you control a Wizard, scry 2 for each opponent who wobbles.'
});
const COMMANDER = synthetic({
	name: 'Velloran, Grove Warden',
	typeLine: 'Legendary Creature — Elf Druid',
	canBeCommander: true,
	oracleText: 'Vigilance'
});

function forest(): ScryfallCard {
	const card = STAPLE_CARDS['forest'];
	assert.ok(card, 'precons.ts has a Forest');
	return card;
}

/** Commander + 98 Forests + the given card: exactly 100 cards. */
function deckWith(card: ScryfallCard): { commanders: ScryfallCard[]; cards: DeckCardEntry[] } {
	return {
		commanders: [COMMANDER],
		cards: [
			{ quantity: 98, card: forest() },
			{ quantity: 1, card }
		]
	};
}

describe('cardSupportReport', () => {
	it('reports a fully supported card as such', () => {
		const report = cardSupportReport(SUPPORTED);
		assert.equal(report.fullySupported, true);
		assert.deepEqual(report.unsupported, []);
	});

	it('reports an uncompiled static ability as one whole-ability gap', () => {
		const report = cardSupportReport(UNSUPPORTED_STATIC);
		assert.equal(report.fullySupported, false);
		assert.equal(report.unsupported.length, 1);
		const [u] = report.unsupported;
		assert.equal(u.reason, 'static_not_compiled');
		assert.equal(u.text, "Players can't gain life during your turn.");
		assert.equal(u.face, 'Hushwater Sentinel');
		assert.deepEqual(u.unparsed, [], 'the whole ability is the gap, so no narrower fragment');
	});

	it('reports a trigger with an unrepresentable qualifier ("while saddled")', () => {
		const report = cardSupportReport(SADDLED_TRIGGER);
		assert.equal(report.fullySupported, false);
		assert.equal(report.unsupported.length, 1);
		const [u] = report.unsupported;
		assert.notEqual(u.reason, 'static_not_compiled');
		assert.match(u.text, /^Whenever ~ attacks while saddled, draw a card\.$/);
		assert.ok(u.unparsed.length >= 1, 'the trigger head is the unparsed part');
		assert.ok(u.unparsed.every((t) => u.text.includes(t)));
		assert.equal(
			displayAbilityText(u.text, u.face),
			'Whenever Dunetrot Charger attacks while saddled, draw a card.'
		);
	});

	it('reports a partly parsed spell, with only the part the compiler missed as unparsed', () => {
		const report = cardSupportReport(PARTLY_PARSED_SPELL);
		assert.equal(report.fullySupported, false);
		assert.equal(report.unsupported.length, 1);
		const [u] = report.unsupported;
		assert.equal(u.reason, 'unparsed');
		assert.equal(u.text, PARTLY_PARSED_SPELL.oracleText);
		assert.ok(u.unparsed.length >= 1);
		for (const fragment of u.unparsed) {
			assert.ok(u.text.includes(fragment));
			assert.ok(fragment.length < u.text.length, 'narrower than the whole ability');
		}
		assert.deepEqual(u.span, { start: 0, end: u.text.length });
	});

	it('is cached with the compiled definition', () => {
		assert.equal(cardSupportReport(UNSUPPORTED_STATIC), cardSupportReport({ ...UNSUPPORTED_STATIC }));
	});

	it('agrees with compileCard (and so with COVERAGE.md) for every precon card', () => {
		for (const deck of PRECON_DECKS) {
			for (const card of [...deck.commanders, ...deck.cards.map((e) => e.card)]) {
				const def = compileCard(card);
				const report = cardSupportReport(card);
				assert.equal(report.fullySupported, def.fullySupported, card.name);
				const count = def.faces.flatMap((f) => f.abilities).filter((a) => a.kind === 'unsupported').length;
				assert.equal(report.unsupported.length, count, card.name);
				assert.equal(report.fullySupported, count === 0, card.name);
			}
		}
	});
});

describe('deck validation keeps unsupported cards legal', () => {
	it('a deck with an unsupported card is Commander-legal; the warning is separate', () => {
		for (const card of [UNSUPPORTED_STATIC, SADDLED_TRIGGER, PARTLY_PARSED_SPELL]) {
			const { commanders, cards } = deckWith(card);
			const validation = validateCommanderDeck(commanders, cards);
			assert.equal(validation.isLegal, true, card.name);
			assert.deepEqual(validation.errors, [], card.name);

			const warnings = deckUnsupportedCards(commanders, cards);
			assert.deepEqual(
				warnings.map((w) => w.card.name),
				[card.name]
			);
			assert.equal(warnings[0].isCommander, false);
		}
	});

	it('flags nothing for a fully supported deck', () => {
		const { commanders, cards } = deckWith(SUPPORTED);
		assert.deepEqual(deckUnsupportedCards(commanders, cards), []);
	});

	it('lists an unsupported commander first, once', () => {
		const cmd = { ...UNSUPPORTED_STATIC, typeLine: 'Legendary Creature — Elf', canBeCommander: true };
		const warnings = deckUnsupportedCards([cmd], [
			{ quantity: 1, card: PARTLY_PARSED_SPELL },
			{ quantity: 1, card: { ...PARTLY_PARSED_SPELL } }
		]);
		assert.deepEqual(
			warnings.map((w) => [w.card.name, w.isCommander]),
			[
				['Hushwater Sentinel', true],
				['Quillbright Surge', false]
			]
		);
	});
});

describe('lobby rule allowUnsupportedCards', () => {
	const unsupportedDeck = { name: 'Odd Ones', ...deckWith(SADDLED_TRIGGER) };
	const supportedDeck = { name: 'Plain Grove', ...deckWith(SUPPORTED) };

	it('defaults to allowed', () => {
		assert.equal(DEFAULT_LOBBY_RULES.allowUnsupportedCards, true);
		assert.equal(
			unsupportedCardsStartError(DEFAULT_LOBBY_RULES, [{ username: 'Ada', deck: unsupportedDeck }]),
			null
		);
	});

	it('treats a lobby saved before the rule existed as allowed', () => {
		assert.equal(unsupportedCardsStartError({}, [{ username: 'Ada', deck: unsupportedDeck }]), null);
	});

	it('refuses to start when false and a deck has an unsupported card, naming seat, deck and card', () => {
		const error = unsupportedCardsStartError({ allowUnsupportedCards: false }, [
			{ username: 'Ada', deck: supportedDeck },
			{ username: 'Bram', deck: unsupportedDeck }
		]);
		assert.ok(error);
		assert.match(error, /Bram's deck "Odd Ones"/);
		assert.match(error, /Dunetrot Charger/);
		assert.doesNotMatch(error, /Ada/);
	});

	it('allows the start when false but every deck is fully supported', () => {
		assert.equal(
			unsupportedCardsStartError({ allowUnsupportedCards: false }, [
				{ username: 'Ada', deck: supportedDeck },
				{ username: 'Bram', deck: supportedDeck }
			]),
			null
		);
	});

	it('applies to precon decks (what bots play) too', () => {
		for (const deck of PRECON_DECKS) {
			const bad = deckUnsupportedCards(deck.commanders, deck.cards);
			const error = unsupportedCardsStartError({ allowUnsupportedCards: false }, [{ username: 'Bot', deck }]);
			assert.equal(error === null, bad.length === 0, deck.name);
			if (!error) continue;
			assert.ok(error.includes(`Bot's deck "${deck.name}"`), deck.name);
			for (const b of bad.slice(0, 10)) assert.ok(error.includes(b.card.name), b.card.name);
			if (bad.length > 10) assert.ok(error.includes(`and ${bad.length - 10} more`), deck.name);
		}
	});
});
