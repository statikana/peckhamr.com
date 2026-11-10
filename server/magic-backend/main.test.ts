import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearCardImageMemory } from '../../src/lib/magic/cardImages.ts';
import { chooseBotAnswer } from '../../src/lib/magic/runtime/choices.ts';
import type { GameActionPayload, GameState, MagicLobby } from '../../src/lib/magic/types.ts';
import { createSqliteD1 } from '../../src/lib/server/sqliteD1.ts';
import { KeyedMutex, startMagicBackendServer, type RunningMagicBackend } from './main.ts';

const TEST_SECRET = 'test-proxy-secret-0123456789abcdef';
const realFetch = globalThis.fetch;

function installOfflineFetchMock(): void {
	mock.method(
		globalThis,
		'fetch',
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const parsed = new URL(url);
			if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
				return realFetch(input, init);
			}
			if (parsed.hostname === 'api.scryfall.com') {
				if (parsed.pathname === '/cards/collection') {
					const rawBody = init?.body ? JSON.parse(String(init.body)) : { identifiers: [] };
					const data = (rawBody.identifiers || []).map((id: { name?: string }, idx: number) => ({
						name: id.name || `Card ${idx}`,
						image_uris: {
							normal: `https://cards.scryfall.io/normal/front/mock/${idx}.jpg`,
							art_crop: `https://cards.scryfall.io/art_crop/front/mock/${idx}.jpg`
						}
					}));
					return new Response(JSON.stringify({ data, not_found: [] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				}
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			throw new Error(`Blocked unexpected external fetch in test: ${url}`);
		}
	);
}

describe('magic-backend HTTP server (Part 2)', () => {
	let backend: RunningMagicBackend | null = null;
	let requestLogs: string[] = [];

	beforeEach(() => {
		requestLogs = [];
		clearCardImageMemory();
		installOfflineFetchMock();
	});

	afterEach(async () => {
		if (backend) {
			await backend.close();
			backend = null;
		}
		mock.restoreAll();
	});

	it('requires X-Magic-Proxy-Secret on API routes (401 without or wrong) while allowing GET /healthz', async () => {
		backend = await startMagicBackendServer({
			port: 0,
			sqlitePath: ':memory:',
			proxySecret: TEST_SECRET,
			logger: (line) => requestLogs.push(line)
		});
		const base = `http://127.0.0.1:${backend.port}`;

		// Unauthenticated /healthz works and exposes no game data
		const healthRes = await fetch(`${base}/healthz`);
		assert.equal(healthRes.status, 200);
		const healthBody = (await healthRes.json()) as Record<string, unknown>;
		assert.equal(healthBody.ok, true);
		assert.equal(healthBody.mode, 'homelab');
		assert.equal(healthBody.dbOk, true);
		assert.equal(typeof healthBody.version, 'number');
		assert.equal(typeof healthBody.uptimeSec, 'number');
		assert.deepEqual(Object.keys(healthBody).sort(), ['dbOk', 'mode', 'ok', 'uptimeSec', 'version']);

		// Missing secret -> 401
		const noSecretRes = await fetch(`${base}/magic/api/auth?action=me`);
		assert.equal(noSecretRes.status, 401);
		assert.equal(((await noSecretRes.json()) as { ok: boolean }).ok, false);

		// Wrong secret -> 401
		const badSecretRes = await fetch(`${base}/magic/api/lobby`, {
			headers: { 'X-Magic-Proxy-Secret': 'wrong-secret' }
		});
		assert.equal(badSecretRes.status, 401);

		// Proxied /magic/api/healthz requires secret, succeeds when provided
		const proxiedHealthNoSecret = await fetch(`${base}/magic/api/healthz`);
		assert.equal(proxiedHealthNoSecret.status, 401);

		const proxiedHealthOk = await fetch(`${base}/magic/api/healthz`, {
			headers: { 'X-Magic-Proxy-Secret': TEST_SECRET }
		});
		assert.equal(proxiedHealthOk.status, 200);
		assert.equal(((await proxiedHealthOk.json()) as { mode: string }).mode, 'homelab');
	});

	it('rebuilds public URL from X-Forwarded-Host/Proto, returns 404 on unknown paths, 413 over 1 MB, and 503 on POST when MAGIC_READ_ONLY=1', async () => {
		backend = await startMagicBackendServer({
			port: 0,
			sqlitePath: ':memory:',
			proxySecret: TEST_SECRET,
			readOnly: true,
			env: {
				GOOGLE_CLIENT_ID: 'google-client-test-id',
				GOOGLE_CLIENT_SECRET: 'google-client-test-secret'
			},
			logger: (line) => requestLogs.push(line)
		});
		const base = `http://127.0.0.1:${backend.port}`;
		const authHeaders = {
			'X-Magic-Proxy-Secret': TEST_SECRET,
			'X-Forwarded-Host': 'magic.peckhamr.com',
			'X-Forwarded-Proto': 'https'
		};

		// Public URL reconstruction verified via Google OAuth 302 redirect_uri + Set-Cookie state
		const oauthStartRes = await fetch(`${base}/magic/api/auth?action=login&provider=google`, {
			headers: authHeaders,
			redirect: 'manual'
		});
		assert.equal(oauthStartRes.status, 302);
		const location = oauthStartRes.headers.get('location') || '';
		const redirectUri = new URL(location).searchParams.get('redirect_uri');
		assert.equal(redirectUri, 'https://magic.peckhamr.com/api/auth?action=callback&provider=google');
		assert.ok(
			oauthStartRes.headers.getSetCookie().some((c) => c.startsWith('magic_oauth_state=')),
			'Expected magic_oauth_state Set-Cookie'
		);

		// Unknown path -> 404 JSON
		const unknownRes = await fetch(`${base}/magic/api/unknown`, { headers: authHeaders });
		assert.equal(unknownRes.status, 404);
		assert.equal(((await unknownRes.json()) as { ok: boolean }).ok, false);

		// Read-only mode -> GET works (200), POST returns 503 JSON
		const getDecks = await fetch(`${base}/magic/api/decks`, { headers: authHeaders });
		assert.equal(getDecks.status, 200);

		const blockedPost = await fetch(`${base}/magic/api/auth`, {
			method: 'POST',
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'guest_login', username: 'Blocked' })
		});
		assert.equal(blockedPost.status, 503);

		// Restart writable server to verify 1 MB body limit -> 413 JSON
		await backend.close();
		backend = await startMagicBackendServer({
			port: 0,
			sqlitePath: ':memory:',
			proxySecret: TEST_SECRET,
			logger: (line) => requestLogs.push(line)
		});
		const writableBase = `http://127.0.0.1:${backend.port}`;
		const bigBody = JSON.stringify({ action: 'chat', message: 'x'.repeat(1_100_000) });
		const tooLargeRes = await fetch(`${writableBase}/magic/api/lobby`, {
			method: 'POST',
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
			body: bigBody
		});
		assert.equal(tooLargeRes.status, 413);
		assert.equal(((await tooLargeRes.json()) as { ok: boolean }).ok, false);
	});

	it('supports guest join flow (POST lobby join with guestName -> Set-Cookie magic_session)', async () => {
		backend = await startMagicBackendServer({
			port: 0,
			sqlitePath: ':memory:',
			proxySecret: TEST_SECRET,
			logger: (line) => requestLogs.push(line)
		});
		const base = `http://127.0.0.1:${backend.port}`;
		const headers = {
			'Content-Type': 'application/json',
			'X-Magic-Proxy-Secret': TEST_SECRET,
			'X-Forwarded-Host': 'magic.peckhamr.com',
			'X-Forwarded-Proto': 'https'
		};

		// Host logs in and creates lobby
		const hostLogin = await fetch(`${base}/magic/api/auth`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'dev_login', username: 'PodHost' })
		});
		const hostCookie = hostLogin.headers.getSetCookie()[0].split(';')[0];

		const createRes = await fetch(`${base}/magic/api/lobby`, {
			method: 'POST',
			headers: { ...headers, Cookie: hostCookie },
			body: JSON.stringify({ action: 'create', name: 'Guest Join Pod' })
		});
		const createJson = (await createRes.json()) as { ok: boolean; lobby: MagicLobby };
		assert.equal(createJson.ok, true);
		const code = createJson.lobby.code;

		// Unauthenticated guest joins via guestName and receives Set-Cookie: magic_session=...
		const guestJoinRes = await fetch(`${base}/magic/api/lobby`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'join', code, guestName: 'GuestPlaneswalker' })
		});
		assert.equal(guestJoinRes.status, 200);
		const setCookies = guestJoinRes.headers.getSetCookie();
		assert.equal(setCookies.length, 1);
		assert.ok(
			setCookies[0].startsWith('magic_session='),
			`Expected magic_session cookie, got: ${setCookies[0]}`
		);
		const guestCookie = setCookies[0].split(';')[0];
		const joinJson = (await guestJoinRes.json()) as {
			ok: boolean;
			user: { id: string; username: string; isGuest: boolean };
			lobby: MagicLobby;
		};
		assert.equal(joinJson.ok, true);
		assert.equal(joinJson.user.username, 'GuestPlaneswalker');
		assert.equal(joinJson.user.isGuest, true);
		assert.ok(joinJson.lobby.seats.some((s) => s.userId === joinJson.user.id));

		// Subsequent /magic/api/auth?action=me with guest session cookie authenticates guest
		const meRes = await fetch(`${base}/magic/api/auth?action=me`, {
			headers: { ...headers, Cookie: guestCookie }
		});
		const meJson = (await meRes.json()) as { ok: boolean; user: { id: string; username: string } };
		assert.equal(meJson.user.id, joinJson.user.id);
		assert.equal(meJson.user.username, 'GuestPlaneswalker');
	});

	it('plays a 4-player precon Commander game vs 3 bots: keep hand, play land, pass through 3 bot turns, persist state (2.6 + 2.7)', async () => {
		backend = await startMagicBackendServer({
			port: 0,
			sqlitePath: ':memory:',
			proxySecret: TEST_SECRET,
			logger: (line) => requestLogs.push(line)
		});
		const base = `http://127.0.0.1:${backend.port}`;
		const headers = {
			'Content-Type': 'application/json',
			'X-Magic-Proxy-Secret': TEST_SECRET,
			'X-Forwarded-Host': 'magic.peckhamr.com',
			'X-Forwarded-Proto': 'https'
		};

		const hostLogin = await fetch(`${base}/magic/api/auth`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'dev_login', username: 'CommanderHost' })
		});
		const hostCookie = hostLogin.headers.getSetCookie()[0].split(';')[0];
		const hostUser = ((await hostLogin.json()) as { user: { id: string } }).user;
		const authedHeaders = { ...headers, Cookie: hostCookie };

		const postLobby = async (payload: Record<string, unknown>) => {
			const t0 = performance.now();
			const res = await fetch(`${base}/magic/api/lobby`, {
				method: 'POST',
				headers: authedHeaders,
				body: JSON.stringify(payload)
			});
			const wallMs = performance.now() - t0;
			const data = (await res.json()) as { ok: boolean; error?: string; lobby: MagicLobby };
			assert.equal(res.status, 200, `POST /magic/api/lobby failed: ${data.error || res.status}`);
			assert.equal(data.ok, true);
			return { lobby: data.lobby, wallMs };
		};

		const { lobby: createdLobby } = await postLobby({
			action: 'create',
			name: '4P Precon Bot Pod',
			rules: { mulliganRule: 'friendly_unlimited' }
		});
		const code = createdLobby.code;

		await postLobby({ action: 'add_bot', code, seatIndex: 1 });
		await postLobby({ action: 'add_bot', code, seatIndex: 2 });
		await postLobby({ action: 'add_bot', code, seatIndex: 3 });

		let { lobby } = await postLobby({ action: 'start_game', code });
		assert.equal(lobby.status, 'active');
		assert.ok(lobby.gameState);

		// Ensure opening hand contains at least 1 land, then keep hand
		for (let tries = 0; tries < 10; tries++) {
			const gs = lobby.gameState!;
			const me = gs.players.find((p) => p.playerId === hostUser.id)!;
			const hasLand = me.hand.some((c) => c.card.typeLine.includes('Land'));
			if (hasLand || gs.status !== 'mulligan') break;
			({ lobby } = await postLobby({
				action: 'game_action',
				code,
				gameAction: { type: 'mulligan_take' } satisfies GameActionPayload
			}));
		}

		if (lobby.gameState!.status === 'mulligan') {
			({ lobby } = await postLobby({
				action: 'game_action',
				code,
				gameAction: { type: 'mulligan_keep' } satisfies GameActionPayload
			}));
		}
		assert.equal(lobby.gameState!.status, 'active');

		const stepNonMainAction = async (): Promise<number> => {
			const gs: GameState = lobby.gameState!;
			const me = gs.players.find((p) => p.playerId === hostUser.id)!;
			const prompt = gs.pendingPrompts.find((p) => p.playerId === hostUser.id);
			let gameAction: GameActionPayload;
			if (prompt) {
				gameAction = {
					type: 'choice',
					promptId: prompt.id,
					answer: chooseBotAnswer(gs, me, prompt)
				};
			} else if (
				gs.phase === 'declare_attackers' &&
				gs.players[gs.activePlayerIndex]?.playerId === hostUser.id
			) {
				gameAction = { type: 'declare_attackers', assignments: [] };
			} else if (gs.phase === 'declare_blockers') {
				gameAction = { type: 'declare_blockers', assignments: [] };
			} else {
				gameAction = { type: 'pass_priority' };
			}
			const res = await postLobby({ action: 'game_action', code, gameAction });
			lobby = res.lobby;
			return res.wallMs;
		};

		// Advance until it is CommanderHost's turn in main1 with empty stack and no pending prompt
		for (let safety = 0; safety < 60; safety++) {
			const gs = lobby.gameState!;
			const active = gs.players[gs.activePlayerIndex];
			const prompt = gs.pendingPrompts.find((p) => p.playerId === hostUser.id);
			if (
				active?.playerId === hostUser.id &&
				gs.phase === 'main1' &&
				gs.stack.length === 0 &&
				!prompt
			) {
				break;
			}
			await stepNonMainAction();
		}

		const gsAtMain1 = lobby.gameState!;
		assert.equal(gsAtMain1.players[gsAtMain1.activePlayerIndex]?.playerId, hostUser.id);
		assert.equal(gsAtMain1.phase, 'main1');
		const turnBeforePass = gsAtMain1.turnNumber;
		const serialBeforePass = gsAtMain1.turnSerial ?? 1;

		// Play a land from hand onto the battlefield
		const meAtMain1 = gsAtMain1.players.find((p) => p.playerId === hostUser.id)!;
		const landInHand = meAtMain1.hand.find((c) => c.card.typeLine.includes('Land'));
		assert.ok(landInHand, 'Expected at least one Land in hand at main1');

		({ lobby } = await postLobby({
			action: 'game_action',
			code,
			gameAction: { type: 'play_land', instanceId: landInHand.instanceId } satisfies GameActionPayload
		}));

		const meAfterLand = lobby.gameState!.players.find((p) => p.playerId === hostUser.id)!;
		assert.ok(
			meAfterLand.battlefield.some((p) => p.card.name === landInHand.card.name),
			`Expected ${landInHand.card.name} on battlefield after play_land`
		);

		// Pass / end turn through a full cycle of 3 bot turns back to human's next turn (Step 2.6 + 2.7)
		const cycleStart = performance.now();
		const initialPass = await postLobby({
			action: 'game_action',
			code,
			gameAction: { type: 'end_turn' } satisfies GameActionPayload
		});
		lobby = initialPass.lobby;
		let passRequests = 1;
		while (lobby.gameState!.status === 'active') {
			const gs = lobby.gameState!;
			const active = gs.players[gs.activePlayerIndex];
			const prompt = gs.pendingPrompts.find((p) => p.playerId === hostUser.id);
			if (
				active?.playerId === hostUser.id &&
				gs.turnNumber > turnBeforePass &&
				gs.phase === 'main1' &&
				gs.stack.length === 0 &&
				!prompt
			) {
				break;
			}
			await stepNonMainAction();
			passRequests++;
			assert.ok(passRequests < 80, 'Exceeded safety bound while advancing through 3 bot turns');
		}
		const fullThreeBotCycleMs = performance.now() - cycleStart;

		const gsAfterCycle = lobby.gameState!;
		assert.ok(
			gsAfterCycle.turnNumber >= turnBeforePass + 1,
			`Expected turnNumber (table round) to advance by >= 1, went ${turnBeforePass} -> ${gsAfterCycle.turnNumber}`
		);
		assert.ok(
			(gsAfterCycle.turnSerial ?? 0) >= serialBeforePass + 4,
			`Expected turnSerial (individual turns) to advance by >= 4 (human + 3 bots), went ${serialBeforePass} -> ${gsAfterCycle.turnSerial}`
		);
		console.log(
			`[2.7 measurement] 3-bot turn cycle (round ${turnBeforePass}->${gsAfterCycle.turnNumber}, turnSerial ${serialBeforePass}->${gsAfterCycle.turnSerial}): end_turn POST = ${initialPass.wallMs.toFixed(1)}ms, full cycle (${passRequests} request(s)) = ${fullThreeBotCycleMs.toFixed(1)}ms`
		);

		// Fresh GET returns persisted game state from SQLite
		const getRes = await fetch(`${base}/magic/api/lobby?code=${code}`, {
			headers: authedHeaders
		});
		assert.equal(getRes.status, 200);
		const getJson = (await getRes.json()) as { ok: boolean; lobby: MagicLobby };
		assert.equal(getJson.ok, true);
		assert.equal(getJson.lobby.gameState?.turnNumber, gsAfterCycle.turnNumber);
		assert.equal(getJson.lobby.gameState?.turnSerial, gsAfterCycle.turnSerial);
		const persistedMe = getJson.lobby.gameState?.players.find((p) => p.playerId === hostUser.id);
		assert.ok(
			persistedMe?.battlefield.some((p) => p.card.name === landInHand.card.name),
			'Fresh GET should return persisted land on battlefield'
		);
	});
});

describe('per-lobby async mutex (2.2)', () => {
	let backend: RunningMagicBackend | null = null;

	beforeEach(() => {
		clearCardImageMemory();
		installOfflineFetchMock();
	});

	afterEach(async () => {
		if (backend) {
			await backend.close();
			backend = null;
		}
		mock.restoreAll();
	});

	it('KeyedMutex serializes tasks on the same key and runs distinct keys concurrently', async () => {
		const mutex = new KeyedMutex();
		const events: string[] = [];

		const p1 = mutex.runExclusive('LOBBY1', async () => {
			events.push('L1-a-start');
			await new Promise((r) => setTimeout(r, 25));
			events.push('L1-a-end');
		});
		const p2 = mutex.runExclusive('LOBBY1', async () => {
			events.push('L1-b-start');
			await new Promise((r) => setTimeout(r, 5));
			events.push('L1-b-end');
		});
		const p3 = mutex.runExclusive('LOBBY2', async () => {
			events.push('L2-start');
			await new Promise((r) => setTimeout(r, 5));
			events.push('L2-end');
		});

		await Promise.all([p1, p2, p3]);
		assert.equal(mutex.activeKeys, 0);
		assert.ok(
			events.indexOf('L1-a-end') < events.indexOf('L1-b-start'),
			`Expected L1-a to finish before L1-b started, got ${events.join(', ')}`
		);
		assert.ok(
			events.indexOf('L2-end') < events.indexOf('L1-a-end'),
			`Expected distinct lobby L2 not to wait on L1-a, got ${events.join(', ')}`
		);
	});

	it('serializes two concurrent POST /magic/api/lobby mutations on the same lobby without lost updates', async () => {
		const rawDb = createSqliteD1(':memory:');
		const origPrepare = rawDb.prepare.bind(rawDb);
		let delayLobbyReads = false;

		rawDb.prepare = ((query: string) => {
			const stmt = origPrepare(query);
			if (delayLobbyReads && query.includes('FROM MagicLobbies WHERE code = ?')) {
				const origBind = stmt.bind.bind(stmt);
				stmt.bind = (...args: unknown[]) => {
					const bound = origBind(...args);
					const boundFirst = bound.first.bind(bound);
					bound.first = (async (...firstArgs: [string?]) => {
						await new Promise((r) => setTimeout(r, 25));
						return boundFirst(...(firstArgs as [string]));
					}) as typeof bound.first;
					return bound;
				};
			}
			return stmt;
		}) as typeof rawDb.prepare;

		backend = await startMagicBackendServer({
			port: 0,
			db: rawDb,
			proxySecret: TEST_SECRET,
			logger: () => {}
		});
		const base = `http://127.0.0.1:${backend.port}`;
		const headers = {
			'Content-Type': 'application/json',
			'X-Magic-Proxy-Secret': TEST_SECRET,
			'X-Forwarded-Host': 'magic.peckhamr.com',
			'X-Forwarded-Proto': 'https'
		};

		const loginRes = await fetch(`${base}/magic/api/auth`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'dev_login', username: 'HostPlayer' })
		});
		const hostCookie = loginRes.headers.getSetCookie()[0].split(';')[0];

		const createRes = await fetch(`${base}/magic/api/lobby`, {
			method: 'POST',
			headers: { ...headers, Cookie: hostCookie },
			body: JSON.stringify({ action: 'create', name: 'Mutex Pod' })
		});
		const created = (await createRes.json()) as { ok: boolean; lobby: { code: string } };
		assert.equal(created.ok, true);
		const code = created.lobby.code;

		delayLobbyReads = true;
		const [joinA, joinB] = await Promise.all([
			fetch(`${base}/magic/api/lobby`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ action: 'join', code, guestName: 'GuestAlpha' })
			}),
			fetch(`${base}/magic/api/lobby`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ action: 'join', code, guestName: 'GuestBeta' })
			})
		]);
		delayLobbyReads = false;

		assert.equal(joinA.status, 200);
		assert.equal(joinB.status, 200);

		const pollRes = await fetch(`${base}/magic/api/lobby?code=${code}`, {
			headers: { ...headers, Cookie: hostCookie }
		});
		const pollData = (await pollRes.json()) as {
			ok: boolean;
			lobby: { seats: Array<{ username: string; userId: string | null }> };
		};
		assert.equal(pollData.ok, true);
		const seatedNames = pollData.lobby.seats.filter((s) => s.userId !== null).map((s) => s.username);
		assert.deepEqual(seatedNames.sort(), ['GuestAlpha', 'GuestBeta', 'HostPlayer']);

		rawDb.close();
	});
});
