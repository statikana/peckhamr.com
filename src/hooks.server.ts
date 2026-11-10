import type { Handle } from '@sveltejs/kit/hooks';
import { APPS, isApexHost, stripPort } from './lib/apps.ts';

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

export const handle: Handle = async ({ event, resolve }) => {
	const redirectResponse = buildAppSubdomainRedirect(event.url, event.request.method);
	if (redirectResponse) {
		return redirectResponse;
	}
	return resolve(event);
};
