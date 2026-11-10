import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from '@sveltejs/kit';
import * as authRoute from '../../src/routes/magic/api/auth/+server.ts';
import * as decksRoute from '../../src/routes/magic/api/decks/+server.ts';
import * as lobbyRoute from '../../src/routes/magic/api/lobby/+server.ts';
import { CORS_HEADERS, ensureMagicSchema, jsonResponse } from '../../src/lib/magic/db.ts';
import { ENGINE_VERSION } from '../../src/lib/magic/types.ts';
import { createSqliteD1, type SqliteD1Database } from '../../src/lib/server/sqliteD1.ts';

export const MAX_BODY_BYTES = 1_048_576; // 1 MB

type RouteModule = {
	GET?: RequestHandler;
	POST?: RequestHandler;
	OPTIONS?: RequestHandler;
};

const ROUTES: Record<string, RouteModule> = {
	'/magic/api/lobby': lobbyRoute,
	'/magic/api/decks': decksRoute,
	'/magic/api/auth': authRoute
};

export interface MagicBackendOptions {
	host?: string;
	port?: number;
	sqlitePath?: string;
	db?: SqliteD1Database;
	proxySecret: string;
	readOnly?: boolean;
	env?: Record<string, string | undefined>;
	logger?: (line: string) => void;
	errorLogger?: (message: string, err: unknown) => void;
}

export interface RunningMagicBackend {
	server: Server;
	db: SqliteD1Database;
	host: string;
	port: number;
	close(): Promise<void>;
}

export class KeyedMutex {
	private readonly tails = new Map<string, Promise<void>>();

	async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const nextTail = prev.then(() => gate);
		this.tails.set(key, nextTail);

		await prev;
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === nextTail) {
				this.tails.delete(key);
			}
		}
	}

	get activeKeys(): number {
		return this.tails.size;
	}
}

function extractLobbyMutexKey(bodyBuffer: Buffer | undefined): string | null {
	if (!bodyBuffer || bodyBuffer.byteLength === 0) return null;
	try {
		const parsed = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
		if (parsed && typeof parsed === 'object') {
			const code = typeof parsed.code === 'string' ? parsed.code.trim().toUpperCase() : '';
			if (code) return code;
		}
	} catch {
		// Invalid JSON is handled by the route handler.
	}
	return null;
}

class PayloadTooLargeError extends Error {
	constructor() {
		super('Request body exceeds 1 MB limit.');
	}
}

function firstHeaderValue(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return (value[0] || '').split(',')[0].trim();
	if (typeof value === 'string') return value.split(',')[0].trim();
	return '';
}

export function verifyProxySecret(provided: string, expected: string): boolean {
	if (!provided || !expected) return false;
	const a = createHash('sha256').update(provided, 'utf8').digest();
	const b = createHash('sha256').update(expected, 'utf8').digest();
	return timingSafeEqual(a, b);
}

function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declaredLen = Number(req.headers['content-length']);
	if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
		req.resume();
		throw new PayloadTooLargeError();
	}

	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.byteLength;
		if (total > maxBytes) {
			throw new PayloadTooLargeError();
		}
		chunks.push(buf);
	}
	return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
}

function buildWebHeaders(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, raw] of Object.entries(req.headers)) {
		if (raw === undefined) continue;
		if (Array.isArray(raw)) {
			for (const item of raw) {
				headers.append(key, item);
			}
		} else {
			headers.set(key, raw);
		}
	}
	return headers;
}

async function writeWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
	res.statusCode = webRes.status;

	webRes.headers.forEach((value, key) => {
		if (key.toLowerCase() !== 'set-cookie') {
			res.setHeader(key, value);
		}
	});

	const setCookies = webRes.headers.getSetCookie();
	if (setCookies.length > 0) {
		res.setHeader('set-cookie', setCookies);
	}

	const body = Buffer.from(await webRes.arrayBuffer());
	res.end(body);
}

async function checkDbOk(db: SqliteD1Database): Promise<boolean> {
	try {
		await ensureMagicSchema(db);
		const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
		return row?.ok === 1;
	} catch {
		return false;
	}
}

export async function startMagicBackendServer(
	options: MagicBackendOptions
): Promise<RunningMagicBackend> {
	const host = options.host ?? '127.0.0.1';
	const requestedPort = options.port ?? 8787;
	const proxySecret = options.proxySecret;
	if (!proxySecret) {
		throw new Error('MAGIC_PROXY_SECRET is required to start magic-backend.');
	}

	const ownsDb = !options.db;
	const db = options.db ?? createSqliteD1(options.sqlitePath ?? ':memory:');
	await ensureMagicSchema(db);

	const envVars = options.env ?? process.env;
	const readOnly =
		options.readOnly ??
		(envVars.MAGIC_READ_ONLY === '1' || envVars.MAGIC_READ_ONLY?.toLowerCase() === 'true');
	const log = options.logger ?? ((line: string) => console.log(line));
	const logError =
		options.errorLogger ?? ((msg: string, err: unknown) => console.error(msg, err));

	const platformEnv: Record<string, unknown> = {
		cosmo_users: db,
		GOOGLE_CLIENT_ID: envVars.GOOGLE_CLIENT_ID ?? '',
		GOOGLE_CLIENT_SECRET: envVars.GOOGLE_CLIENT_SECRET ?? '',
		GITHUB_CLIENT_ID: envVars.GITHUB_CLIENT_ID ?? '',
		GITHUB_CLIENT_SECRET: envVars.GITHUB_CLIENT_SECRET ?? ''
	};
	for (const [k, v] of Object.entries(envVars)) {
		if (typeof v === 'string' && !(k in platformEnv)) {
			platformEnv[k] = v;
		}
	}
	const platform = { env: platformEnv as unknown as Env } as App.Platform;
	const lobbyMutex = new KeyedMutex();
	const startedAt = Date.now();

	const server = createServer(async (req, res) => {
		const reqStart = performance.now();
		const method = (req.method || 'GET').toUpperCase();
		const rawUrl = req.url || '/';
		let logPath = rawUrl.split('?')[0] || '/';

		const finish = async (webRes: Response): Promise<void> => {
			await writeWebResponse(res, webRes);
			const elapsedMs = performance.now() - reqStart;
			log(`${method} ${logPath} ${webRes.status} ${elapsedMs.toFixed(1)}ms`);
		};

		try {
			const localParsed = new URL(rawUrl, 'http://127.0.0.1');
			const normalizedPath = normalizePath(localParsed.pathname);
			logPath = normalizedPath;

			// Unauthenticated local/tunnel health check (no game data exposed)
			if (method === 'GET' && normalizedPath === '/healthz') {
				const dbOk = await checkDbOk(db);
				const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
				await finish(
					jsonResponse(
						{ ok: dbOk, mode: 'homelab', version: ENGINE_VERSION, uptimeSec, dbOk },
						dbOk ? 200 : 503
					)
				);
				return;
			}

			// Every other endpoint requires X-Magic-Proxy-Secret
			const providedSecret = firstHeaderValue(req.headers['x-magic-proxy-secret']);
			if (!verifyProxySecret(providedSecret, proxySecret)) {
				await finish(jsonResponse({ ok: false, error: 'Unauthorized' }, 401));
				return;
			}

			// Rebuild public URL from X-Forwarded-Host / X-Forwarded-Proto only after secret matched
			const forwardedHost =
				firstHeaderValue(req.headers['x-forwarded-host']) ||
				firstHeaderValue(req.headers.host) ||
				`${host}:${requestedPort}`;
			const rawProto = firstHeaderValue(req.headers['x-forwarded-proto']).replace(/:$/, '');
			const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
			const publicUrl = new URL(rawUrl, `${proto}://${forwardedHost}`);

			// Mode-aware health endpoint when proxied from magic.peckhamr.com/api/healthz
			if (method === 'GET' && normalizedPath === '/magic/api/healthz') {
				const dbOk = await checkDbOk(db);
				const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
				await finish(
					jsonResponse(
						{ ok: dbOk, mode: 'homelab', version: ENGINE_VERSION, uptimeSec, dbOk },
						dbOk ? 200 : 503
					)
				);
				return;
			}

			const routeModule = ROUTES[normalizedPath];
			if (!routeModule) {
				await finish(jsonResponse({ ok: false, error: 'Not found' }, 404));
				return;
			}

			if (method === 'OPTIONS') {
				const webRes = routeModule.OPTIONS
					? await routeModule.OPTIONS({
							request: new Request(publicUrl.href, { method: 'OPTIONS' }),
							url: publicUrl,
							platform
						} as Parameters<RequestHandler>[0])
					: new Response(null, { status: 204, headers: CORS_HEADERS });
				await finish(webRes);
				return;
			}

			if (readOnly && method === 'POST') {
				await finish(
					jsonResponse(
						{
							ok: false,
							error: 'Magic server is temporarily in read-only mode for maintenance.'
						},
						503
					)
				);
				return;
			}

			const handler =
				method === 'GET' ? routeModule.GET : method === 'POST' ? routeModule.POST : undefined;
			if (!handler) {
				await finish(jsonResponse({ ok: false, error: 'Method not allowed' }, 405));
				return;
			}

			const hasBody = method !== 'GET' && method !== 'HEAD';
			const bodyBuffer = hasBody ? await readRequestBody(req, MAX_BODY_BYTES) : undefined;
			const webHeaders = buildWebHeaders(req);
			const webRequest = new Request(publicUrl.href, {
				method,
				headers: webHeaders,
				body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined
			});

			const event = {
				request: webRequest,
				url: publicUrl,
				platform,
				params: {},
				locals: {},
				route: { id: normalizedPath },
				isDataRequest: false,
				isSubRequest: false,
				isRemoteRequest: false,
				getClientAddress: () =>
					firstHeaderValue(req.headers['x-forwarded-for']) ||
					req.socket.remoteAddress ||
					'127.0.0.1',
				fetch: globalThis.fetch
			} as unknown as Parameters<RequestHandler>[0];

			const lobbyKey =
				normalizedPath === '/magic/api/lobby' && method === 'POST'
					? extractLobbyMutexKey(bodyBuffer)
					: null;
			const webRes = lobbyKey
				? await lobbyMutex.runExclusive(lobbyKey, () => Promise.resolve(handler(event)))
				: await handler(event);
			await finish(webRes);
		} catch (err) {
			if (err instanceof PayloadTooLargeError) {
				await finish(
					jsonResponse({ ok: false, error: err.message }, 413, { Connection: 'close' })
				);
				return;
			}
			logError(
				'[magic-backend] Handler threw an unhandled error:',
				err instanceof Error ? err.stack || err.message : err
			);
			const message = err instanceof Error ? err.message : 'Internal server error';
			if (!res.headersSent) {
				await finish(jsonResponse({ ok: false, error: message }, 500));
			} else {
				res.end();
			}
		}
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(requestedPort, host, () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});

	const addr = server.address();
	const boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

	let closed = false;
	return {
		server,
		db,
		host,
		port: boundPort,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
			});
			if (ownsDb) {
				db.close();
			}
		}
	};
}

const isMainModule =
	typeof process !== 'undefined' &&
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
	const port = Number(process.env.PORT || '8787');
	const host = process.env.HOST || '127.0.0.1';
	const sqlitePath = process.env.MAGIC_SQLITE_PATH || '/var/lib/magic-backend/magic.sqlite';
	const proxySecret = process.env.MAGIC_PROXY_SECRET || '';

	if (!proxySecret) {
		console.error('[magic-backend] Fatal: MAGIC_PROXY_SECRET environment variable must be set.');
		process.exit(1);
	}

	const running = await startMagicBackendServer({
		host,
		port,
		sqlitePath,
		proxySecret
	});
	console.log(
		`[magic-backend] Listening on http://${running.host}:${running.port} (db: ${sqlitePath})`
	);

	const shutdown = async (signal: string) => {
		console.log(`[magic-backend] Received ${signal}, shutting down...`);
		await running.close();
		process.exit(0);
	};
	process.once('SIGINT', () => void shutdown('SIGINT'));
	process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
