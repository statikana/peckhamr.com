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

	if (action === 'search') {
		const q = (url.searchParams.get('q') || '').trim();
		if (!q) {
			return jsonResponse({ ok: true, hits: [] });
		}
		const likePattern = `%${q}%`;
		const res = await db
			.prepare(
				'SELECT path, course, title, content, updated_at FROM PublicNotes WHERE title LIKE ? OR content LIKE ? LIMIT 25'
			)
			.bind(likePattern, likePattern)
			.all<{ path: string; course: string; title: string; content: string; updated_at: number }>();

		const qLower = q.toLowerCase();
		const hits = (res.results || []).map((row) => {
			const idx = row.content.toLowerCase().indexOf(qLower);
			let snippet = '';
			if (idx !== -1) {
				const start = Math.max(0, idx - 70);
				const end = Math.min(row.content.length, idx + q.length + 110);
				snippet = (start > 0 ? '...' : '') + row.content.slice(start, end).replace(/\n+/g, ' ') + '...';
			} else {
				snippet = row.content.slice(0, 160).replace(/\n+/g, ' ') + '...';
			}
			return {
				path: row.path,
				course: row.course,
				title: row.title,
				snippet,
				updated_at: row.updated_at
			};
		});
		return jsonResponse({ ok: true, hits });
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
