import type { RequestHandler } from '@sveltejs/kit';
import {
	CORS_HEADERS,
	deleteUserDeck,
	ensureMagicSchema,
	getAuthenticatedUser,
	getD1,
	getDeckById,
	jsonResponse,
	listUserDecks,
	saveUserDeck
} from '../../../../lib/magic/db';
import { resolveScryfallImageLinks } from '../../../../lib/magic/cardImages';
import { PRECON_DECKS } from '../../../../lib/magic/precons';
import {
	parseDecklistText,
	resolveCardsFromScryfall,
	searchScryfallCards,
	validateCommanderDeck
} from '../../../../lib/magic/scryfall';
import type { DeckCardEntry, MagicDeck, ScryfallCard } from '../../../../lib/magic/types';

export const trailingSlash = 'ignore';

async function getEditableDeckForUser(
	platform: App.Platform | undefined,
	userId: string,
	deckId: string
): Promise<MagicDeck | null> {
	const existing = await getDeckById(platform, deckId);
	if (existing && existing.userId === userId && !existing.isPrecon) {
		return {
			...existing,
			commanders: [...existing.commanders],
			cards: existing.cards.map((c) => ({ quantity: c.quantity, card: c.card }))
		};
	}

	return null;
}

async function revalidateAndSaveDeck(
	platform: App.Platform | undefined,
	deck: MagicDeck,
	now: number
): Promise<MagicDeck> {
	const validation = validateCommanderDeck(deck.commanders, deck.cards);
	deck.colorIdentity = validation.colorIdentity;
	deck.cardCount = validation.totalCards;
	deck.isLegal = validation.isLegal;
	deck.validationErrors = validation.errors;
	deck.updatedAt = now;
	await saveUserDeck(platform, deck);
	return deck;
}

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async ({ request, platform }) => {
	const user = await getAuthenticatedUser(request, platform);
	const userDecks = user ? await listUserDecks(platform, user.id) : [];
	// Precons (and staple cards in imported decks) carry Scryfall API image links; serve CDN links.
	const db = getD1(platform);
	await ensureMagicSchema(db);
	await resolveScryfallImageLinks(db, { userDecks, PRECON_DECKS });

	return jsonResponse({
		ok: true,
		decks: userDecks,
		precons: PRECON_DECKS
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const user = await getAuthenticatedUser(request, platform);
	if (!user) {
		return jsonResponse({ ok: false, error: 'Authentication required to manage decks.' }, 401);
	}

	const body = (await request.json()) as Record<string, any>;
	const action = String(body.action || '');
	const now = Date.now();

	if (action === 'clone_precon') {
		const preconId = String(body.preconId || '');
		const precon = PRECON_DECKS.find((p) => p.id === preconId);
		if (!precon) {
			return jsonResponse({ ok: false, error: 'Precon deck not found.' }, 404);
		}

		const cloned: MagicDeck = {
			...precon,
			id: `deck_${now}_${Math.random().toString(36).slice(2, 8)}`,
			userId: user.id,
			name: String(body.customName || precon.name),
			isPrecon: false,
			createdAt: now,
			updatedAt: now
		};

		await saveUserDeck(platform, cloned);
		const decks = await listUserDecks(platform, user.id);
		return jsonResponse({ ok: true, deck: cloned, decks });
	}

	if (action === 'delete') {
		const deckId = String(body.deckId || '');
		await deleteUserDeck(platform, deckId, user.id);
		const decks = await listUserDecks(platform, user.id);
		return jsonResponse({ ok: true, decks });
	}

	if (action === 'update_card') {
		const deckId = String(body.deckId || '');
		const cardName = String(body.cardName || '').trim();
		const operation = String(body.operation || 'set_qty');
		const fromCommander = Boolean(body.fromCommander);
		const rawQty = Number(body.quantity ?? 1);

		const deck = await getEditableDeckForUser(platform, user.id, deckId);
		if (!deck) {
			return jsonResponse(
				{
					ok: false,
					error: PRECON_DECKS.some((p) => p.id === deckId)
						? 'Default reference decks cannot be edited directly. Copy this deck to your saved decks first.'
						: 'Deck not found.'
				},
				403
			);
		}
		if (!cardName) {
			return jsonResponse({ ok: false, error: 'Card name is required.' }, 400);
		}

		const targetLow = cardName.toLowerCase();

		if (operation === 'remove' || (operation === 'set_qty' && rawQty <= 0)) {
			if (fromCommander) {
				deck.commanders = deck.commanders.filter((c) => c.name.toLowerCase() !== targetLow);
			} else {
				deck.cards = deck.cards.filter((e) => e.card.name.toLowerCase() !== targetLow);
			}
		} else if (operation === 'set_qty') {
			const clampedQty = Math.min(99, Math.max(1, Math.floor(rawQty)));
			const entry = deck.cards.find((e) => e.card.name.toLowerCase() === targetLow);
			if (entry) {
				entry.quantity = clampedQty;
			}
		} else if (operation === 'promote_commander') {
			const idx = deck.cards.findIndex((e) => e.card.name.toLowerCase() === targetLow);
			if (idx >= 0) {
				const entry = deck.cards[idx];
				if (!deck.commanders.some((c) => c.name.toLowerCase() === targetLow)) {
					deck.commanders.push(entry.card);
				}
				if (entry.quantity > 1) {
					entry.quantity -= 1;
				} else {
					deck.cards.splice(idx, 1);
				}
			}
		} else if (operation === 'demote_commander') {
			const cmdIdx = deck.commanders.findIndex((c) => c.name.toLowerCase() === targetLow);
			if (cmdIdx >= 0) {
				const [removedCmd] = deck.commanders.splice(cmdIdx, 1);
				const existingMain = deck.cards.find((e) => e.card.name.toLowerCase() === targetLow);
				if (existingMain) {
					existingMain.quantity = Math.min(99, existingMain.quantity + 1);
				} else {
					deck.cards.unshift({ quantity: 1, card: removedCmd });
				}
			}
		}

		await revalidateAndSaveDeck(platform, deck, now);
		const decks = await listUserDecks(platform, user.id);
		return jsonResponse({ ok: true, deck, decks });
	}

	if (action === 'add_card') {
		const deckId = String(body.deckId || '');
		const providedCard = body.card as ScryfallCard | undefined;
		const rawCardInput = String(body.cardName || providedCard?.name || '').trim();
		const quantity = Math.min(99, Math.max(1, Math.floor(Number(body.quantity) || 1)));
		const asCommander = Boolean(body.asCommander);

		if (!providedCard && !rawCardInput) {
			return jsonResponse({ ok: false, error: 'Please select a card from the dropdown list.' }, 400);
		}

		const deck = await getEditableDeckForUser(platform, user.id, deckId);
		if (!deck) {
			return jsonResponse(
				{
					ok: false,
					error: PRECON_DECKS.some((p) => p.id === deckId)
						? 'Default reference decks cannot be edited directly. Copy this deck to your saved decks first.'
						: 'Deck not found.'
				},
				403
			);
		}

		let resolvedCard: ScryfallCard | null =
			providedCard && providedCard.name && providedCard.typeLine !== undefined
				? providedCard
				: null;

		if (!resolvedCard) {
			let cardName = rawCardInput;
			if (cardName.includes('//')) {
				cardName = cardName.split('//')[0].trim();
			}
			const { resolved } = await resolveCardsFromScryfall([cardName]);
			resolvedCard =
				resolved.get(cardName.toLowerCase()) || Array.from(resolved.values())[0] || null;
		}

		if (!resolvedCard) {
			return jsonResponse(
				{ ok: false, error: `Could not find "${rawCardInput}" on Scryfall.` },
				400
			);
		}

		const resLow = resolvedCard.name.toLowerCase();
		if (asCommander) {
			if (!deck.commanders.some((c) => c.name.toLowerCase() === resLow)) {
				deck.commanders.push(resolvedCard);
			}
		} else {
			const existingEntry = deck.cards.find((e) => e.card.name.toLowerCase() === resLow);
			if (existingEntry) {
				existingEntry.quantity = Math.min(99, existingEntry.quantity + quantity);
			} else {
				deck.cards.unshift({ quantity, card: resolvedCard });
			}
		}

		await revalidateAndSaveDeck(platform, deck, now);
		const decks = await listUserDecks(platform, user.id);
		return jsonResponse({
			ok: true,
			deck,
			decks,
			addedCard: resolvedCard,
			addedQuantity: asCommander ? 1 : quantity
		});
	}

	if (action === 'search_scryfall') {
		const query = String(body.query || '').trim();
		if (query.length < 2) {
			return jsonResponse({ ok: true, results: [] });
		}
		const results = await searchScryfallCards(query, 14);
		return jsonResponse({ ok: true, results });
	}

	if (action === 'import') {
		const name = String(body.name || 'Imported Commander Deck').trim().slice(0, 64);
		const description = String(body.description || '').trim().slice(0, 300);
		const explicitCommander = String(body.commanderName || '').trim();
		const rawDecklist = String(body.decklist || '');

		if (!rawDecklist.trim()) {
			return jsonResponse({ ok: false, error: 'Please paste a decklist to import.' }, 400);
		}

		const parsed = parseDecklistText(rawDecklist);
		if (explicitCommander && parsed.commanderLines.length === 0) {
			// Check if explicitCommander is in mainboardLines and promote it
			const mainIdx = parsed.mainboardLines.findIndex(
				(l) => l.name.toLowerCase() === explicitCommander.toLowerCase()
			);
			if (mainIdx >= 0) {
				const line = parsed.mainboardLines[mainIdx];
				if (line.quantity > 1) {
					line.quantity -= 1;
				} else {
					parsed.mainboardLines.splice(mainIdx, 1);
				}
			}
			parsed.commanderLines.push({
				quantity: 1,
				name: explicitCommander,
				isCommander: true
			});
		}

		const allNames = [
			...parsed.commanderLines.map((l) => l.name),
			...parsed.mainboardLines.map((l) => l.name)
		];

		const { resolved, notFound } = await resolveCardsFromScryfall(allNames);
		if (notFound.length > 0 && resolved.size === 0) {
			return jsonResponse(
				{
					ok: false,
					error: `Could not resolve cards from Scryfall: ${notFound.slice(0, 5).join(', ')}`
				},
				400
			);
		}

		const commanders: ScryfallCard[] = [];
		for (const cLine of parsed.commanderLines) {
			const c = resolved.get(cLine.name.toLowerCase());
			if (c) commanders.push(c);
		}

		const cards: DeckCardEntry[] = [];
		for (const mLine of parsed.mainboardLines) {
			const c = resolved.get(mLine.name.toLowerCase());
			if (c) {
				cards.push({ quantity: mLine.quantity, card: c });
			}
		}

		// If no Commander header was provided, promote the first Legendary Creature in the list
		if (commanders.length === 0 && cards.length > 0) {
			const legIdx = cards.findIndex((e) => e.card.canBeCommander);
			const chosenIdx = legIdx >= 0 ? legIdx : 0;
			const entry = cards[chosenIdx];
			commanders.push(entry.card);
			if (entry.quantity > 1) {
				entry.quantity -= 1;
			} else {
				cards.splice(chosenIdx, 1);
			}
		}

		const validation = validateCommanderDeck(commanders, cards);
		if (notFound.length > 0) {
			validation.errors.unshift(
				`Unrecognized card names (${notFound.length}): ${notFound.slice(0, 5).join(', ')}`
			);
		}

		const deck: MagicDeck = {
			id: `deck_${now}_${Math.random().toString(36).slice(2, 8)}`,
			userId: user.id,
			name,
			description,
			commanders,
			cards,
			colorIdentity: validation.colorIdentity,
			cardCount: validation.totalCards,
			isLegal: validation.isLegal && notFound.length === 0,
			validationErrors: validation.errors,
			winCount: 0,
			playCount: 0,
			createdAt: now,
			updatedAt: now
		};

		await saveUserDeck(platform, deck);
		const decks = await listUserDecks(platform, user.id);

		return jsonResponse({
			ok: true,
			deck,
			decks,
			notFound
		});
	}

	return jsonResponse({ ok: false, error: `Unknown decks action: ${action}` }, 400);
};
