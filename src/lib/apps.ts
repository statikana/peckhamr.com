export const APPS = ['magic', 'cosmo', 'notes', 'media', 'convert', 'terminal'] as const;

export type AppName = (typeof APPS)[number];
export type AppTarget = AppName | 'home';

const APP_SET: ReadonlySet<string> = new Set(APPS);

export function isAppName(value: string): value is AppName {
	return APP_SET.has(value);
}

export function stripPort(host: string): string {
	return host.trim().toLowerCase().replace(/:\d+$/, '');
}

export function isApexHost(host: string): boolean {
	const hostname = stripPort(host);
	return hostname === 'peckhamr.com' || hostname === 'www.peckhamr.com';
}

export function isLocalRootHost(host: string): boolean {
	const hostname = stripPort(host);
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isLocalDevHost(host: string): boolean {
	const hostname = stripPort(host);
	return isLocalRootHost(hostname) || hostname.endsWith('.localhost');
}

/**
 * Extracts the app subdomain from a Host header / URL.host value.
 * Recognizes `<app>.peckhamr.com` and `<app>.localhost` (with optional port).
 * Returns null for the apex (`peckhamr.com`, `www.peckhamr.com`, `localhost`),
 * multi-level subdomains, workers.dev preview hosts, and unknown hosts.
 */
export function getAppFromHost(host: string): AppName | null {
	const hostname = stripPort(host);
	if (!hostname) return null;

	let sub: string | null = null;
	if (hostname.endsWith('.peckhamr.com')) {
		sub = hostname.slice(0, -'.peckhamr.com'.length);
	} else if (hostname.endsWith('.localhost')) {
		sub = hostname.slice(0, -'.localhost'.length);
	}

	if (!sub || sub.includes('.')) return null;
	return isAppName(sub) ? sub : null;
}

/**
 * Universal SvelteKit `reroute` mapping: prefixes `/<app>` when requested on
 * `<app>.peckhamr.com` or `<app>.localhost`, idempotently leaving already-prefixed
 * `/<app>` paths and `/_app` assets untouched.
 */
export function rerouteUrl(url: URL): string {
	const app = getAppFromHost(url.host);
	if (!app) return url.pathname;

	const pathname = url.pathname || '/';
	if (pathname === '/_app' || pathname.startsWith('/_app/')) {
		return pathname;
	}
	if (pathname === `/${app}` || pathname.startsWith(`/${app}/`)) {
		return pathname;
	}
	return `/${app}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function normalizeAppPath(path = '/'): string {
	if (!path) return '/';
	return path.startsWith('/') ? path : `/${path}`;
}

function resolveCurrentUrl(currentUrl?: URL | string | null): URL | null {
	if (currentUrl instanceof URL) return currentUrl;
	if (typeof currentUrl === 'string' && currentUrl) {
		try {
			return new URL(currentUrl);
		} catch {
			return null;
		}
	}
	if (typeof window !== 'undefined' && window.location?.href) {
		try {
			return new URL(window.location.href);
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Returns a same-app relative path (`/api/lobby`) when already on `app`'s host,
 * and an absolute URL for another app (`https://<app>.peckhamr.com/...` in prod,
 * or `http://<app>.localhost:<port>/...` in local dev).
 */
export function appUrl(
	app: AppTarget,
	path = '/',
	currentUrl?: URL | string | null
): string {
	const normalized = normalizeAppPath(path);
	const loc = resolveCurrentUrl(currentUrl);

	if (loc) {
		const hostApp = getAppFromHost(loc.host);
		const onTargetHost =
			app === 'home'
				? hostApp === null && (isApexHost(loc.host) || isLocalRootHost(loc.host))
				: hostApp === app;

		if (onTargetHost) {
			return normalized;
		}

		if (isLocalDevHost(loc.host)) {
			const port = loc.port ? `:${loc.port}` : '';
			const proto = loc.protocol || 'http:';
			const targetHost = app === 'home' ? `localhost${port}` : `${app}.localhost${port}`;
			return `${proto}//${targetHost}${normalized}`;
		}
	}

	const prodHost = app === 'home' ? 'peckhamr.com' : `${app}.peckhamr.com`;
	return `https://${prodHost}${normalized}`;
}
