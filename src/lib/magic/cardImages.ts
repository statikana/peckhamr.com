/**
 * Replaces Scryfall API image links with direct CDN links.
 *
 * Precon and token cards are built with `api.scryfall.com/cards/named?...&format=image` links. Each of
 * those is a rate-limited API call (a name search answered with a redirect cached for two days), so a
 * table of precons costs every new browser hundreds of API requests. Imported cards already carry
 * direct `cards.scryfall.io` links, which the CDN serves with a one-year cache.
 *
 * `resolveScryfallImageLinks` walks any value (a lobby, a game state, a deck list), looks up every API
 * image link it finds (in memory, then the MagicCardImages D1 table, then one batched Scryfall request
 * for cards and one search per token), and rewrites the link in place. Lookups that fail leave the
 * original link, which still works.
 */

const API_IMAGE_LINK = /^https:\/\/api\.scryfall\.com\/cards\/named\?/;
const SCRYFALL_HEADERS = {
	'User-Agent': 'PeckhamrMagicCommander/1.0',
	Accept: 'application/json'
};
/** Names Scryfall didn't know are retried after this long. */
const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Token searches are one request each; cap them per call so a save never waits on many. */
const MAX_TOKEN_SEARCHES_PER_CALL = 8;
const FETCH_TIMEOUT_MS = 5000;

/** Empty strings record a name Scryfall didn't find. */
interface CardImages {
	normal: string;
	artCrop: string;
	updatedAt: number;
}

interface LinkRef {
	holder: Record<string, unknown>;
	field: string;
	key: string;
	version: string;
}

interface Lookup {
	key: string;
	name: string;
	token: boolean;
	colors: string;
	power?: string;
	toughness?: string;
}

const memory = new Map<string, CardImages>();

/** Drops the in-memory cache (tests). */
export function clearCardImageMemory(): void {
	memory.clear();
}

export function isScryfallApiImageLink(value: unknown): value is string {
	return typeof value === 'string' && API_IMAGE_LINK.test(value);
}

function describeLink(holder: Record<string, unknown>, link: string): Lookup & { version: string } {
	const params = new URL(link).searchParams;
	const fuzzy = params.get('fuzzy');
	const name = (params.get('exact') ?? fuzzy ?? '').trim();
	const typeLine = typeof holder.typeLine === 'string' ? holder.typeLine : '';
	const token = fuzzy !== null || /\bToken\b/.test(typeLine);
	const colors = Array.isArray(holder.colors) ? [...holder.colors].sort().join('') : '';
	const power = typeof holder.power === 'string' ? holder.power : undefined;
	const toughness = typeof holder.toughness === 'string' ? holder.toughness : undefined;
	const key = token
		? `token:${name.toLowerCase()}|${colors}|${power ?? ''}/${toughness ?? ''}`
		: `card:${name.toLowerCase()}`;
	return { key, name, token, colors, power, toughness, version: params.get('version') ?? 'normal' };
}

function collectLinks(root: unknown): { refs: LinkRef[]; lookups: Map<string, Lookup> } {
	const refs: LinkRef[] = [];
	const lookups = new Map<string, Lookup>();
	const seen = new Set<object>();
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const value = stack.pop();
		if (!value || typeof value !== 'object' || seen.has(value)) continue;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) if (item && typeof item === 'object') stack.push(item);
			continue;
		}
		const holder = value as Record<string, unknown>;
		for (const field of Object.keys(holder)) {
			const v = holder[field];
			if (isScryfallApiImageLink(v)) {
				const { version, ...lookup } = describeLink(holder, v);
				if (!lookup.name) continue;
				refs.push({ holder, field, key: lookup.key, version });
				if (!lookups.has(lookup.key)) lookups.set(lookup.key, lookup);
			} else if (v && typeof v === 'object') {
				stack.push(v);
			}
		}
	}
	return { refs, lookups };
}

function imagesOf(raw: Record<string, any>): { normal: string; artCrop: string } | null {
	const uris = raw.image_uris ?? raw.card_faces?.[0]?.image_uris;
	if (!uris?.normal) return null;
	return { normal: String(uris.normal), artCrop: String(uris.art_crop ?? uris.normal) };
}

async function scryfallJson(url: string, init?: RequestInit): Promise<any | null> {
	const res = await fetch(url, {
		...init,
		headers: { ...SCRYFALL_HEADERS, ...(init?.headers ?? {}) },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (res.status === 404) return { object: 'list', data: [] };
	if (!res.ok) return null;
	return res.json();
}

/** One /cards/collection request per 75 names. Unknown names map to empty images; failures are skipped. */
async function fetchCards(lookups: Lookup[], now: number, out: Map<string, CardImages>): Promise<void> {
	for (let i = 0; i < lookups.length; i += 75) {
		const chunk = lookups.slice(i, i + 75);
		try {
			const data = await scryfallJson('https://api.scryfall.com/cards/collection', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifiers: chunk.map((l) => ({ name: l.name })) })
			});
			if (!data) continue;
			const byName = new Map<string, { normal: string; artCrop: string }>();
			for (const raw of (data.data ?? []) as Array<Record<string, any>>) {
				const images = imagesOf(raw);
				if (!images) continue;
				const full = String(raw.name ?? '').toLowerCase();
				byName.set(full, images);
				if (full.includes('//')) byName.set(full.split('//')[0].trim(), images);
			}
			for (const l of chunk) {
				const images = byName.get(l.name.toLowerCase());
				out.set(l.key, { normal: images?.normal ?? '', artCrop: images?.artCrop ?? '', updatedAt: now });
			}
		} catch {
			// Network error or timeout: leave these unresolved so a later call retries.
		}
	}
}

/** Token art: a token-only search, narrowed by colors and P/T when known, else by name alone. */
async function fetchToken(l: Lookup, now: number, out: Map<string, CardImages>): Promise<void> {
	const exact = `!"${l.name.replace(/"/g, '')}" t:token`;
	const filters = [
		l.colors ? `c=${l.colors.toLowerCase()}` : '',
		l.power !== undefined ? `pow=${l.power}` : '',
		l.toughness !== undefined ? `tou=${l.toughness}` : ''
	].filter(Boolean);
	const queries = filters.length > 0 ? [`${exact} ${filters.join(' ')}`, exact] : [exact];
	try {
		for (const q of queries) {
			const url = `https://api.scryfall.com/cards/search?unique=cards&order=released&q=${encodeURIComponent(q)}`;
			const data = await scryfallJson(url);
			if (!data) return;
			for (const raw of (data.data ?? []) as Array<Record<string, any>>) {
				const images = raw.image_uris ? imagesOf(raw) : null;
				if (images) {
					out.set(l.key, { ...images, updatedAt: now });
					return;
				}
			}
		}
		out.set(l.key, { normal: '', artCrop: '', updatedAt: now });
	} catch {
		// Network error or timeout: retry on a later call.
	}
}

async function readD1(db: D1Database, keys: string[], out: Map<string, CardImages>): Promise<void> {
	for (let i = 0; i < keys.length; i += 50) {
		const chunk = keys.slice(i, i + 50);
		const rows = await db
			.prepare(
				`SELECT key, image_url, art_crop_url, updated_at FROM MagicCardImages WHERE key IN (${chunk.map(() => '?').join(',')})`
			)
			.bind(...chunk)
			.all<{ key: string; image_url: string; art_crop_url: string; updated_at: number }>();
		for (const r of rows.results ?? []) {
			out.set(r.key, { normal: r.image_url, artCrop: r.art_crop_url, updatedAt: Number(r.updated_at) });
		}
	}
}

async function writeD1(db: D1Database, entries: Array<[string, CardImages]>): Promise<void> {
	if (entries.length === 0) return;
	await db.batch(
		entries.map(([key, img]) =>
			db
				.prepare(
					`INSERT OR REPLACE INTO MagicCardImages (key, image_url, art_crop_url, updated_at) VALUES (?, ?, ?, ?)`
				)
				.bind(key, img.normal, img.artCrop, img.updatedAt)
		)
	);
}

function usable(img: CardImages | undefined, now: number): img is CardImages {
	return Boolean(img && (img.normal || now - img.updatedAt < NOT_FOUND_RETRY_MS));
}

/**
 * Rewrites every Scryfall API image link inside `root` to its CDN link, in place. Never throws: on
 * any failure the original links stay. Pass the D1 database (after ensureMagicSchema) to share
 * results across isolates; without it only the in-memory cache is used.
 */
export async function resolveScryfallImageLinks(
	db: D1Database | undefined,
	root: unknown,
	now = Date.now()
): Promise<void> {
	try {
		const { refs, lookups } = collectLinks(root);
		if (refs.length === 0) return;

		const found = new Map<string, CardImages>();
		const missing = (): Lookup[] =>
			[...lookups.values()].filter((l) => !found.has(l.key));
		for (const l of lookups.values()) {
			const img = memory.get(l.key);
			if (usable(img, now)) found.set(l.key, img);
		}

		if (db && missing().length > 0) {
			const fromDb = new Map<string, CardImages>();
			try {
				await readD1(db, missing().map((l) => l.key), fromDb);
			} catch {
				// Table missing or D1 error: fall through to Scryfall.
			}
			for (const [key, img] of fromDb) {
				if (usable(img, now)) {
					found.set(key, img);
					memory.set(key, img);
				}
			}
		}

		const fetched = new Map<string, CardImages>();
		const todo = missing();
		await fetchCards(todo.filter((l) => !l.token), now, fetched);
		for (const l of todo.filter((t) => t.token).slice(0, MAX_TOKEN_SEARCHES_PER_CALL)) {
			await fetchToken(l, now, fetched);
		}
		for (const [key, img] of fetched) {
			found.set(key, img);
			memory.set(key, img);
		}
		if (db) {
			try {
				await writeD1(db, [...fetched]);
			} catch {
				// The cache is an optimization; a failed write only means a later lookup repeats.
			}
		}

		for (const ref of refs) {
			const img = found.get(ref.key);
			const link = ref.version === 'art_crop' ? img?.artCrop : img?.normal;
			if (link) ref.holder[ref.field] = link;
		}
	} catch {
		// Never let image caching break a request.
	}
}
