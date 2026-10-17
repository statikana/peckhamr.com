import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({ adapter: adapter()// wrangler config
		// https://developers.cloudflare.com/workers/wrangler/api/#parameters-1
		// <- routes that invoke functions
		//  <- routes that don't invoke functions (static assets!)
		 })
	]
});
