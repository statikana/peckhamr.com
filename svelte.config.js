import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = { kit: { adapter: adapter({
    assets: "dist",
    pages: "dist"
}) } };

export default config;
