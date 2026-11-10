import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(rootDir, 'dist/magic-backend');
const outFile = resolve(outDir, 'main.mjs');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
	entryPoints: [resolve(rootDir, 'server/magic-backend/main.ts')],
	outfile: outFile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	sourcemap: true,
	logLevel: 'info',
	tsconfigRaw: {
		compilerOptions: {
			target: 'ES2024',
			strict: true
		}
	},
	alias: {
		'cloudflare:workers': resolve(rootDir, 'server/magic-backend/cloudflare-workers-stub.ts')
	}
});
