import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Architecture ratchet (ENGINE_ARCHITECTURE_PLAN.md section 1).
 *
 * Runtime code must not compare card names, read rules text, or mutate zones directly. Every
 * runtime .ts file under src/lib/magic is scanned; files not listed in the allowances table have an
 * allowance of 0, so new files are covered automatically. Counts must match the table exactly: going
 * up is a regression, going down means the table must be lowered in the same commit.
 */

const MAGIC_DIR = new URL('.', import.meta.url).pathname;
const ALLOWANCES_PATH = join(MAGIC_DIR, 'architecture-allowances.json');

// Files and directories that are allowed to read rules text: the compiler, card data, search and
// type definitions. Paths are relative to src/lib/magic.
const EXEMPT = [
	/^compiler\//,
	/^oracle\.ts$/,
	/^precons\.ts$/,
	/^scryfall\.ts$/,
	/^search\.ts$/,
	/^types\.ts$/,
	/\.test\.ts$/
];

const RULES: Record<string, RegExp> = {
	cardNameComparison: /\.name\s*(===|!==)\s*['"]/g,
	oracleTextRead: /oracleText/g,
	directZoneMutation: /\.(battlefield|graveyard|exile|hand|library|command)\.(push|unshift|splice)\(/g
};

// The single zone-change module (Phase 2) is the one place allowed to mutate zones directly.
const ZONE_MODULE = /^runtime\/zones\.ts$/;

function listRuntimeFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...listRuntimeFiles(full));
		} else if (entry.endsWith('.ts')) {
			const rel = relative(MAGIC_DIR, full);
			if (!EXEMPT.some((re) => re.test(rel))) out.push(rel);
		}
	}
	return out.sort();
}

function countMatches(text: string, re: RegExp): number {
	return (text.match(re) || []).length;
}

describe('Architecture ratchet', () => {
	const allowances = JSON.parse(readFileSync(ALLOWANCES_PATH, 'utf8')) as Record<
		string,
		Record<string, number>
	>;
	const files = listRuntimeFiles(MAGIC_DIR);

	for (const [rule, re] of Object.entries(RULES)) {
		it(`${rule} counts match architecture-allowances.json`, () => {
			const problems: string[] = [];
			for (const file of files) {
				if (rule === 'directZoneMutation' && ZONE_MODULE.test(file)) continue;
				const actual = countMatches(readFileSync(join(MAGIC_DIR, file), 'utf8'), re);
				const allowed = allowances[rule]?.[file] ?? 0;
				if (actual > allowed) {
					problems.push(`${file}: ${actual} > allowed ${allowed} (regression: remove the new occurrence)`);
				} else if (actual < allowed) {
					problems.push(`${file}: ${actual} < allowed ${allowed} (progress: lower the allowance to ${actual})`);
				}
			}
			for (const file of Object.keys(allowances[rule] ?? {})) {
				if (!files.includes(file)) {
					problems.push(`${file}: listed in allowances but not found (remove the entry)`);
				}
			}
			assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
		});
	}
});
