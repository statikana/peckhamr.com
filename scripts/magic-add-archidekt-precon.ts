/**
 * Import an Archidekt Commander deck URL (or numeric deck ID) into the engine's Precon Assurance
 * list (`src/lib/magic/precons.archidekt.json` + `src/lib/magic/precon-oracle.fixture.json`).
 *
 * Once imported, `src/lib/magic/compiler/precon-assurance.test.ts`, `compiler/compiler.test.ts`,
 * `compiler/automation.test.ts`, and `compiler/support.test.ts` permanently guard every card in
 * the deck against compiler or runtime regressions, and the deck appears in `/magic` precon lists.
 *
 * Usage:
 *   node scripts/magic-add-archidekt-precon.ts <archidekt-url-or-id>... [options]
 *   node scripts/magic-add-archidekt-precon.ts --list
 *   node scripts/magic-add-archidekt-precon.ts --remove <deck-id-or-archidekt-id>
 *
 * Options:
 *   --check-only, --dry-run   Fetch, validate, and print full card support report without writing
 *   --force                   Write even if 1+ cards currently have unsupported abilities (use when
 *                             an agent is about to implement those missing card mechanics)
 *   --id <precon_id>          Override deck ID (default: precon_archidekt_<archidektId>)
 *   --name <title>            Override deck display name (default: Archidekt deck title)
 *   --description <text>      Override deck description
 *   --bulk <path>             Scryfall oracle-cards.jsonl.gz path
 *                             (default: /home/ryan/data/scryfall/oracle-cards.jsonl.gz; falls back
 *                             automatically to Scryfall /cards/collection API for missing cards)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cardSupportReport } from '../src/lib/magic/compiler/support.ts';
import {
	PRECON_DECKS,
	STAPLE_CARDS,
	type ArchidektPreconDeckSpec,
	type ArchidektPreconStore
} from '../src/lib/magic/precons.ts';
import { normalizeScryfallCard, validateCommanderDeck } from '../src/lib/magic/scryfall.ts';
import type { DeckCardEntry, ScryfallCard } from '../src/lib/magic/types.ts';
import { NON_GAME_LAYOUTS, readBulk } from './magic-shared.ts';

const ROOT_DIR = new URL('..', import.meta.url).pathname;
const ARCHIDEKT_STORE_PATH = join(ROOT_DIR, 'src/lib/magic/precons.archidekt.json');
const ORACLE_FIXTURE_PATH = join(ROOT_DIR, 'src/lib/magic/precon-oracle.fixture.json');
const DEFAULT_BULK_PATH = '/home/ryan/data/scryfall/oracle-cards.jsonl.gz';

const BASIC_LAND_NAMES = new Set([
	'plains',
	'island',
	'swamp',
	'mountain',
	'forest',
	'wastes',
	'snow-covered plains',
	'snow-covered island',
	'snow-covered swamp',
	'snow-covered mountain',
	'snow-covered forest',
	'snow-covered wastes'
]);

const ARCHIDEKT_REQUEST_DELAY_MS = 200;
const SCRYFALL_REQUEST_DELAY_MS = 100;

interface CliArgs {
	mode: 'add' | 'list' | 'remove';
	targets: string[];
	checkOnly: boolean;
	force: boolean;
	idOverride?: string;
	nameOverride?: string;
	descriptionOverride?: string;
	bulkPath: string;
}

interface PreconOracleEntry {
	oracleText: string;
	typeLine: string;
	manaCost: string;
}

interface ArchidektApiCategory {
	id?: number;
	name: string;
	includedInDeck?: boolean;
	isPremier?: boolean;
}

interface ArchidektApiCardEntry {
	quantity: number;
	categories?: string[] | null;
	companion?: boolean;
	card?: {
		uid?: string;
		oracleCard?: {
			id?: string | number;
			uid?: string;
			name?: string;
		};
	};
}

interface ArchidektApiDeck {
	id: number;
	name: string;
	description?: string | null;
	categories?: ArchidektApiCategory[];
	cards?: ArchidektApiCardEntry[];
}

export interface RequestedScryfallCard {
	name: string;
	oracleId?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
	const out: CliArgs = {
		mode: 'add',
		targets: [],
		checkOnly: false,
		force: false,
		bulkPath: DEFAULT_BULK_PATH
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--list') {
			out.mode = 'list';
		} else if (a === '--remove') {
			out.mode = 'remove';
			const target = argv[++i];
			if (target) out.targets.push(target);
		} else if (a === '--check-only' || a === '--dry-run') {
			out.checkOnly = true;
		} else if (a === '--force') {
			out.force = true;
		} else if (a === '--id') {
			out.idOverride = argv[++i];
		} else if (a === '--name') {
			out.nameOverride = argv[++i];
		} else if (a === '--description') {
			out.descriptionOverride = argv[++i];
		} else if (a === '--bulk') {
			out.bulkPath = argv[++i];
		} else if (a === '--help' || a === '-h') {
			printUsageAndExit(0);
		} else if (!a.startsWith('-')) {
			out.targets.push(a);
		} else {
			throw new Error(`Unknown argument: ${a}`);
		}
	}
	return out;
}

function printUsageAndExit(code: number): never {
	console.log(
		[
			'Usage:',
			'  node scripts/magic-add-archidekt-precon.ts <archidekt-url-or-id>... [--check-only] [--force] [--id <id>] [--name <name>] [--bulk <path>]',
			'  node scripts/magic-add-archidekt-precon.ts --list',
			'  node scripts/magic-add-archidekt-precon.ts --remove <deck-id-or-archidekt-id>'
		].join('\n')
	);
	process.exit(code);
}

export function extractArchidektDeckId(input: string): number {
	const trimmed = input.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const m = /archidekt\.com\/(?:api\/)?decks\/(\d+)/i.exec(trimmed);
	if (m) return Number(m[1]);
	throw new Error(
		`Could not parse an Archidekt deck ID from "${input}". Expected e.g. https://archidekt.com/decks/1234567/deck_slug or 1234567.`
	);
}

function cleanArchidektDescription(raw: string | null | undefined, fallback: string): string {
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (!trimmed) return fallback;
	if (trimmed.startsWith('{') && trimmed.includes('"ops"')) {
		try {
			const parsed = JSON.parse(trimmed) as { ops?: Array<{ insert?: unknown }> };
			const text = (parsed.ops ?? [])
				.map((op) => (typeof op.insert === 'string' ? op.insert : ''))
				.join('')
				.replace(/\s+/g, ' ')
				.trim();
			if (text) return text.slice(0, 280);
		} catch {
			// Fall back below
		}
	}
	const stripped = trimmed
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return stripped ? stripped.slice(0, 280) : fallback;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 5): Promise<Response> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const res = await fetch(url, init);
		if (res.status !== 429 && res.status !== 502 && res.status !== 503 && res.status !== 504) {
			return res;
		}
		if (attempt === maxAttempts - 1) return res;
		const retryAfter = res.headers.get('retry-after');
		let waitMs = 1000 * 2 ** attempt;
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds) && seconds >= 0) {
				waitMs = Math.max(200, Math.ceil(seconds * 1000));
			} else {
				const dateMs = Date.parse(retryAfter) - Date.now();
				if (!Number.isNaN(dateMs) && dateMs > 0) waitMs = dateMs;
			}
		}
		console.warn(`HTTP ${res.status} from ${url}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})...`);
		await sleep(waitMs);
	}
	throw new Error(`Exceeded max retry attempts for ${url}`);
}

async function fetchArchidektDeck(deckId: number): Promise<ArchidektApiDeck> {
	const url = `https://archidekt.com/api/decks/${deckId}/`;
	const res = await fetchWithRetry(url, {
		headers: {
			Accept: 'application/json',
			'User-Agent': 'peckhamr-magic-engine-precon-assurance/1.0'
		}
	});
	if (!res.ok) {
		throw new Error(`Archidekt API returned HTTP ${res.status} for ${url}`);
	}
	return (await res.json()) as ArchidektApiDeck;
}

function normalizeLookupName(name: string): string {
	return name.trim().toLowerCase();
}

export async function resolveCardsFromScryfall(
	requestedInputs: Array<string | RequestedScryfallCard>,
	bulkPath: string
): Promise<Map<string, ScryfallCard>> {
	const requests = requestedInputs.map((item) => {
		const name = typeof item === 'string' ? item : item.name;
		const oracleId = typeof item === 'string' ? undefined : item.oracleId?.trim().toLowerCase() || undefined;
		return { name, lookupName: normalizeLookupName(name), oracleId };
	});

	const neededOracleIds = new Set<string>();
	const neededNames = new Set<string>();
	for (const req of requests) {
		if (req.oracleId) neededOracleIds.add(req.oracleId);
		if (req.lookupName) {
			neededNames.add(req.lookupName);
			if (req.lookupName.includes('//')) {
				neededNames.add(normalizeLookupName(req.lookupName.split('//')[0]));
			}
		}
	}

	const byOracleId = new Map<string, ScryfallCard>();
	const byFullName = new Map<string, { card: ScryfallCard; isFunny: boolean }>();
	const byFrontName = new Map<string, { card: ScryfallCard; isFunny: boolean }>();

	const recordCandidate = (raw: Record<string, any>) => {
		const card = normalizeScryfallCard(raw);
		const isFunny = raw.set_type === 'funny';
		const rawOracleId = typeof raw.oracle_id === 'string' ? raw.oracle_id.trim().toLowerCase() : '';
		const fullName = typeof raw.name === 'string' ? normalizeLookupName(raw.name) : '';
		const frontName =
			Array.isArray(raw.card_faces) && typeof raw.card_faces[0]?.name === 'string'
				? normalizeLookupName(raw.card_faces[0].name)
				: '';

		if (rawOracleId) {
			byOracleId.set(rawOracleId, card);
		}
		const setPreferred = (map: Map<string, { card: ScryfallCard; isFunny: boolean }>, key: string) => {
			if (!key) return;
			const existing = map.get(key);
			if (!existing || (existing.isFunny && !isFunny)) {
				map.set(key, { card, isFunny });
			}
		};
		setPreferred(byFullName, fullName);
		setPreferred(byFullName, normalizeLookupName(card.name));
		setPreferred(byFrontName, normalizeLookupName(card.name));
		setPreferred(byFrontName, frontName);
	};

	const lookupRequest = (req: { lookupName: string; oracleId?: string }): ScryfallCard | undefined => {
		if (req.oracleId && byOracleId.has(req.oracleId)) {
			return byOracleId.get(req.oracleId);
		}
		const exact = byFullName.get(req.lookupName);
		if (exact) return exact.card;
		const front = byFrontName.get(req.lookupName);
		if (front) return front.card;
		if (req.lookupName.includes('//')) {
			const splitFront = normalizeLookupName(req.lookupName.split('//')[0]);
			const splitMatch = byFrontName.get(splitFront);
			if (splitMatch) return splitMatch.card;
		}
		return undefined;
	};

	if (existsSync(bulkPath) && (neededNames.size > 0 || neededOracleIds.size > 0)) {
		for await (const raw of readBulk(bulkPath)) {
			if (NON_GAME_LAYOUTS.has(raw.layout)) continue;
			if (raw.set_type === 'token' || raw.set_type === 'memorabilia') continue;
			const rawOracleId = typeof raw.oracle_id === 'string' ? raw.oracle_id.trim().toLowerCase() : '';
			const fullName = typeof raw.name === 'string' ? normalizeLookupName(raw.name) : '';
			const frontName =
				Array.isArray(raw.card_faces) && typeof raw.card_faces[0]?.name === 'string'
					? normalizeLookupName(raw.card_faces[0].name)
					: '';
			if (
				(rawOracleId && neededOracleIds.has(rawOracleId)) ||
				neededNames.has(fullName) ||
				(frontName && neededNames.has(frontName))
			) {
				recordCandidate(raw);
			}
		}
	}

	const missing = requests.filter((req) => !lookupRequest(req));
	const uniqueMissing: typeof requests = [];
	const seenMissingKeys = new Set<string>();
	for (const req of missing) {
		const key = req.oracleId ?? req.lookupName;
		if (!seenMissingKeys.has(key)) {
			seenMissingKeys.add(key);
			uniqueMissing.push(req);
		}
	}

	for (let i = 0; i < uniqueMissing.length; i += 75) {
		if (i > 0) await sleep(SCRYFALL_REQUEST_DELAY_MS);
		const batch = uniqueMissing.slice(i, i + 75);
		const res = await fetchWithRetry('https://api.scryfall.com/cards/collection', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'peckhamr-magic-engine-precon-assurance/1.0'
			},
			body: JSON.stringify({
				identifiers: batch.map((req) =>
					req.oracleId ? { oracle_id: req.oracleId } : { name: req.name.split('//')[0].trim() }
				)
			})
		});
		if (!res.ok) {
			throw new Error(`Scryfall /cards/collection returned HTTP ${res.status}`);
		}
		const payload = (await res.json()) as {
			data?: Array<Record<string, any>>;
			not_found?: Array<{ name?: string; oracle_id?: string }>;
		};
		for (const raw of payload.data ?? []) {
			recordCandidate(raw);
		}
	}

	const resolved = new Map<string, ScryfallCard>();
	for (const [key, entry] of byFrontName) resolved.set(key, entry.card);
	for (const [key, entry] of byFullName) resolved.set(key, entry.card);
	for (const req of requests) {
		const card = lookupRequest(req);
		if (card) resolved.set(req.lookupName, card);
	}
	return resolved;
}

function readArchidektStore(): ArchidektPreconStore {
	if (!existsSync(ARCHIDEKT_STORE_PATH)) return { cards: [], decks: [] };
	return JSON.parse(readFileSync(ARCHIDEKT_STORE_PATH, 'utf8')) as ArchidektPreconStore;
}

function writeUpdatedStoreAndFixture(store: ArchidektPreconStore): void {
	// Keep only cards referenced by at least one Archidekt precon and not already built into precons.ts
	const builtInCards = Object.values(STAPLE_CARDS).filter(
		(c) => c.id.startsWith('card_') || c.id.startsWith('cmd_')
	);
	const builtInNames = new Set(builtInCards.map((c) => c.name.toLowerCase()));
	const referencedNames = new Set<string>();
	for (const d of store.decks) {
		for (const n of d.commanderNames) referencedNames.add(n.toLowerCase());
		if (d.companionName) referencedNames.add(d.companionName.toLowerCase());
		for (const [n] of d.nonBasicCounts) referencedNames.add(n.toLowerCase());
		for (const [n] of d.basicCounts) referencedNames.add(n.toLowerCase());
	}

	const dedupedCards = new Map<string, ScryfallCard>();
	for (const c of store.cards) {
		const key = c.name.toLowerCase();
		if (referencedNames.has(key) && !builtInNames.has(key)) {
			dedupedCards.set(key, c);
		}
	}
	store.cards = [...dedupedCards.values()].sort((a, b) => a.name.localeCompare(b.name));

	const dedupedDecks = new Map<string, ArchidektPreconDeckSpec>();
	for (const d of store.decks) {
		dedupedDecks.set(d.id, d);
	}
	store.decks = [...dedupedDecks.values()].sort((a, b) => a.id.localeCompare(b.id));

	writeFileSync(ARCHIDEKT_STORE_PATH, `${JSON.stringify(store, null, '\t')}\n`);

	// Sync precon-oracle.fixture.json unconditionally so compiler.test.ts ("Precon data integrity") stays 100% green
	const activeCardMap = new Map<string, ScryfallCard>();
	for (const c of builtInCards) {
		// Every built-in staple (incl. built-in commanders) is checked by "Precon data integrity".
		activeCardMap.set(c.name, c);
	}
	for (const c of store.cards) {
		activeCardMap.set(c.name, c);
	}

	const nextFixture: Record<string, PreconOracleEntry> = {};
	for (const name of [...activeCardMap.keys()].sort((a, b) => a.localeCompare(b))) {
		const card = activeCardMap.get(name)!;
		nextFixture[name] = {
			oracleText: card.oracleText,
			typeLine: card.typeLine,
			manaCost: card.manaCost
		};
	}
	writeFileSync(ORACLE_FIXTURE_PATH, `${JSON.stringify(nextFixture, null, '\t')}\n`);
}

function listAssuredDecks(): void {
	const store = readArchidektStore();
	const archidektById = new Map(store.decks.map((d) => [d.id, d]));
	console.log(`Assured Precon Decks: ${PRECON_DECKS.length} (${Object.keys(STAPLE_CARDS).length} unique cards)\n`);
	for (const d of PRECON_DECKS) {
		const meta = archidektById.get(d.id);
		const allCards = [...d.commanders, ...(d.companion ? [d.companion] : []), ...d.cards.map((e) => e.card)];
		const unsupported = allCards.filter((c) => !cardSupportReport(c).fullySupported);
		const src = meta ? `Archidekt #${meta.archidektId}` : 'built-in';
		console.log(
			`- ${d.id} | "${d.name}" [${src}] | Cmdr: ${d.commanders.map((c) => c.name).join(' + ')} | ${d.cardCount} cards | Unsupported: ${unsupported.length}`
		);
	}
}

function removeArchidektDeck(target: string): void {
	const store = readArchidektStore();
	const before = store.decks.length;
	store.decks = store.decks.filter(
		(d) => d.id !== target && String(d.archidektId) !== target.trim()
	);
	if (store.decks.length === before) {
		throw new Error(`No imported Archidekt precon matched "${target}".`);
	}
	writeUpdatedStoreAndFixture(store);
	console.log(`Removed "${target}". Remaining Archidekt precons: ${store.decks.length}.`);
}

interface ParsedArchidektDeck {
	archidektId: number;
	canonicalUrl: string;
	apiDeck: ArchidektApiDeck;
	rawCommanders: string[];
	rawCompanion?: string;
	rawMainCounts: Map<string, number>;
	requestedCards: Map<string, RequestedScryfallCard>;
}

function parseArchidektDeckEntries(archidektId: number, apiDeck: ArchidektApiDeck): ParsedArchidektDeck {
	const canonicalUrl = `https://archidekt.com/decks/${archidektId}`;
	const categoryMap = new Map<string, ArchidektApiCategory>();
	for (const cat of apiDeck.categories ?? []) {
		categoryMap.set(cat.name.toLowerCase(), cat);
	}

	const rawCommanders: string[] = [];
	let rawCompanion: string | undefined;
	const rawMainCounts = new Map<string, number>();
	const requestedCards = new Map<string, RequestedScryfallCard>();

	for (const entry of apiDeck.cards ?? []) {
		const cardName = entry.card?.oracleCard?.name?.trim();
		if (!cardName || entry.quantity <= 0) continue;

		const cats = (entry.categories ?? []).map((c) => c.toLowerCase());

		// Skip Maybeboard / Sideboard / Considering categories excluded from deck BEFORE
		// checking Companion / Commander tags (prevents ["Commander", "Maybeboard"] false commanders).
		if (cats.length > 0) {
			const excludedFromDeck = cats.some((c) => {
				const meta = categoryMap.get(c);
				if (!meta) return c === 'maybeboard' || c === 'sideboard' || c === 'considering';
				return meta.includedInDeck === false;
			});
			if (excludedFromDeck) continue;
		}

		const oracleId = entry.card?.oracleCard?.uid?.trim().toLowerCase() || undefined;
		const lookupKey = normalizeLookupName(cardName);
		if (!requestedCards.has(lookupKey) || (!requestedCards.get(lookupKey)!.oracleId && oracleId)) {
			requestedCards.set(lookupKey, { name: cardName, oracleId });
		}

		const isCompanion = Boolean(entry.companion) || cats.includes('companion');
		if (isCompanion) {
			rawCompanion = cardName;
			continue;
		}

		const isCommander = cats.some((c) => c === 'commander' || categoryMap.get(c)?.isPremier === true);
		if (isCommander) {
			if (!rawCommanders.includes(cardName)) rawCommanders.push(cardName);
			continue;
		}

		rawMainCounts.set(cardName, (rawMainCounts.get(cardName) ?? 0) + entry.quantity);
	}

	if (rawCommanders.length === 0) {
		throw new Error(`Archidekt deck #${archidektId} ("${apiDeck.name}") has no Commander designated.`);
	}

	return {
		archidektId,
		canonicalUrl,
		apiDeck,
		rawCommanders,
		rawCompanion,
		rawMainCounts,
		requestedCards
	};
}

async function importArchidektDecks(args: CliArgs): Promise<void> {
	if (args.targets.length === 0) printUsageAndExit(1);
	if (args.targets.length > 1 && (args.idOverride || args.nameOverride || args.descriptionOverride)) {
		throw new Error('--id, --name, and --description can only be used when importing a single deck.');
	}

	const parsedDecks: ParsedArchidektDeck[] = [];
	const allRequestedMap = new Map<string, RequestedScryfallCard>();

	for (let i = 0; i < args.targets.length; i++) {
		if (i > 0) await sleep(ARCHIDEKT_REQUEST_DELAY_MS);
		const archidektId = extractArchidektDeckId(args.targets[i]);
		const canonicalUrl = `https://archidekt.com/decks/${archidektId}`;
		console.log(`Fetching Archidekt deck #${archidektId} (${canonicalUrl})...`);
		const apiDeck = await fetchArchidektDeck(archidektId);
		const parsed = parseArchidektDeckEntries(archidektId, apiDeck);
		parsedDecks.push(parsed);
		for (const [key, req] of parsed.requestedCards) {
			const dedupeKey = req.oracleId ? `id:${req.oracleId}` : `name:${key}`;
			if (!allRequestedMap.has(dedupeKey)) {
				allRequestedMap.set(dedupeKey, req);
			}
		}
	}

	console.log(`Resolving ${allRequestedMap.size} unique card request(s) across ${parsedDecks.length} deck(s) against Scryfall Oracle data...`);
	const resolvedMap = await resolveCardsFromScryfall([...allRequestedMap.values()], args.bulkPath);

	const store = readArchidektStore();
	const cardByName = new Map(store.cards.map((c) => [c.name.toLowerCase(), c]));
	let checkOnlyFailure = false;
	let refuseFailure = false;

	for (const parsed of parsedDecks) {
		const { archidektId, canonicalUrl, apiDeck, rawCommanders, rawCompanion, rawMainCounts } = parsed;
		const allRequestedNames = [
			...rawCommanders,
			...(rawCompanion ? [rawCompanion] : []),
			...rawMainCounts.keys()
		];
		const missingFromScryfall = allRequestedNames.filter(
			(n) => !resolvedMap.has(normalizeLookupName(n))
		);
		if (missingFromScryfall.length > 0) {
			throw new Error(
				`Failed to resolve Scryfall Oracle data for #${archidektId}: ${missingFromScryfall.join(', ')}`
			);
		}

		const commanders = rawCommanders.map((n) => resolvedMap.get(normalizeLookupName(n))!);
		const companion = rawCompanion ? resolvedMap.get(normalizeLookupName(rawCompanion)) : undefined;

		const nonBasicMap = new Map<string, { card: ScryfallCard; qty: number }>();
		const basicMap = new Map<string, { card: ScryfallCard; qty: number }>();

		for (const [rawName, qty] of rawMainCounts) {
			const card = resolvedMap.get(normalizeLookupName(rawName))!;
			const target = BASIC_LAND_NAMES.has(card.name.toLowerCase()) ? basicMap : nonBasicMap;
			const prev = target.get(card.name);
			target.set(card.name, { card, qty: (prev?.qty ?? 0) + qty });
		}

		const deckCardEntries: DeckCardEntry[] = [
			...[...nonBasicMap.values()].map((e) => ({ quantity: e.qty, card: e.card })),
			...[...basicMap.values()].map((e) => ({ quantity: e.qty, card: e.card }))
		];

		const legality = validateCommanderDeck(commanders, deckCardEntries, companion);

		const uniqueDeckCards = new Map<string, ScryfallCard>();
		for (const c of commanders) uniqueDeckCards.set(c.name, c);
		if (companion) uniqueDeckCards.set(companion.name, companion);
		for (const e of deckCardEntries) uniqueDeckCards.set(e.card.name, e.card);

		const unsupportedCards: Array<{ card: ScryfallCard; reasons: string[] }> = [];
		for (const card of [...uniqueDeckCards.values()].sort((a, b) => a.name.localeCompare(b.name))) {
			const report = cardSupportReport(card);
			if (!report.fullySupported) {
				unsupportedCards.push({
					card,
					reasons: report.unsupported.map(
						(u) =>
							`[${u.reason}] ${u.face}: ${u.text}${u.unparsed.length > 0 ? ` (unparsed: ${u.unparsed.join(' | ')})` : ''}`
					)
				});
			}
		}

		const totalCards =
			commanders.length + deckCardEntries.reduce((sum, e) => sum + e.quantity, 0);
		const supportedCount = uniqueDeckCards.size - unsupportedCards.length;

		console.log('\n=== Archidekt Precon Assurance Audit ===');
		console.log(`Deck:        ${args.nameOverride ?? apiDeck.name} (#${archidektId})`);
		console.log(`Commander:   ${commanders.map((c) => c.name).join(' + ')}`);
		if (companion) console.log(`Companion:   ${companion.name}`);
		console.log(`Card Count:  ${totalCards} (${uniqueDeckCards.size} unique cards)`);
		console.log(`Legality:    ${legality.isLegal ? 'LEGAL' : `ILLEGAL (${legality.errors.join('; ')})`}`);
		console.log(
			`Engine IR:   ${supportedCount} / ${uniqueDeckCards.size} unique cards fully supported (${((100 * supportedCount) / uniqueDeckCards.size).toFixed(1)}%)`
		);

		if (unsupportedCards.length > 0 && parsedDecks.length === 1) {
			console.log(`\nUnsupported Cards (${unsupportedCards.length}):`);
			for (const item of unsupportedCards) {
				console.log(`  - ${item.card.name} (${item.card.typeLine})`);
				for (const r of item.reasons) {
					console.log(`      ${r}`);
				}
			}
		}

		if (args.checkOnly) {
			if (!legality.isLegal || unsupportedCards.length > 0) checkOnlyFailure = true;
			continue;
		}

		if (!legality.isLegal && !args.force) {
			console.error(
				`\nRefusing to add illegal Commander deck #${archidektId} without --force: ${legality.errors.join('; ')}`
			);
			refuseFailure = true;
			continue;
		}

		if (unsupportedCards.length > 0 && !args.force) {
			console.error(
				`\nRefusing to write ${unsupportedCards.length} unsupported card(s) for #${archidektId} into precons.archidekt.json without --force (would fail precon-assurance.test.ts).` +
					`\nImplement compiler/runtime support for the cards listed above first, or pass --force while actively fixing them.`
			);
			refuseFailure = true;
			continue;
		}

		for (const card of uniqueDeckCards.values()) {
			cardByName.set(card.name.toLowerCase(), card);
		}

		const deckId = args.idOverride ?? `precon_archidekt_${archidektId}`;
		const deckName = args.nameOverride ?? apiDeck.name;
		const defaultDesc = `Archidekt precon #${archidektId} led by ${commanders.map((c) => c.name).join(' & ')}.`;
		const deckSpec: ArchidektPreconDeckSpec = {
			id: deckId,
			archidektId,
			archidektUrl: canonicalUrl,
			name: deckName,
			description: args.descriptionOverride ?? cleanArchidektDescription(apiDeck.description, defaultDesc),
			commanderNames: commanders.map((c) => c.name),
			...(companion ? { companionName: companion.name } : {}),
			nonBasicCounts: [...nonBasicMap.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, e]) => [name, e.qty]),
			basicCounts: [...basicMap.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, e]) => [name, e.qty])
		};

		const existingIdx = store.decks.findIndex(
			(d) => d.id === deckId || d.archidektId === archidektId
		);
		if (existingIdx >= 0) {
			store.decks[existingIdx] = deckSpec;
		} else {
			store.decks.push(deckSpec);
		}
	}

	if (args.checkOnly) {
		console.log('\n--check-only specified; no files modified.');
		if (checkOnlyFailure) process.exit(2);
		return;
	}

	if (refuseFailure) {
		process.exit(1);
	}

	store.cards = [...cardByName.values()];
	writeUpdatedStoreAndFixture(store);
	console.log(
		`\nSaved ${parsedDecks.length} deck(s) into src/lib/magic/precons.archidekt.json and updated src/lib/magic/precon-oracle.fixture.json.`
	);
	console.log(
		`Run verification: node --test src/lib/magic/compiler/precon-assurance.test.ts src/lib/magic/compiler/compiler.test.ts src/lib/magic/compiler/support.test.ts`
	);
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (args.mode === 'list') {
		listAssuredDecks();
		return;
	}
	if (args.mode === 'remove') {
		if (args.targets.length !== 1) throw new Error('--remove requires <deck-id-or-archidekt-id>');
		removeArchidektDeck(args.targets[0]);
		return;
	}
	await importArchidektDecks(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
