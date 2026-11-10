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

export interface ProxyOptions {
	fetchImpl?: typeof globalThis.fetch;
}

export async function proxyMagicApiRequest(
	event: Parameters<Handle>[0]['event'],
	backendUrl: string,
	proxySecret: string,
	options: ProxyOptions = {}
): Promise<Response> {
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
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
		redirect: 'manual'
	};
	if (body) {
		init.duplex = 'half';
	}

	const upstream = await fetchFn(targetUrl, init);
	return buildProxyResponse(upstream);
}

export const handle: Handle = async ({ event, resolve }) => {
	const redirectResponse = buildAppSubdomainRedirect(event.url, event.request.method);
	if (redirectResponse) {
		return redirectResponse;
	}

	if (event.route.id?.startsWith('/magic/api/')) {
		const mode = getEnvVar(event.platform, 'MAGIC_MODE').trim().toLowerCase();
		if (mode === 'homelab') {
			const backendUrl = getEnvVar(event.platform, 'MAGIC_BACKEND_URL').trim();
			const proxySecret = getEnvVar(event.platform, 'MAGIC_PROXY_SECRET');
			if (!backendUrl) {
				console.error(
					'[magic-proxy] Configuration error: MAGIC_MODE=homelab requires MAGIC_BACKEND_URL.'
				);
				return jsonResponse(
					{
						ok: false,
						error: 'Configuration error: missing MAGIC_BACKEND_URL for homelab mode.'
					},
					503
				);
			}
			return proxyMagicApiRequest(event, backendUrl, proxySecret);
		}
	}

	return resolve(event);
};
