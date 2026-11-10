import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearCardImageMemory, resolveScryfallImageLinks } from './cardImages.ts';

const api = (mode: 'exact' | 'fuzzy', name: string, version = 'normal') =>
	`https://api.scryfall.com/cards/named?${mode}=${encodeURIComponent(name)}&format=image&version=${version}`;
const cdn = (id: string, version = 'normal') => `https://cards.scryfall.io/${version}/front/${id}.jpg`;

function card(name: string, id: string) {
	return { name, image_uris: { normal: cdn(id), art_crop: cdn(id, 'art_crop') } };
}

let calls: string[] = [];

function mockScryfall(handler: (url: string, body: any) => unknown) {
	mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
		calls.push(url);
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		const result = handler(url, body);
		if (result instanceof Error) throw result;
		return new Response(JSON.stringify(result), { status: 200 });
	});
}

beforeEach(() => {
	clearCardImageMemory();
	calls = [];
});
afterEach(() => mock.restoreAll());

describe('resolveScryfallImageLinks', () => {
	it('rewrites card and art-crop API links to CDN links with one batched request, including seat art strings', async () => {
		mockScryfall((url, body) => {
			assert.equal(url, 'https://api.scryfall.com/cards/collection');
			assert.deepEqual(body.identifiers, [{ name: 'Sol Ring' }, { name: 'Atraxa, Praetors\' Voice' }]);
			return { data: [card('Sol Ring', 'sol'), card("Atraxa, Praetors' Voice", 'atraxa')], not_found: [] };
		});
		const sol = { name: 'Sol Ring', typeLine: 'Artifact', imageUrl: api('exact', 'Sol Ring'), artCropUrl: api('exact', 'Sol Ring', 'art_crop') };
		const lobby = {
			seats: [{ commanderArtUrl: api('exact', "Atraxa, Praetors' Voice", 'art_crop') }],
			gameState: { players: [{ library: [{ card: sol }, { card: sol }] }] }
		};
		await resolveScryfallImageLinks(undefined, lobby);
		assert.equal(sol.imageUrl, cdn('sol'));
		assert.equal(sol.artCropUrl, cdn('sol', 'art_crop'));
		assert.equal(lobby.seats[0].commanderArtUrl, cdn('atraxa', 'art_crop'));
		assert.equal(calls.length, 1);
	});

	it('serves repeat lookups from memory without calling Scryfall', async () => {
		mockScryfall(() => ({ data: [card('Sol Ring', 'sol')] }));
		await resolveScryfallImageLinks(undefined, { imageUrl: api('exact', 'Sol Ring'), typeLine: 'Artifact' });
		const again = { imageUrl: api('exact', 'Sol Ring'), typeLine: 'Artifact' };
		await resolveScryfallImageLinks(undefined, again);
		assert.equal(again.imageUrl, cdn('sol'));
		assert.equal(calls.length, 1);
	});

	it('finds token art with a token-only search narrowed by colors and P/T, skipping double-faced tokens', async () => {
		mockScryfall((url) => {
			assert.match(decodeURIComponent(url), /q=!"Soldier" t:token c=w pow=1 tou=1/);
			return { data: [{ name: 'Goblin // Soldier', card_faces: [] }, card('Soldier', 'soldier')] };
		});
		const token = {
			name: 'Soldier',
			typeLine: 'Token Creature — Soldier',
			colors: ['W'],
			power: '1',
			toughness: '1',
			imageUrl: api('fuzzy', 'Soldier')
		};
		await resolveScryfallImageLinks(undefined, { battlefield: [{ card: token }] });
		assert.equal(token.imageUrl, cdn('soldier'));
	});

	it('leaves the original links when Scryfall is unreachable, and retries on the next call', async () => {
		mockScryfall(() => new Error('network down'));
		const sol = { imageUrl: api('exact', 'Sol Ring'), typeLine: 'Artifact' };
		await resolveScryfallImageLinks(undefined, sol);
		assert.equal(sol.imageUrl, api('exact', 'Sol Ring'));
		mock.restoreAll();
		mockScryfall(() => ({ data: [card('Sol Ring', 'sol')] }));
		await resolveScryfallImageLinks(undefined, sol);
		assert.equal(sol.imageUrl, cdn('sol'));
	});

	it('remembers names Scryfall does not know instead of asking again on every save', async () => {
		mockScryfall(() => ({ data: [], not_found: [{ name: 'Nonexistent Card' }] }));
		const a = { imageUrl: api('exact', 'Nonexistent Card'), typeLine: 'Artifact' };
		await resolveScryfallImageLinks(undefined, a);
		await resolveScryfallImageLinks(undefined, a);
		assert.equal(a.imageUrl, api('exact', 'Nonexistent Card'));
		assert.equal(calls.length, 1);
	});

	it('makes no requests when there are no API links', async () => {
		mockScryfall(() => assert.fail('should not fetch'));
		await resolveScryfallImageLinks(undefined, { imageUrl: cdn('x'), nested: [{ artCropUrl: cdn('y', 'art_crop') }] });
		assert.equal(calls.length, 0);
	});
});
