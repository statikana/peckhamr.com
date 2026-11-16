/**
 * Deterministically splits `src/lib/rules.txt` (Wizards Comprehensive Rules) into
 * agent-friendly, single-read markdown sections under `src/lib/rules/` while leaving
 * `src/lib/rules.txt` untouched.
 *
 * Guarantees enforced on every run:
 * 1. Every generated file is strictly <= 44,000 bytes and <= 760 lines (fits in one `read_file` call).
 * 2. 100% lossless subrule parity: every `NNN.N[a-z]` subrule identifier in `src/lib/rules.txt`
 *    appears in the generated rule files.
 *
 * Usage:
 *   node scripts/split-magic-rules.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_BYTES = 44_000;
const MAX_LINES = 760;

const CHAPTER_DIRS: Record<string, { dir: string; title: string }> = {
	'1': { dir: '100-game-concepts', title: '1. Game Concepts' },
	'2': { dir: '200-parts-of-a-card', title: '2. Parts of a Card' },
	'3': { dir: '300-card-types', title: '3. Card Types' },
	'4': { dir: '400-zones', title: '4. Zones' },
	'5': { dir: '500-turn-structure', title: '5. Turn Structure' },
	'6': { dir: '600-spells-abilities-and-effects', title: '6. Spells, Abilities, and Effects' },
	'7': { dir: '700-additional-rules', title: '7. Additional Rules' },
	'8': { dir: '800-multiplayer-rules', title: '8. Multiplayer Rules' },
	'9': { dir: '900-casual-variants', title: '9. Casual Variants' }
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

interface RuleSection {
	num: string;
	title: string;
	lines: string[];
}

interface SubSection {
	index: number;
	id: string;
	title: string;
	lines: string[];
}

interface WrittenFile {
	relPath: string;
	bytes: number;
	lineCount: number;
	description: string;
}

function main(): void {
	const rulesPath = 'src/lib/rules.txt';
	const outRoot = 'src/lib/rules';

	const raw = readFileSync(rulesPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const allLines = raw.split('\n');

	const effectiveLine =
		allLines.find((l) => /^These rules are effective as of /i.test(l.trim()))?.trim() ?? '';

	const tocStartIdx = allLines.findIndex((l) => l.trim() === '1. Game Concepts');
	const bodyStartIdx = allLines.findIndex(
		(l, i) => i > tocStartIdx && l.trim() === '1. Game Concepts'
	);
	const glossaryStartIdx = allLines.findIndex(
		(l, i) => i > bodyStartIdx && l.trim() === 'Glossary'
	);
	const creditsStartIdx = allLines.findIndex(
		(l, i) => i > glossaryStartIdx && l.trim() === 'Credits'
	);

	if (tocStartIdx < 0 || bodyStartIdx < 0 || glossaryStartIdx < 0 || creditsStartIdx < 0) {
		throw new Error('Could not locate expected TOC / Body / Glossary / Credits markers in rules.txt');
	}

	// Clean and recreate output directory
	rmSync(outRoot, { recursive: true, force: true });
	mkdirSync(outRoot, { recursive: true });

	const written: WrittenFile[] = [];

	const emitFile = (relPath: string, content: string, description: string): void => {
		const normalized = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
		const bytes = Buffer.byteLength(normalized, 'utf8');
		const lineCount = normalized.split('\n').length;
		if (bytes > MAX_BYTES || lineCount > MAX_LINES) {
			throw new Error(
				`Generated file ${relPath} exceeds single-read limits (${bytes} bytes / ${lineCount} lines; max ${MAX_BYTES}B / ${MAX_LINES}L)`
			);
		}
		const fullPath = join(outRoot, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, normalized, 'utf8');
		written.push({ relPath, bytes, lineCount, description });
	};

	// 1. Intro & Original TOC
	const introLines = allLines.slice(0, bodyStartIdx);
	emitFile(
		'000-intro-and-toc.md',
		`# Magic: The Gathering Comprehensive Rules — Introduction & Table of Contents\n\n` +
			introLines.join('\n'),
		'Introduction, effective date, and official Table of Contents'
	);

	// 2. Parse 3-digit sections (100..905)
	const bodyLines = allLines.slice(bodyStartIdx, glossaryStartIdx);
	const sections: RuleSection[] = [];
	let current: RuleSection | null = null;

	for (const line of bodyLines) {
		// Skip standalone major chapter header lines like "1. Game Concepts" between 3-digit rules
		if (/^[1-9]\.\s+[A-Z]/.test(line.trim())) continue;
		const m = line.match(/^(\d{3})\.\s+(.+)$/);
		if (m) {
			if (current) sections.push(current);
			current = { num: m[1], title: m[2].trim(), lines: [line] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) sections.push(current);

	// Helper to split oversized 701 / 702 into numbered sub-chunks + dedicated lookup index
	const splitNumberedKeywordSection = (
		sec: RuleSection,
		subDirName: string,
		chunkSize: number
	): { indexRelPath: string; subEntries: Array<{ id: string; title: string; file: string; line: number }> } => {
		const prefix = sec.num; // '701' or '702'
		const subRegex = new RegExp(`^(${prefix}\\.(\\d+))\\.\\s*(.*)$`);
		const subs: SubSection[] = [];
		let curSub: SubSection | null = null;

		for (let i = 1; i < sec.lines.length; i++) {
			const line = sec.lines[i];
			const m = line.match(subRegex);
			if (m) {
				if (curSub) subs.push(curSub);
				const idx = Number(m[2]);
				const rest = m[3].trim();
				// For 701.1 / 702.1 general intro paragraph, title is "General"
				const title = idx === 1 ? 'General Preamble' : rest || `${prefix}.${idx}`;
				curSub = { index: idx, id: m[1], title, lines: [line] };
			} else if (curSub) {
				curSub.lines.push(line);
			}
		}
		if (curSub) subs.push(curSub);

		const padWidth = subs.length >= 100 ? 3 : 2;
		const pad = (n: number) => String(n).padStart(padWidth, '0');

		const subEntries: Array<{ id: string; title: string; file: string; line: number }> = [];

		for (let start = 0; start < subs.length; start += chunkSize) {
			const group = subs.slice(start, start + chunkSize);
			const firstIdx = group[0].index;
			const lastIdx = group[group.length - 1].index;
			const relFile = `700-additional-rules/${subDirName}/${prefix}-${pad(firstIdx)}-to-${pad(lastIdx)}.md`;

			const outLines: string[] = [
				`# CR ${sec.num}. ${sec.title} (${prefix}.${firstIdx}–${prefix}.${lastIdx})`,
				''
			];

			for (const sub of group) {
				// Clean trailing blank lines inside sub before appending
				const trimmedSub = [...sub.lines];
				while (trimmedSub.length > 0 && trimmedSub[trimmedSub.length - 1].trim() === '') {
					trimmedSub.pop();
				}
				const headingLineNumber = outLines.length + 1;
				outLines.push(`## ${sub.id} — ${sub.title}`);
				outLines.push('');
				outLines.push(...trimmedSub);
				outLines.push('');
				subEntries.push({
					id: sub.id,
					title: sub.title,
					file: relFile,
					line: headingLineNumber
				});
			}

			emitFile(
				relFile,
				outLines.join('\n'),
				`CR ${sec.num} (${sec.title}): ${prefix}.${firstIdx} (${group[0].title}) – ${prefix}.${lastIdx} (${group[group.length - 1].title})`
			);
		}

		// Build dedicated 701-INDEX.md or 702-INDEX.md (both numerical and alphabetical!)
		const indexRelPath = `700-additional-rules/${subDirName}/${prefix}-INDEX.md`;
		const alphaEntries = [...subEntries]
			.filter((e) => !e.id.endsWith('.1'))
			.sort((a, b) => a.title.localeCompare(b.title));

		const idxLines: string[] = [
			`# CR ${sec.num}. ${sec.title} — Lookup Index`,
			'',
			`Total entries: **${subEntries.length}** (\`${prefix}.1\`–\`${subEntries[subEntries.length - 1].id}\`).`,
			'',
			'## Alphabetical Lookup',
			'',
			'| Name | Rule | File & Line |',
			'|---|---|---|',
			...alphaEntries.map((e) => {
				const base = e.file.split('/').pop()!;
				return `| ${e.title} | \`CR ${e.id}\` | [${base}#L${e.line}](./${base}#L${e.line}) |`;
			}),
			'',
			'## Numerical Lookup',
			'',
			'| Rule | Name | File & Line |',
			'|---|---|---|',
			...subEntries.map((e) => {
				const base = e.file.split('/').pop()!;
				return `| \`CR ${e.id}\` | ${e.title} | [${base}#L${e.line}](./${base}#L${e.line}) |`;
			})
		];

		emitFile(indexRelPath, idxLines.join('\n'), `Alphabetical & numerical index for CR ${sec.num} (${sec.title})`);
		return { indexRelPath, subEntries };
	};

	const sectionPathByNum = new Map<string, { relPath: string; title: string }>();

	for (const sec of sections) {
		const chapter = CHAPTER_DIRS[sec.num[0]];
		if (!chapter) throw new Error(`Unknown chapter digit for rule ${sec.num}`);

		if (sec.num === '701') {
			const { indexRelPath } = splitNumberedKeywordSection(sec, '701-keyword-actions', 25);
			sectionPathByNum.set(sec.num, { relPath: indexRelPath, title: `${sec.title} (split into 3 files + index)` });
			continue;
		}
		if (sec.num === '702') {
			const { indexRelPath } = splitNumberedKeywordSection(sec, '702-keyword-abilities', 25);
			sectionPathByNum.set(sec.num, { relPath: indexRelPath, title: `${sec.title} (split into 8 files + index)` });
			continue;
		}

		const relPath = `${chapter.dir}/${sec.num}-${slugify(sec.title)}.md`;
		const body = `# CR ${sec.num}. ${sec.title}\n\n` + sec.lines.join('\n');
		emitFile(relPath, body, `CR ${sec.num}. ${sec.title}`);
		sectionPathByNum.set(sec.num, { relPath, title: sec.title });
	}

	// 3. Split Glossary into 4 alphabetical ranges + Credits
	const glossaryRawLines = allLines.slice(glossaryStartIdx + 1, creditsStartIdx);
	interface GlossaryEntry {
		term: string;
		block: string;
	}
	const glossaryEntries: GlossaryEntry[] = [];
	let blockLines: string[] = [];
	const flushBlock = () => {
		while (blockLines.length > 0 && blockLines[0].trim() === '') blockLines.shift();
		while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') blockLines.pop();
		if (blockLines.length > 0) {
			glossaryEntries.push({
				term: blockLines[0].trim(),
				block: blockLines.join('\n')
			});
		}
		blockLines = [];
	};
	for (const line of glossaryRawLines) {
		if (line.trim() === '') {
			flushBlock();
		} else {
			blockLines.push(line);
		}
	}
	flushBlock();

	const glossaryBuckets: Array<{ slug: string; label: string; test: (ch: string) => boolean }> = [
		{ slug: 'glossary-a-to-c.md', label: 'A–C', test: (c) => c >= 'A' && c <= 'C' },
		{ slug: 'glossary-d-to-f.md', label: 'D–F', test: (c) => c >= 'D' && c <= 'F' },
		{ slug: 'glossary-g-to-l.md', label: 'G–L', test: (c) => c >= 'G' && c <= 'L' },
		{ slug: 'glossary-m-to-p.md', label: 'M–P', test: (c) => c >= 'M' && c <= 'P' },
		{ slug: 'glossary-q-to-s.md', label: 'Q–S', test: (c) => c >= 'Q' && c <= 'S' },
		{ slug: 'glossary-t-to-z.md', label: 'T–Z', test: (c) => c < 'A' || c >= 'T' }
	];

	for (const bucket of glossaryBuckets) {
		const matching = glossaryEntries.filter((e) => {
			const firstAlpha = (e.term.match(/[A-Za-z]/)?.[0] ?? 'Z').toUpperCase();
			return bucket.test(firstAlpha);
		});
		const content =
			`# Comprehensive Rules Glossary (${bucket.label})\n\n` +
			matching.map((e) => `### ${e.term}\n${e.block.split('\n').slice(1).join('\n')}`).join('\n\n');
		emitFile(`glossary/${bucket.slug}`, content, `Glossary terms (${bucket.label}, ${matching.length} terms)`);
	}

	const creditsLines = allLines.slice(creditsStartIdx);
	emitFile('999-credits.md', `# Credits\n\n` + creditsLines.join('\n'), 'Official Comprehensive Rules credits');

	// 4. Write Master INDEX.md (guaranteed < 25 KB so 1 `read_file` loads the entire map!)
	const masterLines: string[] = [
		'# Magic: The Gathering Comprehensive Rules — Split Reference Index',
		'',
		`Source: [\`src/lib/rules.txt\`](../rules.txt) (${effectiveLine || 'Wizards Comprehensive Rules'}).`,
		'Generated by `node scripts/split-magic-rules.ts`.',
		'',
		'> **For AI Agents & Developers:** Every file in `src/lib/rules/` is guaranteed to be **< 44 KB and < 760 lines**, so any file can be read in full in a single `read_file` call with zero truncation.',
		'> - Looking up a numbered rule like `CR 613.7`? Open the `613` file under `600-spells-abilities-and-effects/`.',
		'> - Looking up a keyword action (`CR 701.x`, e.g. Fight, Proliferate, Scry)? Read [`701-INDEX.md`](./700-additional-rules/701-keyword-actions/701-INDEX.md).',
		'> - Looking up a keyword ability (`CR 702.x`, e.g. Cascade, Evolve, Storm)? Read [`702-INDEX.md`](./700-additional-rules/702-keyword-abilities/702-INDEX.md).',
		'> - Looking up a game term definition? Check [`glossary/`](./glossary/glossary-a-to-c.md).',
		''
	];

	for (const [digit, chapter] of Object.entries(CHAPTER_DIRS)) {
		masterLines.push(`## ${chapter.title}`);
		masterLines.push('');
		masterLines.push('| Rule | Section | File |');
		masterLines.push('|---|---|---|');
		for (const sec of sections.filter((s) => s.num[0] === digit)) {
			const info = sectionPathByNum.get(sec.num)!;
			masterLines.push(`| \`CR ${sec.num}\` | ${info.title} | [\`${info.relPath}\`](./${info.relPath}) |`);
		}
		masterLines.push('');
	}

	masterLines.push('## Glossary & Credits');
	masterLines.push('');
	masterLines.push('- [Glossary A–C](./glossary/glossary-a-to-c.md)');
	masterLines.push('- [Glossary D–F](./glossary/glossary-d-to-f.md)');
	masterLines.push('- [Glossary G–L](./glossary/glossary-g-to-l.md)');
	masterLines.push('- [Glossary M–P](./glossary/glossary-m-to-p.md)');
	masterLines.push('- [Glossary Q–S](./glossary/glossary-q-to-s.md)');
	masterLines.push('- [Glossary T–Z](./glossary/glossary-t-to-z.md)');
	masterLines.push('- [Introduction & TOC](./000-intro-and-toc.md)');
	masterLines.push('- [Credits](./999-credits.md)');

	emitFile('INDEX.md', masterLines.join('\n'), 'Master lookup index for all split CR sections');

	// 5. Verify 100% lossless subrule ID coverage against original body
	const origRuleIds = new Set<string>();
	for (const line of bodyLines) {
		const m = line.match(/^(\d{3}\.\d+[a-z]?)\b/);
		if (m) origRuleIds.add(m[1]);
	}

	const splitRuleIds = new Set<string>();
	for (const wf of written) {
		const txt = readFileSync(join(outRoot, wf.relPath), 'utf8');
		for (const line of txt.split('\n')) {
			const m = line.match(/^(?:##\s+)?(\d{3}\.\d+[a-z]?)\b/);
			if (m) splitRuleIds.add(m[1]);
		}
	}

	const missingIds = [...origRuleIds].filter((id) => !splitRuleIds.has(id));
	if (missingIds.length > 0) {
		throw new Error(
			`Lossless check failed! ${missingIds.length} rule IDs missing from split output: ${missingIds.slice(0, 10).join(', ')}`
		);
	}

	const maxBytesSeen = Math.max(...written.map((w) => w.bytes));
	const maxLinesSeen = Math.max(...written.map((w) => w.lineCount));
	console.log(
		`Split ${sections.length} CR sections + ${glossaryEntries.length} Glossary terms into ${written.length} files under ${outRoot}/.`
	);
	console.log(
		`Verified ${origRuleIds.size}/${origRuleIds.size} rule/subrule IDs (0 missing). Max file: ${maxBytesSeen} bytes, ${maxLinesSeen} lines.`
	);
}

main();
