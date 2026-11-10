import type { RequestHandler } from '@sveltejs/kit';
import { CORS_HEADERS, ensureMagicSchema, getD1, jsonResponse } from '../../../../lib/magic/db.ts';
import { ENGINE_VERSION } from '../../../../lib/magic/types.ts';

export const trailingSlash = 'ignore';

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async ({ platform }) => {
	const db = getD1(platform);
	let dbOk = false;
	if (db) {
		try {
			await ensureMagicSchema(db);
			const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
			dbOk = row?.ok === 1;
		} catch {
			dbOk = false;
		}
	}
	return jsonResponse(
		{
			ok: dbOk,
			mode: 'cloudflare',
			version: ENGINE_VERSION,
			dbOk
		},
		dbOk ? 200 : 503
	);
};
