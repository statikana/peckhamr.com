import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHandle, handle, OFFLINE_ERROR_MESSAGE } from './hooks.server.ts';
import { APPS } from './lib/apps.ts';
import { GET as cloudflareHealthzGet } from './routes/magic/api/healthz/+server.ts';
import { createSqliteD1 } from './lib/server/sqliteD1.ts';

interface MakeEventOpts {
	method?: string;
	routeId?: string | null;
	headers?: Record<string, string>;
	body?: BodyInit | null;
	env?: Record<string, unknown>;
}

function makeEvent(urlStr: string, methodOrOpts: string | MakeEventOpts = 'GET') {
	const opts: MakeEventOpts =
		typeof methodOrOpts === 'string' ? { method: methodOrOpts } : methodOrOpts;
	const method = opts.method ?? 'GET';
	const url = new URL(urlStr);
	const defaultBody =
		opts.body !== undefined
			? opts.body
			: method === 'POST' || method === 'PUT'
				? JSON.stringify({ hello: 'world' })
				: undefined;
	const init: RequestInit & { duplex?: 'half' } = {
		method,
		headers: opts.headers,
		body: defaultBody ?? undefined
	};
	if (defaultBody && typeof defaultBody !== 'string') {
		init.duplex = 'half';
	}
	const request = new Request(urlStr, init);
	return {
		url,
		request,
		route: { id: opts.routeId ?? null },
		params: {},
		locals: {},
		platform: opts.env ? { env: opts.env } : undefined
	} as any;
}

describe('apex -> subdomain redirects (0.4)', () => {
	it('redirects GET and HEAD on apex and www with 301, preserving rest of path and query', async () => {
		for (const app of APPS) {
			const res = await handle({
				event: makeEvent(`https://peckhamr.com/${app}/?foo=bar&baz=1`, 'GET'),
				resolve: async () => new Response('should not resolve')
			});
			assert.equal(res.status, 301);
			assert.equal(res.headers.get('location'), `https://${app}.peckhamr.com/?foo=bar&baz=1`);
		}

		const bareRes = await handle({
			event: makeEvent('https://www.peckhamr.com/terminal', 'HEAD'),
			resolve: async () => new Response('should not resolve')
		});
		assert.equal(bareRes.status, 301);
		assert.equal(bareRes.headers.get('location'), 'https://terminal.peckhamr.com/');

		const subPathRes = await handle({
			event: makeEvent('https://peckhamr.com/notes/api?action=note&path=Quantum.md', 'GET'),
			resolve: async () => new Response('should not resolve')
		});
		assert.equal(subPathRes.status, 301);
		assert.equal(
			subPathRes.headers.get('location'),
			'https://notes.peckhamr.com/api?action=note&path=Quantum.md'
		);
	});

	it('redirects POST/PUT/DELETE on apex and www with 308 to preserve request method and body', async () => {
		for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
			const res = await handle({
				event: makeEvent('https://peckhamr.com/magic/api/lobby?code=ABC123', method),
				resolve: async () => new Response('should not resolve')
			});
			assert.equal(res.status, 308);
			assert.equal(
				res.headers.get('location'),
				'https://magic.peckhamr.com/api/lobby?code=ABC123'
			);
		}
	});

	it('redirects localhost:<port>/<app> to <app>.localhost:<port> in dev', async () => {
		const getRes = await handle({
			event: makeEvent('http://localhost:5173/cosmo/?tab=drops', 'GET'),
			resolve: async () => new Response('should not resolve')
		});
		assert.equal(getRes.status, 301);
		assert.equal(getRes.headers.get('location'), 'http://cosmo.localhost:5173/?tab=drops');

		const postRes = await handle({
			event: makeEvent('http://localhost:4173/cosmo/api', 'POST'),
			resolve: async () => new Response('should not resolve')
		});
		assert.equal(postRes.status, 308);
		assert.equal(postRes.headers.get('location'), 'http://cosmo.localhost:4173/api');
	});

	it('does not redirect apex home page, static files, non-matching prefixes, or app subdomains', async () => {
		let resolvedCount = 0;
		const resolve = async () => {
			resolvedCount++;
			return new Response('ok', { status: 200 });
		};

		for (const url of [
			'https://peckhamr.com/',
			'https://www.peckhamr.com/',
			'https://peckhamr.com/ryan_peckham_resume.pdf',
			'https://peckhamr.com/magical',
			'https://magic.peckhamr.com/',
			'https://magic.peckhamr.com/magic/api/lobby',
			'http://magic.localhost:5173/'
		]) {
			const res = await handle({ event: makeEvent(url, 'GET'), resolve });
			assert.equal(res.status, 200);
		}
		assert.equal(resolvedCount, 7);
	});
});

describe('Worker Magic API proxy (Part 3)', () => {
	it('falls through to SvelteKit resolve when MAGIC_MODE is cloudflare, unset, or unknown', async () => {
		for (const mode of [undefined, '', 'cloudflare', 'unknown-mode']) {
			let resolved = false;
			let fetchCalled = false;
			const customHandle = createHandle({
				fetchImpl: async () => {
					fetchCalled = true;
					return new Response('unexpected');
				}
			});

			const res = await customHandle({
				event: makeEvent('https://magic.peckhamr.com/api/lobby?code=POD123', {
					method: 'GET',
					routeId: '/magic/api/lobby',
					env: mode === undefined ? {} : { MAGIC_MODE: mode }
				}),
				resolve: async () => {
					resolved = true;
					return new Response(JSON.stringify({ ok: true, from: 'worker' }), { status: 200 });
				}
			});

			assert.equal(resolved, true);
			assert.equal(fetchCalled, false);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { ok: true, from: 'worker' });
		}
	});

	it('returns 503 configuration error when MAGIC_MODE=homelab lacks MAGIC_BACKEND_URL or MAGIC_PROXY_SECRET', async () => {
		const loggedErrors: string[] = [];
		const customHandle = createHandle({
			errorLogger: (msg) => loggedErrors.push(msg),
			fetchImpl: async () => {
				throw new Error('fetch must not be called on config error');
			}
		});

		const noUrlRes = await customHandle({
			event: makeEvent('https://magic.peckhamr.com/api/lobby', {
				method: 'GET',
				routeId: '/magic/api/lobby',
				env: { MAGIC_MODE: 'homelab', MAGIC_PROXY_SECRET: 'sec' }
			}),
			resolve: async () => new Response('must not fall back to worker')
		});
		assert.equal(noUrlRes.status, 503);
		const noUrlBody = (await noUrlRes.json()) as { ok: boolean; error: string };
		assert.equal(noUrlBody.ok, false);
		assert.match(noUrlBody.error, /MAGIC_BACKEND_URL/);

		const noSecretRes = await customHandle({
			event: makeEvent('https://magic.peckhamr.com/api/lobby', {
				method: 'GET',
				routeId: '/magic/api/lobby',
				env: { MAGIC_MODE: 'homelab', MAGIC_BACKEND_URL: 'https://magic-backend.peckhamr.com' }
			}),
			resolve: async () => new Response('must not fall back to worker')
		});
		assert.equal(noSecretRes.status, 503);
		const noSecretBody = (await noSecretRes.json()) as { ok: boolean; error: string };
		assert.equal(noSecretBody.ok, false);
		assert.match(noSecretBody.error, /MAGIC_PROXY_SECRET/);
		assert.equal(loggedErrors.length, 2);
	});

	it('forwards headers, secret, stripped hop-by-hop headers, streamed body (no JSON parse), and multiple Set-Cookie headers', async () => {
		let capturedUrl = '';
		let capturedInit: RequestInit | undefined;
		let capturedRawBody = '';

		const customHandle = createHandle({
			fetchImpl: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				if (init?.body) {
					capturedRawBody = await new Response(init.body as BodyInit).text();
				}
				const upstreamHeaders = new Headers({ 'Content-Type': 'application/json' });
				upstreamHeaders.append(
					'Set-Cookie',
					'magic_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
				);
				upstreamHeaders.append(
					'Set-Cookie',
					'magic_session=tok_abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
				);
				return new Response(JSON.stringify({ ok: true, proxied: true }), {
					status: 200,
					headers: upstreamHeaders
				});
			}
		});

		// Pass non-JSON bytes in a stream to prove the proxy never buffers/JSON-parses the body (3.6)
		const rawPayload = '<<<RAW-NON-JSON-STREAM-PAYLOAD>>>';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(rawPayload));
				controller.close();
			}
		});

		const event = makeEvent('https://magic.peckhamr.com/api/lobby?code=POD999', {
			method: 'POST',
			routeId: '/magic/api/lobby',
			body: stream,
			headers: {
				'Content-Type': 'application/octet-stream',
				Cookie: 'magic_session=existing_tok',
				'CF-Connecting-IP': '203.0.113.42',
				Connection: 'keep-alive, x-custom-hop',
				'Keep-Alive': 'timeout=5',
				'X-Custom-Hop': 'should-be-stripped'
			},
			env: {
				MAGIC_MODE: 'homelab',
				MAGIC_BACKEND_URL: 'https://magic-backend.peckhamr.com/',
				MAGIC_PROXY_SECRET: 'super-secret-xyz'
			}
		});

		const res = await customHandle({
			event,
			resolve: async () => new Response('should not resolve locally')
		});

		assert.equal(capturedUrl, 'https://magic-backend.peckhamr.com/magic/api/lobby?code=POD999');
		assert.equal(capturedInit?.method, 'POST');
		assert.equal(capturedInit?.redirect, 'manual');
		assert.equal(capturedRawBody, rawPayload);

		const sentHeaders = new Headers(capturedInit?.headers);
		assert.equal(sentHeaders.get('x-magic-proxy-secret'), 'super-secret-xyz');
		assert.equal(sentHeaders.get('x-forwarded-host'), 'magic.peckhamr.com');
		assert.equal(sentHeaders.get('x-forwarded-proto'), 'https');
		assert.equal(sentHeaders.get('x-forwarded-for'), '203.0.113.42');
		assert.equal(sentHeaders.get('cookie'), 'magic_session=existing_tok');
		assert.equal(sentHeaders.get('connection'), null);
		assert.equal(sentHeaders.get('keep-alive'), null);
		assert.equal(sentHeaders.get('x-custom-hop'), null);

		assert.equal(res.status, 200);
		assert.deepEqual(res.headers.getSetCookie(), [
			'magic_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
			'magic_session=tok_abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
		]);
		assert.deepEqual(await res.json(), { ok: true, proxied: true });
	});

	it('passes 302 OAuth redirects straight through without following them', async () => {
		const customHandle = createHandle({
			fetchImpl: async (_input, init) => {
				assert.equal(init?.redirect, 'manual');
				return new Response(null, {
					status: 302,
					headers: {
						Location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
						'Set-Cookie': 'magic_oauth_state=st_1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'
					}
				});
			}
		});

		const res = await customHandle({
			event: makeEvent('https://magic.peckhamr.com/api/auth?action=login&provider=google', {
				method: 'GET',
				routeId: '/magic/api/auth',
				env: {
					MAGIC_MODE: 'homelab',
					MAGIC_BACKEND_URL: 'https://magic-backend.peckhamr.com',
					MAGIC_PROXY_SECRET: 'sec'
				}
			}),
			resolve: async () => new Response('should not resolve')
		});

		assert.equal(res.status, 302);
		assert.equal(
			res.headers.get('location'),
			'https://accounts.google.com/o/oauth2/v2/auth?client_id=123'
		);
		assert.equal(res.headers.getSetCookie().length, 1);
	});

	it('returns 503 offline JSON when backend times out or fails without falling back to Worker', async () => {
		let resolved = false;
		const customHandle = createHandle({
			timeoutMs: 20,
			errorLogger: () => {},
			fetchImpl: async (_input, init) => {
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				});
				return new Response('unreachable');
			}
		});

		const res = await customHandle({
			event: makeEvent('https://magic.peckhamr.com/api/lobby?code=ABC123', {
				method: 'GET',
				routeId: '/magic/api/lobby',
				env: {
					MAGIC_MODE: 'homelab',
					MAGIC_BACKEND_URL: 'https://magic-backend.peckhamr.com',
					MAGIC_PROXY_SECRET: 'sec'
				}
			}),
			resolve: async () => {
				resolved = true;
				return new Response('must not fall back');
			}
		});

		assert.equal(resolved, false);
		assert.equal(res.status, 503);
		assert.deepEqual(await res.json(), {
			ok: false,
			error: OFFLINE_ERROR_MESSAGE
		});
	});

	it('/magic/api/healthz reports cloudflare mode in Worker and homelab mode via proxy', async () => {
		// 1. cloudflare mode -> Worker route answers with mode: 'cloudflare'
		const db = createSqliteD1(':memory:');
		try {
			const cfRes = await cloudflareHealthzGet({
				platform: { env: { cosmo_users: db } }
			} as any);
			assert.equal(cfRes.status, 200);
			const cfJson = (await cfRes.json()) as {
				ok: boolean;
				mode: string;
				version: number;
				dbOk: boolean;
			};
			assert.equal(cfJson.ok, true);
			assert.equal(cfJson.mode, 'cloudflare');
			assert.equal(cfJson.dbOk, true);
		} finally {
			db.close();
		}

		// 2. homelab mode -> handle proxies /magic/api/healthz to backend which answers mode: 'homelab'
		const customHandle = createHandle({
			fetchImpl: async (input) => {
				assert.equal(String(input), 'https://magic-backend.peckhamr.com/magic/api/healthz');
				return new Response(
					JSON.stringify({ ok: true, mode: 'homelab', version: 2, uptimeSec: 12, dbOk: true }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
		});

		const hlRes = await customHandle({
			event: makeEvent('https://magic.peckhamr.com/api/healthz', {
				method: 'GET',
				routeId: '/magic/api/healthz',
				env: {
					MAGIC_MODE: 'homelab',
					MAGIC_BACKEND_URL: 'https://magic-backend.peckhamr.com',
					MAGIC_PROXY_SECRET: 'sec'
				}
			}),
			resolve: async () => new Response('should not resolve locally')
		});
		assert.equal(hlRes.status, 200);
		const hlJson = (await hlRes.json()) as { mode: string; ok: boolean };
		assert.equal(hlJson.ok, true);
		assert.equal(hlJson.mode, 'homelab');
	});
});
