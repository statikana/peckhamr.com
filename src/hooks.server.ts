import type { Handle } from '@sveltejs/kit/hooks';
import { APPS, isApexHost, stripPort } from './lib/apps.ts';
import { getEnvVar, jsonResponse } from './lib/magic/db.ts';

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host'
]);

export function buildAppSubdomainRedirect(url: URL, method: string): Response | null {
	const hostname = stripPort(url.host);
	const isProdApex = isApexHost(url.host);
	const isLocalRoot = hostname === 'localhost';

	if (!isProdApex && !isLocalRoot) {
		return null;
	}

	const pathname = url.pathname || '/';
	for (const app of APPS) {
		const prefix = `/${app}`;
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
			const rest = pathname.slice(prefix.length) || '/';
			const targetOrigin = isProdApex
				? `https://${app}.peckhamr.com`
				: `${url.protocol || 'http:'}//${app}.localhost${url.port ? `:${url.port}` : ''}`;
			const location = `${targetOrigin}${rest}${url.search}`;
			const upper = method.toUpperCase();
			const status = upper === 'GET' || upper === 'HEAD' ? 301 : 308;
			return new Response(null, {
				status,
				headers: { Location: location }
			});
		}
	}

	return null;
}

function buildProxyRequestHeaders(
	incoming: Headers,
	url: URL,
	proxySecret: string
): Headers {
	const extraConnectionTokens = new Set<string>();
	const connectionVal = incoming.get('connection');
	if (connectionVal) {
		for (const token of connectionVal.split(',')) {
			const trimmed = token.trim().toLowerCase();
			if (trimmed) extraConnectionTokens.add(trimmed);
		}
	}

	const out = new Headers();
	incoming.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower) || extraConnectionTokens.has(lower)) {
			return;
		}
		out.set(key, value);
	});

	out.set('X-Magic-Proxy-Secret', proxySecret);
	out.set('X-Forwarded-Host', url.host);
	out.set('X-Forwarded-Proto', url.protocol.replace(/:$/, ''));

	const clientIp = incoming.get('cf-connecting-ip') || incoming.get('x-forwarded-for');
	if (clientIp) {
		out.set('X-Forwarded-For', clientIp);
	}

	return out;
}

function buildProxyResponse(upstream: Response): Response {
	const outHeaders = new Headers();
	upstream.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (lower === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lower)) {
			return;
		}
		outHeaders.set(key, value);
	});

	for (const cookie of upstream.headers.getSetCookie()) {
		outHeaders.append('Set-Cookie', cookie);
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: outHeaders
	});
}

export const PROXY_TIMEOUT_MS = 10_000;
export const OFFLINE_ERROR_MESSAGE = 'The game server is offline. Try again in a minute.';

export interface ProxyOptions {
	fetchImpl?: typeof globalThis.fetch;
	timeoutMs?: number;
	errorLogger?: (msg: string, err: unknown) => void;
}

export async function proxyMagicApiRequest(
	event: Parameters<Handle>[0]['event'],
	backendUrl: string,
	proxySecret: string,
	options: ProxyOptions = {}
): Promise<Response> {
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
	const logError =
		options.errorLogger ?? ((msg: string, err: unknown) => console.error(msg, err));
	const routePath = event.route.id || event.url.pathname;
	const targetUrl = `${backendUrl.replace(/\/+$/, '')}${routePath}${event.url.search}`;
	const method = event.request.method.toUpperCase();
	const hasBody = method !== 'GET' && method !== 'HEAD';
	const body = hasBody ? event.request.body : undefined;
	const headers = buildProxyRequestHeaders(event.request.headers, event.url, proxySecret);

	const init: RequestInit & { duplex?: 'half' } = {
		method,
		headers,
		body,
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs)
	};
	if (body) {
		init.duplex = 'half';
	}

	try {
		const upstream = await fetchFn(targetUrl, init);
		return buildProxyResponse(upstream);
	} catch (err) {
		logError(`[magic-proxy] Backend unreachable or timed out (${method} ${routePath}):`, err);
		return jsonResponse({ ok: false, error: OFFLINE_ERROR_MESSAGE }, 503);
	}
}

export function createHandle(proxyOptions: ProxyOptions = {}): Handle {
	const logError =
		proxyOptions.errorLogger ?? ((msg: string, err: unknown) => console.error(msg, err));

	return async ({ event, resolve }) => {
		const redirectResponse = buildAppSubdomainRedirect(event.url, event.request.method);
		if (redirectResponse) {
			return redirectResponse;
		}

		if (event.route.id?.startsWith('/magic/api/')) {
			const rawMode = getEnvVar(event.platform, 'MAGIC_MODE').trim().toLowerCase();
			if (rawMode === 'homelab') {
				const backendUrl = getEnvVar(event.platform, 'MAGIC_BACKEND_URL').trim();
				if (!backendUrl) {
					logError(
						'[magic-proxy] Configuration error: MAGIC_MODE=homelab requires MAGIC_BACKEND_URL.',
						''
					);
					return jsonResponse(
						{
							ok: false,
							error: 'Configuration error: MAGIC_BACKEND_URL is not set for MAGIC_MODE=homelab.'
						},
						503
					);
				}

				const proxySecret = getEnvVar(event.platform, 'MAGIC_PROXY_SECRET');
				if (!proxySecret) {
					logError(
						'[magic-proxy] Configuration error: MAGIC_MODE=homelab requires MAGIC_PROXY_SECRET.',
						''
					);
					return jsonResponse(
						{
							ok: false,
							error: 'Configuration error: MAGIC_PROXY_SECRET is not set for MAGIC_MODE=homelab.'
						},
						503
					);
				}

				return proxyMagicApiRequest(event, backendUrl, proxySecret, proxyOptions);
			}
			// Unset, 'cloudflare', or unknown MAGIC_MODE resolves to local SvelteKit Worker routes.
		}

		return resolve(event);
	};
}

export const handle: Handle = createHandle();
