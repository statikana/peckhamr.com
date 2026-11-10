import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		allowedHosts: ['.localhost']
	},
	plugins: [
		sveltekit({
			adapter: adapter()
		})
	]
});
