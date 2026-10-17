import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				config: undefined, // wrangler config
				platformProxy: { // https://developers.cloudflare.com/workers/wrangler/api/#parameters-1
					configPath: undefined, 
					environment: undefined,
					persist: undefined
				},
				fallback: 'plaintext',
				routes: {
					include: ['/*'], // <- routes that invoke functions
					exclude: ['<all>'] //  <- routes that don't invoke functions (static assets!)
				}
			})
		})
	]
});