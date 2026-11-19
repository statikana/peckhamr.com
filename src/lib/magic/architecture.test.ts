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

/**
 * Legacy text helpers. oracle.ts is exempt from `oracleTextRead` because it *is* the legacy text
 * parser, so runtime code calling it reads rules text indirectly. Every oracle.ts export counts as a
 * legacy text helper unless listed here; new exports are counted automatically. getCardRuleTree is the
 * text-built rule tree in ruleTree.ts.
 */
const TEXT_FREE_ORACLE_EXPORTS = new Set([
	// Mana-cost characteristic and mana-pool arithmetic: no rules text involved.
	'createEmptyManaPool',
	'getTotalManaInPool',
	'parseManaCost',
	'resolveFlexibleManaRequirement',
	'canPayManaCost',
	'deductManaFromPool',
	// Operate on an already-built LibrarySearchSpec and card characteristics.
	'matchesLibrarySearchSpec',
	'describeLibrarySearchDestination',
	// Copy text onto StackItem / DelayedTrigger for display, or write text for generated tokens.
	'withStackItemText',
	'withDelayedTriggerSpec',
	'buildTokenScryfallCard'
]);
const EXTRA_LEGACY_HELPERS = ['getCardRuleTree'];

function legacyTextHelpers(): string[] {
	const oracle = readFileSync(join(MAGIC_DIR, 'oracle.ts'), 'utf8');
	const exported = [...oracle.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
	return [...exported.filter((n) => !TEXT_FREE_ORACLE_EXPORTS.has(n)), ...EXTRA_LEGACY_HELPERS];
}

function countLegacyHelperCalls(text: string, helpers: string[]): number {
	let n = 0;
	for (const h of helpers) {
		// Calls only: skip the declaration itself.
		n += (text.match(new RegExp(`(?<!function )\\b${h}\\(`, 'g')) || []).length;
	}
	return n;
}

/**
 * Card names in code. Catches names hidden in strings, regexes and messages, which
 * `cardNameComparison` can't see. Names come from precons.ts (basic land types are rules terms).
 * Comments are ignored. Single-word names match case-sensitively so ordinary identifiers such as
 * `negate` or `opt` don't count; multi-word names match case-insensitively.
 */
const BASIC_LAND_TYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);
const RULES_KEYWORD_CARD_NAMES = new Set(['Level Up', 'Harmonize', 'Persist', 'Explore']);
const NAME_SCAN_EXTRA = [/^oracle\.ts$/, /^compiler\/(?!.*\.test\.ts$).*\.ts$/];

function preconCardNames(): string[] {
	const precons = readFileSync(join(MAGIC_DIR, 'precons.ts'), 'utf8');
	const names = new Set([...precons.matchAll(/^\tname: ['"](.+?)['"],/gm)].map((m) => m[1]));
	const archidekt = JSON.parse(readFileSync(join(MAGIC_DIR, 'precons.archidekt.json'), 'utf8')) as {
		cards?: Array<{ name?: string }>;
	};
	for (const card of archidekt.cards ?? []) {
		if (typeof card.name === 'string' && card.name.length > 0) {
			names.add(card.name);
		}
	}
	return [...names].filter((n) => !BASIC_LAND_TYPES.has(n) && !RULES_KEYWORD_CARD_NAMES.has(n));
}

function stripComments(text: string): string {
	const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
	return noBlocks
		.split('\n')
		.map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
		.join('\n');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCardNames(text: string, names: string[]): number {
	const code = stripComments(text);
	const lower = code.toLowerCase();
	let n = 0;
	for (const name of names) {
		const singleWord = /^[A-Za-z-]+$/.test(name);
		const re = singleWord
			? new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g')
			: new RegExp(escapeRegExp(name.toLowerCase()), 'g');
		n += ((singleWord ? code : lower).match(re) || []).length;
	}
	return n;
}

/**
 * Regex or substring scans over `.text` on abilities (e.g. `ab.text.match(...)`,
 * `ab.text.toLowerCase().includes(...)`, `/.../.test(ab.text)`). Display pass-throughs (`n.text`,
 * `displayAbilityText(ab.text ?? '', ...)`) are permitted; pattern matching on rules text is not.
 */
const ABILITY_TEXT_SCANS = [
	/\??\.text(?:\s*\?\?\s*['"][^'"]*['"])?(?:\??\.(?:trim|toLowerCase|toUpperCase)\(\))*\s*\??\.\s*(?:match|matchAll|search|replace|includes|startsWith|endsWith|slice|split)\(/g,
	/(?:\/(?:\\.|[^/\n])+\/[gimsuy]*|new\s+RegExp\([^)]*\))\s*\.\s*(?:test|exec)\(\s*[^)\n]*\??\.text\b/g
];

function countAbilityTextScans(text: string): number {
	const code = stripComments(text);
	let n = 0;
	for (const re of ABILITY_TEXT_SCANS) {
		n += (code.match(re) || []).length;
	}
	return n;
}

function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

const TYPE_LINE_EXEMPT = [
	...EXEMPT,
	/^runtime\/faces\.ts$/,
	/^runtime\/layers\.ts$/,
	/^runtime\/layersPredicates\.ts$/,
	/^runtime\/copyPreventionAndEffects\.ts$/
];

const RAW_TYPE_LINE_PATTERNS = [
	/\(\s*[^()\n]*\b(?:copiableCard|printedCard|card|sourceCard|foundCard|counteredCard)\s*\)\??\.typeLine\b/g,
	/\b(?:card|copiableCard|printedCard|sourceCard|foundCard|counteredCard|copiable|cardCopy|baseCardToCopy|baseCard)\??\.typeLine\b/g,
	/\bfaces\[[^\]]+\]\??\.typeLine\b/g,
	/\bfront\??\.typeLine\b/g
];

const SVELTE_TEMPLATE_RAW_TYPE_LINE_PATTERNS = [
	/\.(?:card|copiableCard|printedCard|sourceCard|foundCard|counteredCard)\??\.typeLine\b/g,
	/\(\s*[^()\n]*\b(?:copiableCard|printedCard|card|sourceCard|foundCard|counteredCard)\s*\)\??\.typeLine\b/g,
	/\bfaces\[[^\]]+\]\??\.typeLine\b/g,
	/\bfront\??\.typeLine\b/g
];

function countRawTypeLineReads(text: string, file: string): number {
	if (file.endsWith('.svelte')) {
		const noHtmlComments = stripHtmlComments(text);
		const scriptParts: string[] = [];
		const templateText = noHtmlComments.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body: string) => {
			scriptParts.push(stripComments(body));
			return '';
		});
		let n = 0;
		for (const scriptCode of scriptParts) {
			for (const re of RAW_TYPE_LINE_PATTERNS) {
				n += (scriptCode.match(re) || []).length;
			}
		}
		for (const re of SVELTE_TEMPLATE_RAW_TYPE_LINE_PATTERNS) {
			n += (templateText.match(re) || []).length;
		}
		return n;
	}
	const cleaned = stripComments(text);
	let n = 0;
	for (const re of RAW_TYPE_LINE_PATTERNS) {
		n += (cleaned.match(re) || []).length;
	}
	return n;
}

function extractMoveObjectCalls(text: string): Array<{ args: string; startIdx: number }> {
	const out: Array<{ args: string; startIdx: number }> = [];
	const re = /\bmoveObject\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const openIdx = m.index + m[0].length - 1;
		let depth = 1;
		let i = openIdx + 1;
		let quote: string | null = null;
		while (i < text.length && depth > 0) {
			const ch = text[i];
			if (quote) {
				if (ch === '\\') {
					i += 2;
					continue;
				}
				if (ch === quote) quote = null;
			} else if (ch === "'" || ch === '"' || ch === '`') {
				quote = ch;
			} else if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
			}
			i++;
		}
		if (depth === 0) {
			out.push({ args: text.slice(openIdx + 1, i - 1), startIdx: m.index });
		}
	}
	return out;
}

function countMoveObjectResetOptOuts(text: string, file: string): number {
	const code = stripComments(text);
	let violations = 0;
	for (const { args, startIdx } of extractMoveObjectCalls(code)) {
		if (/\bleaveBattlefieldReset\s*:\s*false\b/.test(args)) {
			violations++;
			continue;
		}
		if (/\b(?:bumpVersion|newTimestamp)\s*:\s*false\b/.test(args)) {
			const destMatch = args.match(/^[^,]+,\s*[^,]+,\s*(['"`])([a-z]+)\1/);
			const fromZoneMatch = args.match(/\bzone\s*:\s*(['"`])([a-z]+)\1/);
			const isSameZone = Boolean(destMatch && fromZoneMatch && destMatch[2] === fromZoneMatch[2]);
			const isMulliganRedraw =
				file === 'runtime/zones.ts' &&
				code.lastIndexOf('export function mulliganRedraw', startIdx) >
					code.lastIndexOf('\nexport function ', startIdx);
			const isPregameBotMulligan =
				file === 'engine.ts' &&
				/\bemit\s*:\s*false\b/.test(args) &&
				destMatch?.[2] === 'library' &&
				fromZoneMatch?.[2] === 'hand';
			const isPregameLondonBottom =
				file === 'runtime/turnAndPrompts.ts' &&
				destMatch?.[2] === 'library' &&
				fromZoneMatch?.[2] === 'hand' &&
				code.lastIndexOf("action.type === 'london_bottom'", startIdx) >
					code.lastIndexOf('export function ', startIdx);
			if (!isSameZone && !isMulliganRedraw && !isPregameBotMulligan && !isPregameLondonBottom) {
				violations++;
			}
		}
	}
	return violations;
}

const SCRYFALL_LEGACY_TABLES_RE = /\b(?:MULTI_COPY_CARDS|CAPPED_COPY_CARDS|BASIC_LAND_NAMES)\b/g;

function countScryfallLegacyDeckTables(text: string): number {
	return (stripComments(text).match(SCRYFALL_LEGACY_TABLES_RE) || []).length;
}

const SCRYFALL_ORACLE_SCANS = [
	/\.oracleText(?:\s*\?\?\s*['"][^'"]*['"])?(?:\.(?:trim|toLowerCase|toUpperCase)\(\))*\s*\.\s*(?:match|matchAll|search|replace|includes|startsWith|endsWith|slice|split)\(/g,
	/(?:\/(?:\\.|[^/\n])+\/[gimsuy]*|new\s+RegExp\([^)]*\))\s*\.\s*(?:test|exec)\(\s*[^)\n]*\.oracleText\b/g
];

function countScryfallOracleScans(text: string): number {
	// Permit the multi-face `\n//\n` separator split in `getCardFaces` only (strip before stripComments
	// so `//` inside the string literal isn't truncated as a JS line comment).
	const withoutFaceSplit = text.replace(/\.oracleText\.(?:includes|split)\(\s*['"]\\n\/\/\\n['"]\s*\)/g, '');
	const code = stripComments(withoutFaceSplit);
	let n = 0;
	for (const re of SCRYFALL_ORACLE_SCANS) {
		n += (code.match(re) || []).length;
	}
	return n;
}

function listFiles(dir: string, include: (rel: string) => boolean, exts: string[] = ['.ts']): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full, include, exts));
		else if (exts.some((ext) => entry.endsWith(ext)) && include(relative(MAGIC_DIR, full))) {
			out.push(relative(MAGIC_DIR, full));
		}
	}
	return out.sort();
}

describe('Architecture ratchet', () => {
	const allowances = JSON.parse(readFileSync(ALLOWANCES_PATH, 'utf8')) as Record<
		string,
		Record<string, number>
	>;
	const runtimeFiles = listRuntimeFiles(MAGIC_DIR);
	const nameScanFiles = listFiles(
		MAGIC_DIR,
		(rel) => runtimeFiles.includes(rel) || NAME_SCAN_EXTRA.some((re) => re.test(rel))
	);
	const typeLineFiles = listFiles(
		MAGIC_DIR,
		(rel) => !TYPE_LINE_EXEMPT.some((re) => re.test(rel)),
		['.ts', '.svelte']
	);
	const helpers = legacyTextHelpers();
	const names = preconCardNames();

	const checks: Array<{ rule: string; files: string[]; count: (text: string, file: string) => number }> = [
		...Object.entries(RULES).map(([rule, re]) => ({
			rule,
			files: runtimeFiles.filter((f) => !(rule === 'directZoneMutation' && ZONE_MODULE.test(f))),
			count: (text: string) => countMatches(text, re)
		})),
		{ rule: 'legacyTextHelperCall', files: runtimeFiles, count: (text) => countLegacyHelperCalls(text, helpers) },
		{ rule: 'cardNameInCode', files: nameScanFiles, count: (text) => countCardNames(text, names) },
		{ rule: 'abilityTextScan', files: runtimeFiles, count: (text) => countAbilityTextScans(text) },
		{ rule: 'rawTypeLineRead', files: typeLineFiles, count: countRawTypeLineReads },
		{ rule: 'moveObjectResetOptOut', files: runtimeFiles, count: countMoveObjectResetOptOuts },
		{ rule: 'scryfallLegacyDeckTables', files: ['scryfall.ts'], count: countScryfallLegacyDeckTables },
		{ rule: 'scryfallOracleScan', files: ['scryfall.ts'], count: countScryfallOracleScans }
	];

	it('TEXT_FREE_ORACLE_EXPORTS only lists existing oracle.ts exports', () => {
		const oracle = readFileSync(join(MAGIC_DIR, 'oracle.ts'), 'utf8');
		const stale = [...TEXT_FREE_ORACLE_EXPORTS].filter(
			(n) => !new RegExp(`^export (?:async )?(?:function|const) ${n}\\b`, 'm').test(oracle)
		);
		assert.deepEqual(stale, []);
	});

	it('no non-test runtime module in src/lib/magic/ exceeds 6,000 lines', () => {
		const runtimeTargets = listFiles(
			MAGIC_DIR,
			(rel) => (rel === 'engine.ts' || rel.startsWith('runtime/')) && !rel.endsWith('.test.ts')
		);
		const overLimit: string[] = [];
		for (const file of runtimeTargets) {
			const lineCount = readFileSync(join(MAGIC_DIR, file), 'utf8').split('\n').length - 1;
			if (lineCount > 6000) {
				overLimit.push(`${file}: ${lineCount} lines (> 6,000 limit)`);
			}
		}
		assert.deepEqual(overLimit, [], `\n${overLimit.join('\n')}`);
	});

	for (const { rule, files, count } of checks) {
		it(`${rule} counts match architecture-allowances.json`, () => {
			const problems: string[] = [];
			for (const file of files) {
				const actual = count(readFileSync(join(MAGIC_DIR, file), 'utf8'), file);
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
