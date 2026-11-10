import { resolveScryfallImageLinks } from './cardImages.ts';
import type {
	MagicChatMessage,
	MagicDeck,
	MagicLobby,
	MagicUser,
	LobbyRulesConfig,
	LobbySeat,
	GameState
} from './types.ts';

let cfEnv: Record<string, unknown> | undefined;
try {
	const mod = (await import('cloudflare:workers')) as { env?: Record<string, unknown> };
	cfEnv = mod?.env;
} catch {
	cfEnv = undefined;
}

export const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Magic-Session'
};

export function jsonResponse(
	data: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...CORS_HEADERS,
			...extraHeaders
		}
	});
}

export function getD1(platform: App.Platform | undefined): D1Database | undefined {
	if (platform?.env?.cosmo_users) {
		return platform.env.cosmo_users;
	}
	try {
		return (cfEnv as unknown as Env | undefined)?.cosmo_users;
	} catch {
		return undefined;
	}
}

export function getEnvVar(platform: App.Platform | undefined, key: string): string {
	try {
		const pEnv = platform?.env as unknown as Record<string, unknown> | undefined;
		if (pEnv && typeof pEnv[key] === 'string' && pEnv[key]) return pEnv[key];
		if (cfEnv && typeof cfEnv[key] === 'string' && cfEnv[key]) return cfEnv[key];
	} catch {
		// ignore
	}
	if (typeof process !== 'undefined' && process.env && process.env[key]) {
		return process.env[key] || '';
	}
	return '';
}

// In-memory fallback store if D1 is not bound in a bare Node/Vite test environment
const memoryStore = {
	users: new Map<string, MagicUser>(),
	sessions: new Map<string, { token: string; userId: string; expiresAt: number; createdAt: number }>(),
	decks: new Map<string, MagicDeck>(),
	lobbies: new Map<string, MagicLobby>(),
	chats: new Map<string, MagicChatMessage[]>()
};

const initializedDbs = new WeakSet<object>();
const schemaInitPromises = new WeakMap<object, Promise<void>>();

export async function ensureMagicSchema(db: D1Database | undefined): Promise<void> {
	if (!db || initializedDbs.has(db)) return;
	const existingPromise = schemaInitPromises.get(db);
	if (existingPromise) {
		await existingPromise;
		return;
	}
	const initPromise = (async () => {
		try {
			await db.batch([
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicUsers (
						id TEXT PRIMARY KEY,
						provider TEXT NOT NULL,
						provider_id TEXT NOT NULL,
						email TEXT DEFAULT '',
						username TEXT NOT NULL,
						avatar_url TEXT DEFAULT '',
						stats_json TEXT DEFAULT '{}',
						created_at INTEGER NOT NULL,
						last_login_at INTEGER NOT NULL
					)
				`),
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicSessions (
						token TEXT PRIMARY KEY,
						user_id TEXT NOT NULL,
						expires_at INTEGER NOT NULL,
						created_at INTEGER NOT NULL
					)
				`),
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicDecks (
						id TEXT PRIMARY KEY,
						user_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT DEFAULT '',
						commanders_json TEXT NOT NULL,
						cards_json TEXT NOT NULL,
						color_identity TEXT NOT NULL,
						card_count INTEGER DEFAULT 100,
						is_legal INTEGER DEFAULT 1,
						validation_errors_json TEXT DEFAULT '[]',
						win_count INTEGER DEFAULT 0,
						play_count INTEGER DEFAULT 0,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`),
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicLobbies (
						code TEXT PRIMARY KEY,
						name TEXT NOT NULL,
						host_user_id TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'waiting',
						is_private INTEGER DEFAULT 1,
						rules_json TEXT NOT NULL,
						seats_json TEXT NOT NULL,
						game_state_json TEXT DEFAULT '',
						version INTEGER DEFAULT 1,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`),
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicChatMessages (
						id TEXT PRIMARY KEY,
						lobby_code TEXT NOT NULL,
						user_id TEXT NOT NULL,
						username TEXT NOT NULL,
						avatar_url TEXT DEFAULT '',
						seat_idx INTEGER DEFAULT -1,
						kind TEXT DEFAULT 'chat',
						message TEXT NOT NULL,
						created_at INTEGER NOT NULL
					)
				`),
				db.prepare(`
					CREATE TABLE IF NOT EXISTS MagicCardImages (
						key TEXT PRIMARY KEY,
						image_url TEXT NOT NULL,
						art_crop_url TEXT NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`)
			]);
			initializedDbs.add(db);
		} finally {
			schemaInitPromises.delete(db);
		}
	})();
	schemaInitPromises.set(db, initPromise);
	await initPromise;
}

export function extractSessionToken(request: Request): string | null {
	const headerToken =
		request.headers.get('x-magic-session') ||
		(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
	if (headerToken) return headerToken;

	const cookieHeader = request.headers.get('cookie') || '';
	const match = cookieHeader.match(/(?:^|;\s*)magic_session=([^;]+)/);
	if (match && match[1]) {
		return decodeURIComponent(match[1]);
	}
	return null;
}

export async function getAuthenticatedUser(
	request: Request,
	platform: App.Platform | undefined
): Promise<MagicUser | null> {
	const token = extractSessionToken(request);
	if (!token) return null;

	const db = getD1(platform);
	await ensureMagicSchema(db);
	const now = Date.now();

	if (db) {
		const session = await db
			.prepare('SELECT user_id, expires_at FROM MagicSessions WHERE token = ?')
			.bind(token)
			.first<{ user_id: string; expires_at: number }>();
		if (!session || session.expires_at < now) return null;

		const row = await db
			.prepare('SELECT * FROM MagicUsers WHERE id = ?')
			.bind(session.user_id)
			.first<Record<string, any>>();
		if (!row) return null;
		return mapRowToUser(row);
	}

	const memSession = memoryStore.sessions.get(token);
	if (!memSession || memSession.expiresAt < now) return null;
	return memoryStore.users.get(memSession.userId) || null;
}

function mapRowToUser(row: Record<string, any>): MagicUser {
	let stats = { gamesPlayed: 0, wins: 0 };
	try {
		stats = { ...stats, ...JSON.parse(String(row.stats_json || '{}')) };
	} catch {
		// ignore
	}
	const provider = (row.provider as 'google' | 'github' | 'guest' | 'dev') || 'dev';
	return {
		id: String(row.id),
		provider,
		providerId: String(row.provider_id || ''),
		email: String(row.email || ''),
		username: String(row.username || 'Planeswalker'),
		avatarUrl: String(row.avatar_url || ''),
		isGuest: provider === 'guest',
		stats,
		createdAt: Number(row.created_at || Date.now()),
		lastLoginAt: Number(row.last_login_at || Date.now())
	};
}

export async function upsertUserAndCreateSession(
	platform: App.Platform | undefined,
	params: {
		provider: 'google' | 'github' | 'guest' | 'dev';
		providerId: string;
		email: string;
		username: string;
		avatarUrl: string;
	}
): Promise<{ user: MagicUser; token: string }> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	const now = Date.now();
	const userId = `usr_${params.provider}_${params.providerId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const token = `msess_${now}_${Math.random().toString(36).slice(2, 12)}_${Math.random().toString(36).slice(2, 12)}`;
	const expiresAt = now + 1000 * 60 * 60 * 24 * 30; // 30 days

	if (db) {
		const existing = await db
			.prepare('SELECT * FROM MagicUsers WHERE id = ?')
			.bind(userId)
			.first<Record<string, any>>();

		if (existing) {
			await db
				.prepare(
					'UPDATE MagicUsers SET username = ?, email = ?, avatar_url = ?, last_login_at = ? WHERE id = ?'
				)
				.bind(params.username, params.email, params.avatarUrl, now, userId)
				.run();
		} else {
			await db
				.prepare(
					`INSERT INTO MagicUsers (id, provider, provider_id, email, username, avatar_url, stats_json, created_at, last_login_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					userId,
					params.provider,
					params.providerId,
					params.email,
					params.username,
					params.avatarUrl,
					JSON.stringify({ gamesPlayed: 0, wins: 0 }),
					now,
					now
				)
				.run();
		}

		await db
			.prepare('INSERT INTO MagicSessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
			.bind(token, userId, expiresAt, now)
			.run();

		const row = await db
			.prepare('SELECT * FROM MagicUsers WHERE id = ?')
			.bind(userId)
			.first<Record<string, any>>();
		return { user: mapRowToUser(row!), token };
	}

	const existingMem = memoryStore.users.get(userId);
	const user: MagicUser = existingMem
		? {
				...existingMem,
				username: params.username,
				email: params.email,
				avatarUrl: params.avatarUrl,
				isGuest: params.provider === 'guest',
				lastLoginAt: now
		  }
		: {
				id: userId,
				provider: params.provider,
				providerId: params.providerId,
				email: params.email,
				username: params.username,
				avatarUrl: params.avatarUrl,
				isGuest: params.provider === 'guest',
				stats: { gamesPlayed: 0, wins: 0 },
				createdAt: now,
				lastLoginAt: now
		  };
	memoryStore.users.set(userId, user);
	memoryStore.sessions.set(token, { token, userId, expiresAt, createdAt: now });
	return { user, token };
}

export async function deleteSession(
	platform: App.Platform | undefined,
	token: string
): Promise<void> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		await db.prepare('DELETE FROM MagicSessions WHERE token = ?').bind(token).run();
	} else {
		memoryStore.sessions.delete(token);
	}
}

function mapRowToDeck(row: Record<string, any>): MagicDeck {
	let commanders = [];
	let cards = [];
	let validationErrors = [];
	try {
		commanders = JSON.parse(String(row.commanders_json || '[]'));
	} catch {}
	try {
		cards = JSON.parse(String(row.cards_json || '[]'));
	} catch {}
	try {
		validationErrors = JSON.parse(String(row.validation_errors_json || '[]'));
	} catch {}

	const ciRaw = String(row.color_identity || '');
	const colorIdentity = ciRaw ? (ciRaw.split('').filter(Boolean) as any[]) : [];

	return {
		id: String(row.id),
		userId: String(row.user_id),
		name: String(row.name),
		description: String(row.description || ''),
		commanders,
		cards,
		colorIdentity,
		cardCount: Number(row.card_count || 100),
		isLegal: Boolean(row.is_legal),
		validationErrors,
		winCount: Number(row.win_count || 0),
		playCount: Number(row.play_count || 0),
		createdAt: Number(row.created_at || Date.now()),
		updatedAt: Number(row.updated_at || Date.now())
	};
}

export async function listUserDecks(
	platform: App.Platform | undefined,
	userId: string
): Promise<MagicDeck[]> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		const res = await db
			.prepare('SELECT * FROM MagicDecks WHERE user_id = ? ORDER BY updated_at DESC')
			.bind(userId)
			.all<Record<string, any>>();
		return (res.results || []).map(mapRowToDeck);
	}
	return Array.from(memoryStore.decks.values())
		.filter((d) => d.userId === userId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDeckById(
	platform: App.Platform | undefined,
	deckId: string
): Promise<MagicDeck | null> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		const row = await db
			.prepare('SELECT * FROM MagicDecks WHERE id = ?')
			.bind(deckId)
			.first<Record<string, any>>();
		return row ? mapRowToDeck(row) : null;
	}
	return memoryStore.decks.get(deckId) || null;
}

export async function saveUserDeck(
	platform: App.Platform | undefined,
	deck: MagicDeck
): Promise<MagicDeck> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		await db
			.prepare(
				`INSERT INTO MagicDecks
				 (id, user_id, name, description, commanders_json, cards_json, color_identity, card_count, is_legal, validation_errors_json, win_count, play_count, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   name = excluded.name,
				   description = excluded.description,
				   commanders_json = excluded.commanders_json,
				   cards_json = excluded.cards_json,
				   color_identity = excluded.color_identity,
				   card_count = excluded.card_count,
				   is_legal = excluded.is_legal,
				   validation_errors_json = excluded.validation_errors_json,
				   updated_at = excluded.updated_at`
			)
			.bind(
				deck.id,
				deck.userId,
				deck.name,
				deck.description,
				JSON.stringify(deck.commanders),
				JSON.stringify(deck.cards),
				deck.colorIdentity.join(''),
				deck.cardCount,
				deck.isLegal ? 1 : 0,
				JSON.stringify(deck.validationErrors),
				deck.winCount,
				deck.playCount,
				deck.createdAt,
				deck.updatedAt
			)
			.run();
	} else {
		memoryStore.decks.set(deck.id, deck);
	}
	return deck;
}

export async function deleteUserDeck(
	platform: App.Platform | undefined,
	deckId: string,
	userId: string
): Promise<boolean> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		await db
			.prepare('DELETE FROM MagicDecks WHERE id = ? AND user_id = ?')
			.bind(deckId, userId)
			.run();
		return true;
	}
	const d = memoryStore.decks.get(deckId);
	if (d && d.userId === userId) {
		memoryStore.decks.delete(deckId);
		return true;
	}
	return false;
}

function mapRowToLobby(row: Record<string, any>): MagicLobby {
	let rules: LobbyRulesConfig = {
		startingLife: 40,
		commanderDamageLethal: 21,
		commanderTaxIncrement: 2,
		poisonLethal: 10,
		mulliganRule: 'london_1free',
		deckValidationMode: 'strict_commander',
		turnTimerSeconds: 90,
		firstTurnDraw: true,
		maxHandSize: 7,
		maxPlayers: 4,
		allowUnsupportedCards: true
	};
	let seats: LobbySeat[] = [];
	let gameState: GameState | null = null;

	try {
		rules = { ...rules, ...JSON.parse(String(row.rules_json || '{}')) };
	} catch {}
	try {
		seats = JSON.parse(String(row.seats_json || '[]'));
	} catch {}
	try {
		if (row.game_state_json) {
			gameState = JSON.parse(String(row.game_state_json));
		}
	} catch {}

	return {
		code: String(row.code),
		name: String(row.name),
		hostUserId: String(row.host_user_id),
		status: (row.status as 'waiting' | 'active' | 'finished') || 'waiting',
		isPrivate: Boolean(row.is_private),
		rules,
		seats,
		gameState,
		version: Number(row.version || 1),
		createdAt: Number(row.created_at || Date.now()),
		updatedAt: Number(row.updated_at || Date.now())
	};
}

export async function getLobbyByCode(
	platform: App.Platform | undefined,
	code: string
): Promise<MagicLobby | null> {
	const cleanCode = code.trim().toUpperCase();
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		const row = await db
			.prepare('SELECT * FROM MagicLobbies WHERE code = ?')
			.bind(cleanCode)
			.first<Record<string, any>>();
		return row ? mapRowToLobby(row) : null;
	}
	return memoryStore.lobbies.get(cleanCode) || null;
}

export async function deleteLobby(
	platform: App.Platform | undefined,
	code: string
): Promise<void> {
	const cleanCode = code.trim().toUpperCase();
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		await db.prepare('DELETE FROM MagicLobbies WHERE code = ?').bind(cleanCode).run();
		await db.prepare('DELETE FROM MagicChatMessages WHERE lobby_code = ?').bind(cleanCode).run();
	} else {
		memoryStore.lobbies.delete(cleanCode);
		memoryStore.chats.delete(cleanCode);
	}
}

export async function listUserActiveLobbies(
	platform: App.Platform | undefined,
	userId: string
): Promise<MagicLobby[]> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	const staleThreshold = Date.now() - 60 * 60 * 1000; // 60 minutes of inactivity

	const isLobbyAbandoned = (l: MagicLobby): boolean => {
		const humans = l.seats.filter((s) => s.userId !== null && !s.isBot);
		if (humans.length === 0) return true;
		const anyRecentHeartbeat = humans.some((s) => (s.lastHeartbeat || l.updatedAt) >= staleThreshold);
		return !anyRecentHeartbeat && l.updatedAt < staleThreshold;
	};

	if (db) {
		const res = await db
			.prepare('SELECT * FROM MagicLobbies ORDER BY updated_at DESC LIMIT 25')
			.all<Record<string, any>>();
		const all = (res.results || []).map(mapRowToLobby);
		const valid: MagicLobby[] = [];
		for (const l of all) {
			if (isLobbyAbandoned(l)) {
				await deleteLobby(platform, l.code);
				continue;
			}
			if (l.hostUserId === userId || l.seats.some((s) => s.userId === userId)) {
				valid.push(l);
			}
		}
		return valid;
	}
	const valid: MagicLobby[] = [];
	for (const l of Array.from(memoryStore.lobbies.values())) {
		if (isLobbyAbandoned(l)) {
			memoryStore.lobbies.delete(l.code);
			memoryStore.chats.delete(l.code);
			continue;
		}
		if (l.hostUserId === userId || l.seats.some((s) => s.userId === userId)) {
			valid.push(l);
		}
	}
	return valid.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveLobby(
	platform: App.Platform | undefined,
	lobby: MagicLobby
): Promise<MagicLobby> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	// Precon and token cards carry Scryfall API image links; store CDN links instead (cardImages.ts).
	await resolveScryfallImageLinks(db, lobby);
	if (db) {
		await db
			.prepare(
				`INSERT INTO MagicLobbies
				 (code, name, host_user_id, status, is_private, rules_json, seats_json, game_state_json, version, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(code) DO UPDATE SET
				   name = excluded.name,
				   host_user_id = excluded.host_user_id,
				   status = excluded.status,
				   is_private = excluded.is_private,
				   rules_json = excluded.rules_json,
				   seats_json = excluded.seats_json,
				   game_state_json = excluded.game_state_json,
				   version = excluded.version,
				   updated_at = excluded.updated_at`
			)
			.bind(
				lobby.code,
				lobby.name,
				lobby.hostUserId,
				lobby.status,
				lobby.isPrivate ? 1 : 0,
				JSON.stringify(lobby.rules),
				JSON.stringify(lobby.seats),
				lobby.gameState ? JSON.stringify(lobby.gameState) : '',
				lobby.version,
				lobby.createdAt,
				lobby.updatedAt
			)
			.run();
	} else {
		memoryStore.lobbies.set(lobby.code, lobby);
	}
	return lobby;
}

export async function addChatMessage(
	platform: App.Platform | undefined,
	msg: MagicChatMessage
): Promise<MagicChatMessage> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		await db
			.prepare(
				`INSERT INTO MagicChatMessages (id, lobby_code, user_id, username, avatar_url, seat_idx, kind, message, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				msg.id,
				msg.lobbyCode,
				msg.userId,
				msg.username,
				msg.avatarUrl,
				msg.seatIdx,
				msg.kind,
				msg.message,
				msg.createdAt
			)
			.run();
	} else {
		const list = memoryStore.chats.get(msg.lobbyCode) || [];
		list.push(msg);
		if (list.length > 150) list.splice(0, list.length - 150);
		memoryStore.chats.set(msg.lobbyCode, list);
	}
	return msg;
}

export async function getLobbyChatMessages(
	platform: App.Platform | undefined,
	lobbyCode: string,
	limit = 80
): Promise<MagicChatMessage[]> {
	const db = getD1(platform);
	await ensureMagicSchema(db);
	if (db) {
		const res = await db
			.prepare(
				'SELECT * FROM MagicChatMessages WHERE lobby_code = ? ORDER BY created_at DESC LIMIT ?'
			)
			.bind(lobbyCode.toUpperCase(), limit)
			.all<Record<string, any>>();
		return (res.results || [])
			.map((r) => ({
				id: String(r.id),
				lobbyCode: String(r.lobby_code),
				userId: String(r.user_id),
				username: String(r.username),
				avatarUrl: String(r.avatar_url || ''),
				seatIdx: Number(r.seat_idx ?? -1),
				kind: (r.kind as 'chat' | 'system' | 'game_log' | 'emote') || 'chat',
				message: String(r.message),
				createdAt: Number(r.created_at)
			}))
			.reverse();
	}
	const list = memoryStore.chats.get(lobbyCode.toUpperCase()) || [];
	return list.slice(-limit);
}
