import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearCardImageMemory, resolveScryfallImageLinks } from '../magic/cardImages.ts';
import {
	addChatMessage,
	deleteLobby,
	deleteSession,
	deleteUserDeck,
	ensureMagicSchema,
	getAuthenticatedUser,
	getDeckById,
	getLobbyByCode,
	getLobbyChatMessages,
	listUserActiveLobbies,
	listUserDecks,
	saveLobby,
	saveUserDeck,
	upsertUserAndCreateSession
} from '../magic/db.ts';
import { DEFAULT_LOBBY_RULES, type MagicDeck, type MagicLobby } from '../magic/types.ts';
import { createSqliteD1, type SqliteD1Database } from './sqliteD1.ts';

function makePlatform(db: D1Database): App.Platform {
	return {
		env: { cosmo_users: db } as unknown as Env
	} as App.Platform;
}

describe('sqliteD1 shim + real db.ts & cardImages.ts (Part 1)', () => {
	let db: SqliteD1Database;
	let platform: App.Platform;

	beforeEach(() => {
		clearCardImageMemory();
		db = createSqliteD1(':memory:');
		platform = makePlatform(db);
		mock.method(globalThis, 'fetch', async () => {
			throw new Error('Unexpected network fetch in offline test');
		});
	});

	afterEach(() => {
		mock.restoreAll();
		db.close();
	});

	it('ensureMagicSchema creates all 6 Magic tables and is idempotent', async () => {
		await ensureMagicSchema(db);
		await ensureMagicSchema(db);

		const rows = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
			.all<{ name: string }>();
		assert.deepEqual(
			rows.results.map((r) => r.name),
			[
				'MagicCardImages',
				'MagicChatMessages',
				'MagicDecks',
				'MagicLobbies',
				'MagicSessions',
				'MagicUsers'
			]
		);
	});

	it('first() returns null (not undefined) when no row matches', async () => {
		await ensureMagicSchema(db);

		const missingRow = await db
			.prepare('SELECT * FROM MagicUsers WHERE id = ?')
			.bind('usr_does_not_exist')
			.first();
		assert.strictEqual(missingRow, null);

		const missingCol = await db
			.prepare('SELECT username FROM MagicUsers WHERE id = ?')
			.bind('usr_does_not_exist')
			.first<string>('username');
		assert.strictEqual(missingCol, null);
	});

	it('batch() rolls back all statements inside the transaction on failure', async () => {
		await ensureMagicSchema(db);

		await assert.rejects(async () => {
			await db.batch([
				db
					.prepare(
						'INSERT INTO MagicSessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
					)
					.bind('tok_1', 'usr_1', 999999, 1000),
				// Duplicate PRIMARY KEY token forces statement #2 to fail and roll back #1
				db
					.prepare(
						'INSERT INTO MagicSessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
					)
					.bind('tok_1', 'usr_2', 999999, 1000)
			]);
		});

		const survivor = await db
			.prepare('SELECT * FROM MagicSessions WHERE token = ?')
			.bind('tok_1')
			.first();
		assert.strictEqual(survivor, null);
	});

	it('upsertUserAndCreateSession + getAuthenticatedUser (cookie and header tokens) + deleteSession', async () => {
		const created = await upsertUserAndCreateSession(platform, {
			provider: 'google',
			providerId: 'g-12345',
			email: 'planeswalker@example.com',
			username: 'Jace',
			avatarUrl: 'https://example.com/jace.png'
		});
		assert.equal(created.user.id, 'usr_google_g-12345');
		assert.equal(created.user.username, 'Jace');
		assert.equal(created.user.isGuest, false);
		assert.ok(created.token.startsWith('msess_'));

		// Cookie auth
		const cookieReq = new Request('https://magic.peckhamr.com/api/auth?action=me', {
			headers: { Cookie: `other=1; magic_session=${encodeURIComponent(created.token)}` }
		});
		const fromCookie = await getAuthenticatedUser(cookieReq, platform);
		assert.equal(fromCookie?.id, created.user.id);
		assert.equal(fromCookie?.username, 'Jace');

		// X-Magic-Session header auth
		const headerReq = new Request('https://magic.peckhamr.com/api/auth?action=me', {
			headers: { 'X-Magic-Session': created.token }
		});
		const fromHeader = await getAuthenticatedUser(headerReq, platform);
		assert.equal(fromHeader?.id, created.user.id);

		// Authorization: Bearer header auth
		const bearerReq = new Request('https://magic.peckhamr.com/api/auth?action=me', {
			headers: { Authorization: `Bearer ${created.token}` }
		});
		const fromBearer = await getAuthenticatedUser(bearerReq, platform);
		assert.equal(fromBearer?.id, created.user.id);

		// Upsert updates existing user profile
		const updated = await upsertUserAndCreateSession(platform, {
			provider: 'google',
			providerId: 'g-12345',
			email: 'jace.beleren@example.com',
			username: 'Jace Beleren',
			avatarUrl: 'https://example.com/jace2.png'
		});
		assert.equal(updated.user.id, created.user.id);
		assert.equal(updated.user.username, 'Jace Beleren');
		assert.equal(updated.user.email, 'jace.beleren@example.com');

		// deleteSession invalidates token
		await deleteSession(platform, created.token);
		const afterLogout = await getAuthenticatedUser(cookieReq, platform);
		assert.strictEqual(afterLogout, null);
	});

	it('saveUserDeck / listUserDecks / getDeckById / deleteUserDeck', async () => {
		const now = Date.now();
		const deck: MagicDeck = {
			id: 'deck_1',
			userId: 'usr_1',
			name: 'Azorius Blink',
			description: 'Control & blink value',
			commanders: [],
			cards: [],
			colorIdentity: ['W', 'U'],
			cardCount: 100,
			isLegal: true,
			validationErrors: [],
			winCount: 2,
			playCount: 5,
			createdAt: now - 1000,
			updatedAt: now - 1000
		};

		await saveUserDeck(platform, deck);

		const fetched = await getDeckById(platform, 'deck_1');
		assert.ok(fetched);
		assert.equal(fetched.name, 'Azorius Blink');
		assert.deepEqual(fetched.colorIdentity, ['W', 'U']);
		assert.equal(fetched.isLegal, true);

		// Update via ON CONFLICT(id) DO UPDATE
		await saveUserDeck(platform, {
			...deck,
			name: 'Azorius Ephemerate',
			isLegal: false,
			validationErrors: ['99 cards'],
			updatedAt: now
		});

		const listed = await listUserDecks(platform, 'usr_1');
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, 'Azorius Ephemerate');
		assert.equal(listed[0].isLegal, false);
		assert.deepEqual(listed[0].validationErrors, ['99 cards']);

		await deleteUserDeck(platform, 'deck_1', 'usr_1');
		assert.strictEqual(await getDeckById(platform, 'deck_1'), null);
		assert.deepEqual(await listUserDecks(platform, 'usr_1'), []);
	});

	it('saveLobby / getLobbyByCode / listUserActiveLobbies / deleteLobby + chat messages', async () => {
		const now = Date.now();
		const activeLobby: MagicLobby = {
			code: 'ab12cd',
			name: 'Friday Pod',
			hostUserId: 'usr_host',
			status: 'waiting',
			isPrivate: true,
			rules: { ...DEFAULT_LOBBY_RULES },
			seats: [
				{
					seatIdx: 0,
					userId: 'usr_host',
					username: 'Host',
					avatarUrl: '',
					isBot: false,
					botDifficulty: 'medium',
					deckId: 'precon-0',
					deckName: 'Precon',
					commanderNames: ['Sol Ring'],
					colorIdentity: ['W'],
					ready: true,
					connected: true,
					lastHeartbeat: now
				}
			],
			gameState: null,
			version: 1,
			createdAt: now,
			updatedAt: now
		};

		// Note: code gets uppercased on lookup; store uppercase to match lobby handler convention
		activeLobby.code = 'AB12CD';
		await saveLobby(platform, activeLobby);

		// Also insert an abandoned lobby (>60m stale) to verify listUserActiveLobbies prunes it
		const staleTime = now - 2 * 60 * 60 * 1000;
		await saveLobby(platform, {
			...activeLobby,
			code: 'OLD999',
			name: 'Abandoned Pod',
			seats: [{ ...activeLobby.seats[0], lastHeartbeat: staleTime }],
			createdAt: staleTime,
			updatedAt: staleTime
		});

		const loaded = await getLobbyByCode(platform, 'ab12cd');
		assert.ok(loaded);
		assert.equal(loaded.code, 'AB12CD');
		assert.equal(loaded.name, 'Friday Pod');

		// Update via ON CONFLICT(code) DO UPDATE
		await saveLobby(platform, { ...activeLobby, status: 'active', version: 2, updatedAt: now + 50 });
		const updated = await getLobbyByCode(platform, 'AB12CD');
		assert.equal(updated?.status, 'active');
		assert.equal(updated?.version, 2);

		const userLobbies = await listUserActiveLobbies(platform, 'usr_host');
		assert.deepEqual(
			userLobbies.map((l) => l.code),
			['AB12CD']
		);
		// Abandoned lobby was deleted from SQLite
		assert.strictEqual(await getLobbyByCode(platform, 'OLD999'), null);

		// Chat messages
		await addChatMessage(platform, {
			id: 'chat_1',
			lobbyCode: 'AB12CD',
			userId: 'usr_host',
			username: 'Host',
			avatarUrl: '',
			seatIdx: 0,
			kind: 'system',
			message: 'Lobby created.',
			createdAt: now + 10
		});
		await addChatMessage(platform, {
			id: 'chat_2',
			lobbyCode: 'AB12CD',
			userId: 'usr_host',
			username: 'Host',
			avatarUrl: '',
			seatIdx: 0,
			kind: 'chat',
			message: 'GLHF!',
			createdAt: now + 20
		});

		const chats = await getLobbyChatMessages(platform, 'ab12cd', 80);
		assert.deepEqual(
			chats.map((c) => c.message),
			['Lobby created.', 'GLHF!']
		);

		// deleteLobby removes both lobby and its chat messages
		await deleteLobby(platform, 'ab12cd');
		assert.strictEqual(await getLobbyByCode(platform, 'AB12CD'), null);
		assert.deepEqual(await getLobbyChatMessages(platform, 'AB12CD', 80), []);
	});

	it('cardImages.ts reads and writes MagicCardImages through sqliteD1 offline', async () => {
		await ensureMagicSchema(db);

		let scryfallCalls = 0;
		mock.restoreAll();
		mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
			scryfallCalls++;
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			assert.equal(url, 'https://api.scryfall.com/cards/collection');
			return new Response(
				JSON.stringify({
					data: [
						{
							name: 'Sol Ring',
							image_uris: {
								normal: 'https://cards.scryfall.io/normal/front/s/o/sol-ring.jpg',
								art_crop: 'https://cards.scryfall.io/art_crop/front/s/o/sol-ring.jpg'
							}
						}
					],
					not_found: []
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		});

		const payload1 = {
			imageUrl: 'https://api.scryfall.com/cards/named?exact=Sol%20Ring&format=image&version=normal',
			artCropUrl:
				'https://api.scryfall.com/cards/named?exact=Sol%20Ring&format=image&version=art_crop'
		};
		await resolveScryfallImageLinks(db, payload1, 1_700_000_000_000);
		assert.equal(scryfallCalls, 1);
		assert.equal(payload1.imageUrl, 'https://cards.scryfall.io/normal/front/s/o/sol-ring.jpg');
		assert.equal(payload1.artCropUrl, 'https://cards.scryfall.io/art_crop/front/s/o/sol-ring.jpg');

		// Clear in-memory cache so the second call MUST read from SQLite MagicCardImages without hitting fetch
		clearCardImageMemory();
		const payload2 = {
			imageUrl: 'https://api.scryfall.com/cards/named?exact=Sol%20Ring&format=image&version=normal'
		};
		await resolveScryfallImageLinks(db, payload2, 1_700_000_001_000);
		assert.equal(scryfallCalls, 1);
		assert.equal(payload2.imageUrl, 'https://cards.scryfall.io/normal/front/s/o/sol-ring.jpg');
	});
});
