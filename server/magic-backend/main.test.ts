import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearCardImageMemory } from '../../src/lib/magic/cardImages.ts';
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

		// Inject a 25ms async yield on MagicLobbies reads so an unserialized concurrent read-modify-write
		// would read the same seat array for both requests and overwrite the first join.
		rawDb.prepare = ((query: string) => {
			const stmt = origPrepare(query);
			if (delayLobbyReads && query.includes('FROM MagicLobbies WHERE code = ?')) {
				const origBind = stmt.bind.bind(stmt);
				stmt.bind = (...args: unknown[]) => {
					const bound = origBind(...args);
					const origFirst = bound.first.bind(bound);
					bound.first = (async (...firstArgs: [string?]) => {
						await new Promise((r) => setTimeout(r, 25));
						return origFirst(...(firstArgs as [string]));
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

		// Host logs in and creates lobby
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

		// Fire two guest join POSTs concurrently against the same lobby
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

		// Verify fresh GET shows host + BOTH guests seated (no overwritten seat)
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
