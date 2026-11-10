import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './hooks.server.ts';
import { APPS } from './lib/apps.ts';

function makeEvent(urlStr: string, method = 'GET') {
	const url = new URL(urlStr);
	const request = new Request(urlStr, {
		method,
		body: method === 'POST' || method === 'PUT' ? JSON.stringify({ hello: 'world' }) : undefined
	});
	return {
		url,
		request,
		route: { id: null },
		params: {},
		locals: {},
		platform: undefined
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
