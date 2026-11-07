import type { RequestHandler } from '@sveltejs/kit';
import { env as cfEnv } from 'cloudflare:workers';

export const trailingSlash = 'ignore';

// Write-role sync token (only local NixOS publisher holds this; public callers are strictly read-only GET)
const DEFAULT_SYNC_TOKEN = 'agy_notes_pub_9f8e7d6c5b4a3f2e1d0c';

function getD1(platform: App.Platform | undefined): D1Database | undefined {
	return platform?.env?.cosmo_users || (cfEnv as unknown as Env)?.cosmo_users;
}

function getSyncToken(platform: App.Platform | undefined): string {
	return (
		(platform?.env as Record<string, string> | undefined)?.NOTES_SYNC_KEY ||
		((cfEnv as unknown as Record<string, string>)?.NOTES_SYNC_KEY) ||
		DEFAULT_SYNC_TOKEN
	);
}

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Notes-Sync-Key, Authorization'
};

function jsonResponse(data: unknown, status = 200, cacheControl = 'no-store'): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': cacheControl,
			...CORS_HEADERS
		}
	});
}

async function ensureNotesSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(`
			CREATE TABLE IF NOT EXISTS PublicNotes (
				path TEXT PRIMARY KEY,
				course TEXT NOT NULL,
				title TEXT NOT NULL,
				content TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				size_bytes INTEGER DEFAULT 0,
				updated_at INTEGER NOT NULL
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS PublicNoteAssets (
				path TEXT PRIMARY KEY,
				mime_type TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				size_bytes INTEGER DEFAULT 0,
				chunk_count INTEGER DEFAULT 1,
				updated_at INTEGER NOT NULL
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS PublicNoteAssetChunks (
				asset_path TEXT NOT NULL,
				chunk_idx INTEGER NOT NULL,
				data_b64 TEXT NOT NULL,
				PRIMARY KEY (asset_path, chunk_idx)
			)
		`)
	]);
}

function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

function sanitizeClassPath(rawPath: string): string {
	const clean = rawPath.replace(/^\/+/, '').replace(/\.\.+/g, '');
	if (clean.startsWith('classes/')) {
		return clean.slice('classes/'.length);
	}
	return clean;
}

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

/**
 * PUBLIC READ-ONLY ROLE:
 * Anyone can browse the class tree, read markdown notes, search notes, and load slide/scan assets.
 */
export const GET: RequestHandler = async ({ url, platform }) => {
	const db = getD1(platform);
	if (!db) {
		return jsonResponse({ ok: false, error: 'D1 database binding not available' }, 500);
	}

	await ensureNotesSchema(db);
	const action = url.searchParams.get('action') || 'tree';

	if (action === 'tree') {
		const notesRes = await db
			.prepare(
				'SELECT path, course, title, sha256, size_bytes, updated_at FROM PublicNotes ORDER BY course ASC, path ASC'
			)
			.all();
		return jsonResponse({
			ok: true,
			role: 'read-only',
			notes: notesRes.results || []
		});
	}

	if (action === 'manifest') {
		const notesRes = await db.prepare('SELECT path, sha256 FROM PublicNotes').all<{ path: string; sha256: string }>();
		const assetsRes = await db
			.prepare('SELECT path, sha256 FROM PublicNoteAssets')
			.all<{ path: string; sha256: string }>();
		const notesMap: Record<string, string> = {};
		const assetsMap: Record<string, string> = {};
		for (const r of notesRes.results || []) notesMap[r.path] = r.sha256;
		for (const r of assetsRes.results || []) assetsMap[r.path] = r.sha256;
		return jsonResponse({ ok: true, notes: notesMap, assets: assetsMap });
	}

	if (action === 'note') {
		const reqPath = sanitizeClassPath(url.searchParams.get('path') || '');
		if (!reqPath) {
			return jsonResponse({ ok: false, error: 'Missing path parameter' }, 400);
		}
		const note = await db
			.prepare('SELECT * FROM PublicNotes WHERE path = ?')
			.bind(reqPath)
			.first<Record<string, unknown>>();
		if (!note) {
			return jsonResponse({ ok: false, error: `Note not found: ${reqPath}` }, 404);
		}
		return jsonResponse({ ok: true, role: 'read-only', note });
	}

	if (action === 'search' || action === 'ask_ai') {
		const q = (url.searchParams.get('q') || '').trim();
		const courseParam = (url.searchParams.get('course') || 'all').trim().toLowerCase();
		const contextPath = (url.searchParams.get('context_path') || '').trim();
		const contextSection = (url.searchParams.get('context_section') || '').trim();
		if (!q) {
			return jsonResponse({ ok: true, hits: [], answer_markdown: '' });
		}

		const STOPWORDS = new Set([
			'the', 'and', 'for', 'that', 'this', 'with', 'from', 'explain', 'derive', 'calculate',
			'what', 'how', 'why', 'when', 'where', 'show', 'find', 'using', 'into', 'over', 'between'
		]);
		const qLow = q.toLowerCase();
		const rawTokens = (qLow.match(/[a-z0-9_+-]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
		const expandedTokens = new Set<string>(rawTokens);
		if (qLow.includes('hong') || qLow.includes('mandel') || qLow.includes('hom')) {
			['hong', 'mandel', 'coincidence', 'splitter', 'bunching'].forEach((t) => expandedTokens.add(t));
		}
		if (qLow.includes('gauss')) {
			['gauss', 'flux', 'enclosed', 'cylindrical', 'coaxial', 'electric'].forEach((t) => expandedTokens.add(t));
		}
		if (qLow.includes('kirchhoff') || qLow.includes('rc')) {
			['kirchhoff', 'junction', 'loop', 'circuit', 'capacitor', 'resistor'].forEach((t) => expandedTokens.add(t));
		}
		if (qLow.includes('confidence') || qLow.includes('interval') || qLow.includes('variance')) {
			['confidence', 'interval', 'variance', 'chi', 'pivotal', 'student'].forEach((t) => expandedTokens.add(t));
		}
		if (qLow.includes('kennedy') || qLow.includes('helstrom') || qLow.includes('dolinar')) {
			['kennedy', 'helstrom', 'dolinar', 'receiver', 'bpsk', 'coherent'].forEach((t) => expandedTokens.add(t));
		}
		if (qLow.includes('mle') || qLow.includes('likelihood')) {
			['maximum', 'likelihood', 'estimator', 'fisher', 'unbiased'].forEach((t) => expandedTokens.add(t));
		}
		const tokens = Array.from(expandedTokens);

		const courseCodeMap: Record<string, string> = {
			quantum: 'EECS 498',
			physics: 'PHYSICS 240',
			stats: 'STATS 412',
			german: 'GERMAN 375',
			eecs280: 'EECS 280'
		};

		let targetCourse: string | null =
			courseParam && courseParam !== 'all' ? courseParam : null;
		if (!targetCourse) {
			if (/\b(498|quantum|photon|fock|squeez|homodyne|mandel|kennedy|helstrom|splitter|cavity)\b/.test(qLow)) {
				targetCourse = 'quantum';
			} else if (/\b(240|physics|gauss|coulomb|dipole|capacit|kirchhoff|faraday|ampere|biot|savart|induct|coaxial)\b/.test(qLow)) {
				targetCourse = 'physics';
			} else if (/\b(412|stats|confidence|chi-square|estimator|likelihood|mle|cramer|hypothesis|variance|t-test|anova)\b/.test(qLow)) {
				targetCourse = 'stats';
			} else if (/\b(375|german|hartmann|augsburg|gregorius)\b/.test(qLow)) {
				targetCourse = 'german';
			}
		}

		const allRes = await db
			.prepare('SELECT path, course, title, content, updated_at FROM PublicNotes')
			.all<{ path: string; course: string; title: string; content: string; updated_at: number }>();
		const rows = allRes.results || [];

		if (action === 'search') {
			const scoredNotes: Array<{
				path: string;
				course: string;
				title: string;
				snippet: string;
				updated_at: number;
				score: number;
			}> = [];
			for (const row of rows) {
				if (targetCourse && courseParam !== 'all' && row.course !== targetCourse) continue;
				const tLow = row.title.toLowerCase();
				const cLow = row.content.toLowerCase();
				let sc = 0;
				if (tLow.includes(qLow)) sc += 12;
				if (cLow.includes(qLow)) sc += 6;
				for (const tok of tokens) {
					if (tLow.includes(tok)) sc += 3;
					if (cLow.includes(tok)) sc += 1;
				}
				if (sc <= 0) continue;
				const firstTok = tokens.find((tk) => cLow.includes(tk)) || qLow;
				const idx = cLow.indexOf(firstTok);
				let snippet = '';
				if (idx !== -1) {
					const start = Math.max(0, idx - 60);
					const end = Math.min(row.content.length, idx + 150);
					snippet = (start > 0 ? '...' : '') + row.content.slice(start, end).replace(/\n+/g, ' ') + '...';
				} else {
					snippet = row.content.slice(0, 160).replace(/\n+/g, ' ') + '...';
				}
				scoredNotes.push({
					path: row.path,
					course: row.course,
					title: row.title,
					snippet,
					updated_at: row.updated_at,
					score: sc
				});
			}
			scoredNotes.sort((a, b) => b.score - a.score);
			return jsonResponse({ ok: true, hits: scoredNotes.slice(0, 20) });
		}

		// action === 'ask_ai': Full 1-Hop Topic Hub + Section-Level Hybrid RAG + Math Synthesis
		const routedTopics: Array<{
			course: string;
			course_code: string;
			slug: string;
			path: string;
			wikilink: string;
			summary: string;
			core_equations: string[];
			score: number;
		}> = [];

		const sectionHits: Array<{
			score: number;
			course: string;
			course_code: string;
			path: string;
			title: string;
			section_title: string;
			wikilink: string;
			excerpts: string[];
			formulas: string[];
			snippet: string;
			updated_at: number;
		}> = [];

		for (const row of rows) {
			if (
				row.path === 'INDEX.md' ||
				row.path === 'Home.md' ||
				row.path === 'AGENTS.md' ||
				row.path.startsWith('Auto Suite/')
			) {
				continue;
			}
			if (targetCourse && row.course !== targetCourse) continue;
			const cCode = courseCodeMap[row.course] || row.course.toUpperCase();

			// Check if this is a 1-Hop Topic Hub (`<course>/topics/<Slug>.md`)
			if (row.path.includes('/topics/')) {
				const slug = row.path.split('/').pop()?.replace(/\.md$/i, '') || row.title;
				const sumMatch = row.content.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
				const summary = sumMatch ? sumMatch[1] : row.title;
				const eqSectionMatch = row.content.match(/##\s+1\.\s+Core Equations[^\n]*\n([\s\S]*?)(?=\n##\s+|\n---\s*\n|$)/i);
				const coreEqs: string[] = [];
				if (eqSectionMatch) {
					for (const ln of eqSectionMatch[1].split('\n')) {
						const trimLn = ln.trim();
						if (trimLn.startsWith('- ')) {
							coreEqs.push(trimLn.slice(2).trim());
						}
					}
				}
				const hay = `${slug} ${row.title} ${summary} ${coreEqs.join(' ')}`.toLowerCase();
				let sc = 0;
				for (const tok of tokens) {
					if (slug.toLowerCase().includes(tok)) sc += 4;
					if (hay.includes(tok)) sc += 2;
				}
				if (sc > 0) {
					const noExt = row.path.replace(/\.md$/i, '');
					routedTopics.push({
						course: row.course,
						course_code: cCode,
						slug,
						path: row.path,
						wikilink: `[[${noExt}|${slug}]]`,
						summary,
						core_equations: coreEqs.slice(0, 3),
						score: sc
					});
				}
				continue;
			}

			// Split note into ## sections (excluding verbatim transcripts and auto-nav)
			const cleanContent = row.content
				.replace(/<!--\s*AUTO-NAV:START\s*-->[\s\S]*?<!--\s*AUTO-NAV:END\s*-->/g, '')
				.replace(/>\s*\[!quote\][\s\S]*?(?=\n[^>]|\n$)/g, '');

			const parts = cleanContent.split(/\n##\s+/);
			for (let i = 1; i < parts.length; i++) {
				const sec = parts[i];
				const nl = sec.indexOf('\n');
				const heading = (nl >= 0 ? sec.slice(0, nl) : sec).trim();
				const hLow = heading.toLowerCase();
				if (
					hLow.includes('table of contents') ||
					hLow.includes('connected class notes') ||
					hLow.includes('deep links to specific') ||
					hLow.includes('related topic modules')
				) {
					continue;
				}
				const body = (nl >= 0 ? sec.slice(nl + 1) : '').trim();
				if (!body) continue;

				const combLow = `${row.title} ${heading} ${body}`.toLowerCase();
				let sc = 0;
				for (const tok of tokens) {
					if (hLow.includes(tok)) sc += 3.5;
					if (row.title.toLowerCase().includes(tok)) sc += 2.0;
					if (combLow.includes(tok)) sc += 1.2;
				}
				if (contextPath && row.path === contextPath) {
					sc = sc > 0 ? sc * 1.85 + 4.0 : 2.5;
					if (contextSection && hLow.includes(contextSection.toLowerCase())) {
						sc += 8.0;
					}
				}
				if (row.path.includes('/homework/')) sc *= 1.12;
				if (sc <= 0) continue;

				const formulas: string[] = [];
				const fRe = /\$\$([\s\S]+?)\$\$/g;
				let m: RegExpExecArray | null;
				while ((m = fRe.exec(body)) !== null && formulas.length < 3) {
					const fStr = m[1].replace(/\s+/g, ' ').trim();
					if (fStr && fStr.length < 260) formulas.push(fStr);
				}

				const excerpts: string[] = [];
				let inMath = false;
				let inCode = false;
				for (const rLn of body.split('\n')) {
					let ln = rLn.trim();
					if (!ln) continue;
					if (ln.startsWith('```')) {
						inCode = !inCode;
						continue;
					}
					if (inCode) continue;
					if (ln.startsWith('$$')) {
						if (ln.endsWith('$$') && ln.length > 4) continue;
						inMath = !inMath;
						continue;
					}
					if (inMath) continue;
					if (ln.startsWith('![') || ln.startsWith('>') || ln.startsWith('---') || ln.startsWith('|') || ln.startsWith('<!--')) {
						continue;
					}
					ln = ln.replace(/^(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)+/, '').trim();
					if (
						!ln ||
						ln.startsWith('**Slide Type**') ||
						ln.startsWith('**Key Formulas') ||
						ln.startsWith('**Source Photo**') ||
						ln.startsWith('**Course**') ||
						ln.startsWith('**Note Hint**') ||
						ln.startsWith('**Problem Statement PDF**') ||
						ln.startsWith('**Related Course Notes') ||
						ln.endsWith(':')
					) {
						continue;
					}
					excerpts.push(ln);
					if (excerpts.length >= 3) break;
				}

				const noExt = row.path.replace(/\.md$/i, '');
				const displayH = heading
					.replace(/\$[^$]+\$/g, (mStr) => mStr.replace(/\|/g, '\\vert '))
					.replace(/[\[\]|#^]/g, '')
					.trim();
				const cleanH = heading.replace(/[\[\]|#^$]/g, '').trim();
				const stem = row.path.split('/').pop()?.replace(/\.md$/i, '') || row.title;

				sectionHits.push({
					score: sc,
					course: row.course,
					course_code: cCode,
					path: row.path,
					title: `${stem} — ${displayH}`,
					section_title: displayH,
					wikilink: `[[${noExt}#${cleanH}|${stem} — ${displayH}]]`,
					excerpts,
					formulas,
					snippet: excerpts.join(' ') || body.replace(/\n+/g, ' ').slice(0, 220),
					updated_at: row.updated_at
				});
			}
		}

		routedTopics.sort((a, b) => b.score - a.score);
		sectionHits.sort((a, b) => b.score - a.score);
		const maxSc = sectionHits.length > 0 ? sectionHits[0].score : 1;
		const topHits = sectionHits.slice(0, 5).map((h, i) => ({
			...h,
			rank: i + 1,
			score: Number((h.score / maxSc).toFixed(3))
		}));

		const primaryCode =
			routedTopics[0]?.course_code || topHits[0]?.course_code || (targetCourse ? courseCodeMap[targetCourse] : '');
		const lines: string[] = [
			`### ${primaryCode ? `[${primaryCode}] ` : ''}Local Vault AI Synthesis: ${q}`,
			''
		];

		if (contextPath) {
			const ctxStem = contextPath.split('/').pop()?.replace(/\.md$/i, '') || contextPath;
			const ctxNoExt = contextPath.replace(/\.md$/i, '');
			const ctxWl = contextSection
				? `[[${ctxNoExt}#${contextSection.replace(/[\[\]|#^$]/g, '').trim()}|${ctxStem} — ${contextSection}]]`
				: `[[${ctxNoExt}|${ctxStem}]]`;
			lines.push(`- **Active Class Material Context**: ${ctxWl}`, '');
		}

		if (routedTopics.length > 0) {
			const tm = routedTopics[0];
			lines.push('#### 1. 1-Hop Topic Hub & Core Principles');
			lines.push(`- **Primary Topic Module**: ${tm.wikilink} (\`${tm.course_code}\`)`);
			lines.push(`- **Concept Scope**: ${tm.summary}`);
			if (routedTopics.length > 1) {
				lines.push(
					`- **Related Topic Modules**: ${routedTopics
						.slice(1, 3)
						.map((t) => t.wikilink)
						.join(' · ')}`
				);
			}
			if (tm.core_equations.length > 0) {
				lines.push('', '**Canonical Topic Equations**:');
				for (const eq of tm.core_equations) {
					lines.push(`- ${eq}`);
				}
			}
			lines.push('');
		}

		if (topHits.length > 0) {
			lines.push('#### 2. Key Derivations, Slides & Worked Solutions from Vault', '');
			const seenFormulas = new Set<string>();
			topHits.slice(0, 4).forEach((h, idx) => {
				lines.push(`**${idx + 1}. \`${h.course_code}\` — ${h.wikilink}** (Score: \`${h.score.toFixed(3)}\`)`);
				for (const ex of h.excerpts.slice(0, 3)) {
					lines.push(`- ${ex}`);
				}
				for (const fStr of h.formulas.slice(0, 2)) {
					const normF = fStr.replace(/\s+/g, '');
					if (!seenFormulas.has(normF)) {
						seenFormulas.add(normF);
						lines.push('$$', fStr, '$$');
					}
				}
				lines.push('');
			});
		} else {
			lines.push('No matching sections were found in the vault for this query.');
		}

		return jsonResponse({
			ok: true,
			query: q,
			course_filter: targetCourse || 'all',
			routed_topics: routedTopics.slice(0, 3),
			answer_markdown: lines.join('\n').trim(),
			hits: topHits
		});
	}

	if (action === 'asset') {
		const reqPath = sanitizeClassPath(url.searchParams.get('path') || '');
		if (!reqPath) {
			return jsonResponse({ ok: false, error: 'Missing asset path' }, 400);
		}
		const meta = await db
			.prepare('SELECT * FROM PublicNoteAssets WHERE path = ?')
			.bind(reqPath)
			.first<{ path: string; mime_type: string; sha256: string }>();
		if (!meta) {
			return jsonResponse({ ok: false, error: `Asset not found: ${reqPath}` }, 404);
		}
		const chunksRes = await db
			.prepare(
				'SELECT chunk_idx, data_b64 FROM PublicNoteAssetChunks WHERE asset_path = ? ORDER BY chunk_idx ASC'
			)
			.bind(reqPath)
			.all<{ chunk_idx: number; data_b64: string }>();
		const fullB64 = (chunksRes.results || []).map((c) => c.data_b64).join('');
		const bytes = base64ToUint8Array(fullB64);
		return new Response(bytes, {
			status: 200,
			headers: {
				'Content-Type': meta.mime_type || 'image/webp',
				'Cache-Control': 'public, max-age=86400, immutable',
				ETag: `"${meta.sha256}"`,
				...CORS_HEADERS
			}
		});
	}

	return jsonResponse({ ok: false, error: `Unknown GET action: ${action}` }, 400);
};

/**
 * PUBLISHER WRITE ROLE:
 * Protected by X-Notes-Sync-Key / Bearer token. Public callers cannot mutate notes.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = getD1(platform);
	if (!db) {
		return jsonResponse({ ok: false, error: 'D1 database binding not available' }, 500);
	}

	const expectedKey = getSyncToken(platform);
	const headerKey =
		request.headers.get('x-notes-sync-key') ||
		(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

	if (!headerKey || headerKey !== expectedKey) {
		return jsonResponse(
			{ ok: false, error: 'Forbidden: Public role is read-only. Valid X-Notes-Sync-Key required.' },
			403
		);
	}

	await ensureNotesSchema(db);
	const body = (await request.json()) as Record<string, any>;
	const action = String(body.action || '');
	const now = Date.now();

	if (action === 'upsert_note') {
		const path = sanitizeClassPath(String(body.path || ''));
		const course = String(body.course || path.split('/')[0] || 'general');
		const title = String(body.title || path.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled');
		const content = String(body.content || '');
		const sha256 = String(body.sha256 || '');
		const sizeBytes = Number(body.size_bytes || content.length);

		if (!path || !path.endsWith('.md')) {
			return jsonResponse({ ok: false, error: 'Invalid markdown note path' }, 400);
		}

		await db
			.prepare(
				`INSERT INTO PublicNotes (path, course, title, content, sha256, size_bytes, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   course = excluded.course,
				   title = excluded.title,
				   content = excluded.content,
				   sha256 = excluded.sha256,
				   size_bytes = excluded.size_bytes,
				   updated_at = excluded.updated_at`
			)
			.bind(path, course, title, content, sha256, sizeBytes, now)
			.run();

		return jsonResponse({ ok: true, path, sha256 });
	}

	if (action === 'upsert_asset') {
		const path = sanitizeClassPath(String(body.path || ''));
		const mimeType = String(body.mime_type || 'image/webp');
		const sha256 = String(body.sha256 || '');
		let b64 = String(body.data_b64 || '');
		const commaIdx = b64.indexOf(',');
		if (b64.startsWith('data:') && commaIdx !== -1) {
			b64 = b64.slice(commaIdx + 1);
		}
		const sizeBytes = Number(body.size_bytes || Math.floor((b64.length * 3) / 4));
		if (!path || !b64) {
			return jsonResponse({ ok: false, error: 'Missing asset path or data_b64' }, 400);
		}

		const chunkSize = 380_000;
		const chunks: string[] = [];
		for (let i = 0; i < b64.length; i += chunkSize) {
			chunks.push(b64.slice(i, i + chunkSize));
		}

		const stmts: D1PreparedStatement[] = [
			db.prepare('DELETE FROM PublicNoteAssetChunks WHERE asset_path = ?').bind(path),
			db
				.prepare(
					`INSERT INTO PublicNoteAssets (path, mime_type, sha256, size_bytes, chunk_count, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(path) DO UPDATE SET
					   mime_type = excluded.mime_type,
					   sha256 = excluded.sha256,
					   size_bytes = excluded.size_bytes,
					   chunk_count = excluded.chunk_count,
					   updated_at = excluded.updated_at`
				)
				.bind(path, mimeType, sha256, sizeBytes, chunks.length, now)
		];

		for (let idx = 0; idx < chunks.length; idx++) {
			stmts.push(
				db
					.prepare('INSERT INTO PublicNoteAssetChunks (asset_path, chunk_idx, data_b64) VALUES (?, ?, ?)')
					.bind(path, idx, chunks[idx])
			);
		}

		await db.batch(stmts);
		return jsonResponse({ ok: true, path, chunks: chunks.length, sha256 });
	}

	if (action === 'delete_note') {
		const path = sanitizeClassPath(String(body.path || ''));
		await db.prepare('DELETE FROM PublicNotes WHERE path = ?').bind(path).run();
		return jsonResponse({ ok: true, deleted: path });
	}

	if (action === 'prune') {
		const validNotePaths = new Set<string>(body.valid_notes || []);
		const validAssetPaths = new Set<string>(body.valid_assets || []);
		const existingNotes = await db.prepare('SELECT path FROM PublicNotes').all<{ path: string }>();
		for (const r of existingNotes.results || []) {
			if (!validNotePaths.has(r.path)) {
				await db.prepare('DELETE FROM PublicNotes WHERE path = ?').bind(r.path).run();
			}
		}
		const existingAssets = await db.prepare('SELECT path FROM PublicNoteAssets').all<{ path: string }>();
		for (const r of existingAssets.results || []) {
			if (!validAssetPaths.has(r.path)) {
				await db.batch([
					db.prepare('DELETE FROM PublicNoteAssetChunks WHERE asset_path = ?').bind(r.path),
					db.prepare('DELETE FROM PublicNoteAssets WHERE path = ?').bind(r.path)
				]);
			}
		}
		return jsonResponse({ ok: true });
	}

	return jsonResponse({ ok: false, error: `Unknown POST action: ${action}` }, 400);
};
