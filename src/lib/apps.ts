export const APPS = ['magic', 'cosmo', 'notes', 'media', 'convert', 'terminal'] as const;

export type AppName = (typeof APPS)[number];
export type AppTarget = AppName | 'home';

const APP_SET: ReadonlySet<string> = new Set(APPS);

export function isAppName(value: string): value is AppName {
	return APP_SET.has(value);
}

/**
 * Extracts the app subdomain from a Host header / URL.host value.
 * Recognizes `<app>.peckhamr.com` and `<app>.localhost` (with optional port).
 * Returns null for the apex (`peckhamr.com`, `www.peckhamr.com`, `localhost`),
 * multi-level subdomains, workers.dev preview hosts, and unknown hosts.
 */
export function getAppFromHost(host: string): AppName | null {
	const hostname = host.trim().toLowerCase().replace(/:\d+$/, '');
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
