import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, getAppFromHost, rerouteUrl } from './apps.ts';
import { reroute } from '../hooks.ts';

const dummyFetch = globalThis.fetch;

describe('host -> route mapping (0.2)', () => {
	it('maps all production app subdomains to /<app>/...', () => {
		for (const app of APPS) {
			assert.equal(getAppFromHost(`${app}.peckhamr.com`), app);
			assert.equal(reroute({ url: new URL(`https://${app}.peckhamr.com/`), fetch: dummyFetch }), `/${app}/`);
			assert.equal(
				reroute({ url: new URL(`https://${app}.peckhamr.com/api/test`), fetch: dummyFetch }),
				`/${app}/api/test`
			);
		}
	});

	it('maps *.localhost dev hosts with and without ports', () => {
		assert.equal(getAppFromHost('magic.localhost:5173'), 'magic');
		assert.equal(getAppFromHost('COSMO.LOCALHOST:4173'), 'cosmo');
		assert.equal(getAppFromHost('terminal.localhost'), 'terminal');

		assert.equal(
			reroute({ url: new URL('http://magic.localhost:5173/api/lobby'), fetch: dummyFetch }),
			'/magic/api/lobby'
		);
		assert.equal(
			reroute({ url: new URL('http://notes.localhost:5173/'), fetch: dummyFetch }),
			'/notes/'
		);
	});

	it('leaves apex, www, localhost root, and unknown hosts unchanged', () => {
		for (const origin of [
			'https://peckhamr.com',
			'https://www.peckhamr.com',
			'http://localhost:5173',
			'http://127.0.0.1:8787',
			'https://peckhamr.workers.dev',
			'https://unknown.peckhamr.com',
			'https://sub.magic.peckhamr.com'
		]) {
			assert.equal(getAppFromHost(new URL(origin).host), null);
			assert.equal(reroute({ url: new URL(`${origin}/`), fetch: dummyFetch }), '/');
			assert.equal(reroute({ url: new URL(`${origin}/magic/api/lobby`), fetch: dummyFetch }), '/magic/api/lobby');
		}
	});

	it('is idempotent on already-prefixed /<app> paths without false-matching prefixes', () => {
		assert.equal(rerouteUrl(new URL('https://magic.peckhamr.com/magic')), '/magic');
		assert.equal(rerouteUrl(new URL('https://magic.peckhamr.com/magic/')), '/magic/');
		assert.equal(
			rerouteUrl(new URL('https://magic.peckhamr.com/magic/api/lobby')),
			'/magic/api/lobby'
		);
		// Must not treat /magical as already prefixed with /magic
		assert.equal(
			rerouteUrl(new URL('https://magic.peckhamr.com/magical')),
			'/magic/magical'
		);
		// Must not rewrite SvelteKit internal /_app paths
		assert.equal(
			rerouteUrl(new URL('https://magic.peckhamr.com/_app/env.js')),
			'/_app/env.js'
		);
	});

	it('maps pathnames cleanly when query strings are present on url', () => {
		const u1 = new URL('https://magic.peckhamr.com/api/auth?action=callback&provider=google');
		assert.equal(reroute({ url: u1, fetch: dummyFetch }), '/magic/api/auth');
		assert.equal(u1.search, '?action=callback&provider=google');

		const u2 = new URL('http://notes.localhost:5173/?note=quantum%2Flecture_1.md');
		assert.equal(reroute({ url: u2, fetch: dummyFetch }), '/notes/');
		assert.equal(u2.search, '?note=quantum%2Flecture_1.md');

		const u3 = new URL('https://cosmo.peckhamr.com/cosmo/api?action=download&id=abc');
		assert.equal(reroute({ url: u3, fetch: dummyFetch }), '/cosmo/api');
		assert.equal(u3.search, '?action=download&id=abc');
	});
});
