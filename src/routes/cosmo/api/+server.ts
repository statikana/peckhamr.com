import type { RequestHandler } from '@sveltejs/kit';
import { env as cfEnv } from 'cloudflare:workers';

export const trailingSlash = 'ignore';

function getD1(platform: App.Platform | undefined): D1Database | undefined {
	return platform?.env?.cosmo_users || (cfEnv as unknown as Env)?.cosmo_users;
}

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Course, X-Category, X-Auto-Route, X-Auth-Key'
};

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...CORS_HEADERS
		}
	});
}

async function ensureSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(`
			CREATE TABLE IF NOT EXISTS CosmoDeviceState (
				key TEXT PRIMARY KEY,
				value TEXT,
				updated_at INTEGER
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS CosmoDrops (
				id TEXT PRIMARY KEY,
				filename TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				category TEXT DEFAULT 'note_photo',
				course_hint TEXT DEFAULT 'auto',
				auto_route INTEGER DEFAULT 1,
				note_text TEXT DEFAULT '',
				size_bytes INTEGER DEFAULT 0,
				chunk_count INTEGER DEFAULT 0,
				status TEXT DEFAULT 'queued',
				routed_to TEXT DEFAULT '',
				badge TEXT DEFAULT '',
				summary TEXT DEFAULT '',
				created_at INTEGER NOT NULL,
				synced_at INTEGER DEFAULT 0
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS CosmoChunks (
				drop_id TEXT NOT NULL,
				chunk_idx INTEGER NOT NULL,
				data_b64 TEXT NOT NULL,
				PRIMARY KEY (drop_id, chunk_idx)
			)
		`)
	]);
}

async function getDeviceState(db: D1Database): Promise<Record<string, string>> {
	const { results } = await db
		.prepare('SELECT key, value, updated_at FROM CosmoDeviceState')
		.all<{ key: string; value: string; updated_at: number }>();
	const map: Record<string, string> = {};
	for (const r of results || []) {
		map[r.key] = r.value;
		map[`${r.key}_updated_at`] = String(r.updated_at || 0);
	}
	return map;
}

async function setDeviceKey(db: D1Database, key: string, value: string, now: number): Promise<void> {
	await db
		.prepare(
			'INSERT INTO CosmoDeviceState (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
		)
		.bind(key, value, now)
		.run();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async ({ url, platform }) => {
	const db = getD1(platform);
	if (!db) {
		return jsonResponse({ ok: false, error: 'D1 database binding cosmo_users not available' }, 500);
	}

	await ensureSchema(db);
	const action = url.searchParams.get('action') || 'state';
	const now = Date.now();

	if (action === 'download') {
		const id = url.searchParams.get('id') || '';
		const format = url.searchParams.get('format') || 'binary';
		const drop = await db
			.prepare('SELECT * FROM CosmoDrops WHERE id = ?')
			.bind(id)
			.first<Record<string, unknown>>();
		if (!drop) {
			return jsonResponse({ ok: false, error: 'Drop not found' }, 404);
		}
		const chunksRes = await db
			.prepare('SELECT chunk_idx, data_b64 FROM CosmoChunks WHERE drop_id = ? ORDER BY chunk_idx ASC')
			.bind(id)
			.all<{ chunk_idx: number; data_b64: string }>();
		const fullB64 = (chunksRes.results || []).map((c) => c.data_b64).join('');

		if (format === 'json') {
			return jsonResponse({ ok: true, drop, data_b64: fullB64 });
		}

		const bytes = base64ToUint8Array(fullB64);
		return new Response(bytes, {
			status: 200,
			headers: {
				'Content-Type': String(drop.mime_type || 'application/octet-stream'),
				'Content-Disposition': `inline; filename="${encodeURIComponent(String(drop.filename || 'file'))}"`,
				'Cache-Control': 'private, max-age=3600',
				...CORS_HEADERS
			}
		});
	}

	const dev = await getDeviceState(db);
	const lastHb = Number(dev.last_heartbeat || 0);
	const isOnline = now - lastHb < 45_000;

	if (action === 'pending') {
		const pending = await db
			.prepare("SELECT * FROM CosmoDrops WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20")
			.all();
		return jsonResponse({
			ok: true,
			pending: pending.results || [],
			shared_clipboard: dev.shared_clipboard || '',
			clipboard_source: dev.clipboard_source || '',
			clipboard_updated_at: Number(dev.shared_clipboard_updated_at || 0)
		});
	}

	const dropsRes = await db
		.prepare('SELECT * FROM CosmoDrops ORDER BY created_at DESC LIMIT 30')
		.all();

	return jsonResponse({
		ok: true,
		now,
		device: {
			online: isOnline,
			last_heartbeat: lastHb,
			tunnel_url: dev.tunnel_url || '',
			gpu_status: dev.gpu_status || 'RTX A2000 8GB Ready',
			hostname: dev.hostname || 'ryan-nixos',
			shared_clipboard: dev.shared_clipboard || '',
			clipboard_source: dev.clipboard_source || '',
			clipboard_updated_at: Number(dev.shared_clipboard_updated_at || 0)
		},
		drops: dropsRes.results || []
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const db = getD1(platform);
	if (!db) {
		return jsonResponse({ ok: false, error: 'D1 database binding cosmo_users not available' }, 500);
	}

	await ensureSchema(db);
	const now = Date.now();
	const contentType = (request.headers.get('content-type') || '').toLowerCase();

	// Support raw binary POST (e.g. from iOS Shortcuts or direct fetch)
	if (!contentType.includes('application/json')) {
		const rawFname = request.headers.get('x-filename') || `upload_${now}.jpg`;
		const filename = decodeURIComponent(rawFname);
		const courseHint = request.headers.get('x-course') || 'auto';
		const category = request.headers.get('x-category') || 'note_photo';
		const autoRoute = request.headers.get('x-auto-route') === '0' ? 0 : 1;
		const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';

		const buf = await request.arrayBuffer();
		const b64 = arrayBufferToBase64(buf);
		return await storeDrop(db, {
			filename,
			mimeType,
			category,
			courseHint,
			autoRoute,
			noteText: '',
			b64,
			sizeBytes: buf.byteLength,
			now
		});
	}

	const body = (await request.json()) as Record<string, any>;
	const action = String(body.action || 'upload');

	if (action === 'heartbeat') {
		if (typeof body.tunnel_url === 'string') {
			await setDeviceKey(db, 'tunnel_url', body.tunnel_url, now);
		}
		if (typeof body.gpu_status === 'string') {
			await setDeviceKey(db, 'gpu_status', body.gpu_status, now);
		}
		if (typeof body.hostname === 'string') {
			await setDeviceKey(db, 'hostname', body.hostname, now);
		}
		await setDeviceKey(db, 'last_heartbeat', String(now), now);

		const dev = await getDeviceState(db);
		const pending = await db
			.prepare("SELECT * FROM CosmoDrops WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20")
			.all();

		return jsonResponse({
			ok: true,
			now,
			pending: pending.results || [],
			shared_clipboard: dev.shared_clipboard || '',
			clipboard_source: dev.clipboard_source || '',
			clipboard_updated_at: Number(dev.shared_clipboard_updated_at || 0)
		});
	}

	if (action === 'clipboard') {
		const text = String(body.text || '');
		const source = String(body.source || 'phone');
		await setDeviceKey(db, 'shared_clipboard', text, now);
		await setDeviceKey(db, 'clipboard_source', source, now);
		return jsonResponse({ ok: true, shared_clipboard: text, clipboard_source: source, updated_at: now });
	}

	if (action === 'ack') {
		const id = String(body.id || '');
		const status = String(body.status || 'synced');
		const routedTo = String(body.routed_to || '');
		const badge = String(body.badge || '');
		const summary = String(body.summary || '');
		await db
			.prepare(
				'UPDATE CosmoDrops SET status = ?, synced_at = ?, routed_to = COALESCE(NULLIF(?, \'\'), routed_to), badge = COALESCE(NULLIF(?, \'\'), badge), summary = COALESCE(NULLIF(?, \'\'), summary) WHERE id = ?'
			)
			.bind(status, now, routedTo, badge, summary, id)
			.run();

		if (body.clear_chunks) {
			await db.prepare('DELETE FROM CosmoChunks WHERE drop_id = ?').bind(id).run();
		}
		return jsonResponse({ ok: true, id, status });
	}

	if (action === 'delete') {
		const id = String(body.id || '');
		await db.batch([
			db.prepare('DELETE FROM CosmoChunks WHERE drop_id = ?').bind(id),
			db.prepare('DELETE FROM CosmoDrops WHERE id = ?').bind(id)
		]);
		return jsonResponse({ ok: true, deleted: id });
	}

	// Default action: 'upload'
	const filename = String(body.filename || `note_${now}.jpg`);
	const mimeType = String(body.mime_type || 'image/jpeg');
	const category = String(body.category || 'note_photo');
	const courseHint = String(body.course_hint || 'auto');
	const autoRoute = body.auto_route === false || body.auto_route === 0 ? 0 : 1;
	const noteText = String(body.note_text || '');
	let b64 = String(body.data_b64 || '');
	const commaIdx = b64.indexOf(',');
	if (b64.startsWith('data:') && commaIdx !== -1) {
		b64 = b64.slice(commaIdx + 1);
	}
	const sizeBytes = Number(body.size_bytes || Math.floor((b64.length * 3) / 4));

	return await storeDrop(db, {
		filename,
		mimeType,
		category,
		courseHint,
		autoRoute,
		noteText,
		b64,
		sizeBytes,
		now
	});
};

async function storeDrop(
	db: D1Database,
	opts: {
		filename: string;
		mimeType: string;
		category: string;
		courseHint: string;
		autoRoute: number;
		noteText: string;
		b64: string;
		sizeBytes: number;
		now: number;
	}
): Promise<Response> {
	const id = `drop_${opts.now}_${Math.random().toString(36).slice(2, 8)}`;
	const chunkSize = 380_000; // ~380KB base64 per D1 statement (well under D1 1MB statement limit)
	const chunks: string[] = [];
	for (let i = 0; i < opts.b64.length; i += chunkSize) {
		chunks.push(opts.b64.slice(i, i + chunkSize));
	}

	const stmts: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO CosmoDrops
				(id, filename, mime_type, category, course_hint, auto_route, note_text, size_bytes, chunk_count, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
			)
			.bind(
				id,
				opts.filename,
				opts.mimeType,
				opts.category,
				opts.courseHint,
				opts.autoRoute,
				opts.noteText,
				opts.sizeBytes,
				chunks.length,
				opts.now
			)
	];

	for (let idx = 0; idx < chunks.length; idx++) {
		stmts.push(
			db
				.prepare('INSERT INTO CosmoChunks (drop_id, chunk_idx, data_b64) VALUES (?, ?, ?)')
				.bind(id, idx, chunks[idx])
		);
	}

	await db.batch(stmts);

	// Keep D1 tidy: prune drops older than the newest 25
	try {
		const oldRes = await db
			.prepare('SELECT id FROM CosmoDrops ORDER BY created_at DESC LIMIT -1 OFFSET 25')
			.all<{ id: string }>();
		for (const row of oldRes.results || []) {
			await db.batch([
				db.prepare('DELETE FROM CosmoChunks WHERE drop_id = ?').bind(row.id),
				db.prepare('DELETE FROM CosmoDrops WHERE id = ?').bind(row.id)
			]);
		}
	} catch {
		// ignore cleanup errors
	}

	return jsonResponse({
		ok: true,
		id,
		filename: opts.filename,
		size_bytes: opts.sizeBytes,
		chunk_count: chunks.length,
		status: 'queued'
	});
}
