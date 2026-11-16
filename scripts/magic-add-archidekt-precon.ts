/**
 * Import an Archidekt Commander deck URL (or numeric deck ID) into the engine's Precon Assurance
 * list (`src/lib/magic/precons.archidekt.json` + `src/lib/magic/precon-oracle.fixture.json`).
 *
 * Once imported, `src/lib/magic/compiler/precon-assurance.test.ts`, `compiler/compiler.test.ts`,
 * `compiler/automation.test.ts`, and `compiler/support.test.ts` permanently guard every card in
 * the deck against compiler or runtime regressions, and the deck appears in `/magic` precon lists.
 *
 * Usage:
 *   node scripts/magic-add-archidekt-precon.ts <archidekt-url-or-id> [options]
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

const BASIC_LAND_NAMES = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes']);

interface CliArgs {
	mode: 'add' | 'list' | 'remove';
	target?: string;
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
			id?: string;
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

function parseCliArgs(argv: string[]): CliArgs {
	const out: CliArgs = {
		mode: 'add',
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
			out.target = argv[++i];
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
		} else if (!a.startsWith('-') && !out.target) {
			out.target = a;
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
			'  node scripts/magic-add-archidekt-precon.ts <archidekt-url-or-id> [--check-only] [--force] [--id <id>] [--name <name>] [--bulk <path>]',
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

async function fetchArchidektDeck(deckId: number): Promise<ArchidektApiDeck> {
	const url = `https://archidekt.com/api/decks/${deckId}/`;
	const res = await fetch(url, {
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

async function resolveCardsFromScryfall(
	requestedNames: string[],
	bulkPath: string
): Promise<Map<string, ScryfallCard>> {
	const resolved = new Map<string, ScryfallCard>();
	const needed = new Set(requestedNames.map(normalizeLookupName));

	if (existsSync(bulkPath) && needed.size > 0) {
		for await (const raw of readBulk(bulkPath)) {
			if (NON_GAME_LAYOUTS.has(raw.layout)) continue;
			if (raw.set_type === 'token' || raw.set_type === 'memorabilia') continue;
			const fullName = typeof raw.name === 'string' ? normalizeLookupName(raw.name) : '';
			const frontName =
				Array.isArray(raw.card_faces) && typeof raw.card_faces[0]?.name === 'string'
					? normalizeLookupName(raw.card_faces[0].name)
					: '';
			if (needed.has(fullName) || (frontName && needed.has(frontName))) {
				const card = normalizeScryfallCard(raw);
				resolved.set(normalizeLookupName(card.name), card);
				if (frontName) resolved.set(frontName, card);
			}
		}
	}

	const missing = requestedNames.filter((n) => !resolved.has(normalizeLookupName(n)));
	for (let i = 0; i < missing.length; i += 75) {
		const batch = missing.slice(i, i + 75);
		const res = await fetch('https://api.scryfall.com/cards/collection', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'peckhamr-magic-engine-precon-assurance/1.0'
			},
			body: JSON.stringify({
				identifiers: batch.map((name) => ({ name: name.split('//')[0].trim() }))
			})
		});
		if (!res.ok) {
			throw new Error(`Scryfall /cards/collection returned HTTP ${res.status}`);
		}
		const payload = (await res.json()) as {
			data?: Array<Record<string, any>>;
			not_found?: Array<{ name?: string }>;
		};
		for (const raw of payload.data ?? []) {
			const card = normalizeScryfallCard(raw);
			resolved.set(normalizeLookupName(card.name), card);
			if (card.faces?.[0]?.name) {
				resolved.set(normalizeLookupName(card.faces[0].name), card);
			}
		}
	}

	return resolved;
}

function readArchidektStore(): ArchidektPreconStore {
	if (!existsSync(ARCHIDEKT_STORE_PATH)) return { cards: [], decks: [] };
	return JSON.parse(readFileSync(ARCHIDEKT_STORE_PATH, 'utf8')) as ArchidektPreconStore;
}

function readOracleFixture(): Record<string, PreconOracleEntry> {
	if (!existsSync(ORACLE_FIXTURE_PATH)) return {};
	return JSON.parse(readFileSync(ORACLE_FIXTURE_PATH, 'utf8')) as Record<string, PreconOracleEntry>;
}

function writeUpdatedStoreAndFixture(store: ArchidektPreconStore): void {
	// Keep only cards referenced by at least one Archidekt precon and not already built into precons.ts
	const builtInNames = new Set(
		Object.values(STAPLE_CARDS)
			.filter((c) => c.id.startsWith('card_'))
			.map((c) => c.name.toLowerCase())
	);
	const referencedNames = new Set<string>();
	for (const d of store.decks) {
		for (const n of d.commanderNames) referencedNames.add(n.toLowerCase());
		if (d.companionName) referencedNames.add(d.companionName.toLowerCase());
		for (const [n] of d.nonBasicCounts) referencedNames.add(n.toLowerCase());
		for (const [n] of d.basicCounts) referencedNames.add(n.toLowerCase());
	}

	store.cards = store.cards
		.filter((c) => referencedNames.has(c.name.toLowerCase()) && !builtInNames.has(c.name.toLowerCase()))
		.sort((a, b) => a.name.localeCompare(b.name));
	store.decks.sort((a, b) => a.id.localeCompare(b.id));

	writeFileSync(ARCHIDEKT_STORE_PATH, `${JSON.stringify(store, null, '\t')}\n`);

	// Sync precon-oracle.fixture.json so compiler.test.ts ("Precon data integrity") stays 100% green
	const existingFixture = readOracleFixture();
	const activeCardMap = new Map<string, ScryfallCard>();
	for (const c of Object.values(STAPLE_CARDS)) {
		// Every staple (incl. built-in commanders, whose ids aren't `card_*`) is checked by the
		// "Precon data integrity" test, so all of them must stay in the fixture.
		activeCardMap.set(c.name, c);
	}
	for (const c of store.cards) {
		activeCardMap.set(c.name, c);
	}

	const nextFixture: Record<string, PreconOracleEntry> = {};
	for (const name of [...activeCardMap.keys()].sort((a, b) => a.localeCompare(b))) {
		const card = activeCardMap.get(name)!;
		nextFixture[name] = existingFixture[name] ?? {
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

async function importArchidektDeck(args: CliArgs): Promise<void> {
	if (!args.target) printUsageAndExit(1);
	const archidektId = extractArchidektDeckId(args.target);
	const canonicalUrl = `https://archidekt.com/decks/${archidektId}`;
	console.log(`Fetching Archidekt deck #${archidektId} (${canonicalUrl})...`);

	const apiDeck = await fetchArchidektDeck(archidektId);
	const categoryMap = new Map<string, ArchidektApiCategory>();
	for (const cat of apiDeck.categories ?? []) {
		categoryMap.set(cat.name.toLowerCase(), cat);
	}

	const rawCommanders: string[] = [];
	let rawCompanion: string | undefined;
	const rawMainCounts = new Map<string, number>();

	for (const entry of apiDeck.cards ?? []) {
		const cardName = entry.card?.oracleCard?.name?.trim();
		if (!cardName || entry.quantity <= 0) continue;

		const cats = (entry.categories ?? []).map((c) => c.toLowerCase());
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

		// Skip Maybeboard / Sideboard / Considering categories excluded from deck.
		// Archidekt excludes a card from the deck if ANY of its categories is excluded
		// (e.g. a card tagged ["Maybeboard", "Counters"] is still a maybeboard card).
		if (cats.length > 0) {
			const excludedFromDeck = cats.some((c) => {
				const meta = categoryMap.get(c);
				if (!meta) return c === 'maybeboard' || c === 'sideboard' || c === 'considering';
				return meta.includedInDeck === false;
			});
			if (excludedFromDeck) continue;
		}

		rawMainCounts.set(cardName, (rawMainCounts.get(cardName) ?? 0) + entry.quantity);
	}

	if (rawCommanders.length === 0) {
		throw new Error(`Archidekt deck #${archidektId} ("${apiDeck.name}") has no Commander designated.`);
	}

	const allRequestedNames = [
		...rawCommanders,
		...(rawCompanion ? [rawCompanion] : []),
		...rawMainCounts.keys()
	];
	console.log(`Resolving ${allRequestedNames.length} unique cards against Scryfall Oracle data...`);
	const resolvedMap = await resolveCardsFromScryfall(allRequestedNames, args.bulkPath);

	const missingFromScryfall = allRequestedNames.filter(
		(n) => !resolvedMap.has(normalizeLookupName(n))
	);
	if (missingFromScryfall.length > 0) {
		throw new Error(`Failed to resolve Scryfall Oracle data for: ${missingFromScryfall.join(', ')}`);
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

	if (unsupportedCards.length > 0) {
		console.log(`\nUnsupported Cards (${unsupportedCards.length}):`);
		for (const item of unsupportedCards) {
			console.log(`  - ${item.card.name} (${item.card.typeLine})`);
			for (const r of item.reasons) {
				console.log(`      ${r}`);
			}
		}
	}

	if (args.checkOnly) {
		console.log('\n--check-only specified; no files modified.');
		if (!legality.isLegal || unsupportedCards.length > 0) process.exit(2);
		return;
	}

	if (!legality.isLegal && !args.force) {
		console.error(
			`\nRefusing to add illegal Commander deck without --force: ${legality.errors.join('; ')}`
		);
		process.exit(1);
	}

	if (unsupportedCards.length > 0 && !args.force) {
		console.error(
			`\nRefusing to write ${unsupportedCards.length} unsupported card(s) into precons.archidekt.json without --force (would fail precon-assurance.test.ts).` +
				`\nImplement compiler/runtime support for the cards listed above first, or pass --force while actively fixing them.`
		);
		process.exit(1);
	}

	const store = readArchidektStore();
	const cardByName = new Map(store.cards.map((c) => [c.name.toLowerCase(), c]));
	for (const card of uniqueDeckCards.values()) {
		cardByName.set(card.name.toLowerCase(), card);
	}
	store.cards = [...cardByName.values()];

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

	writeUpdatedStoreAndFixture(store);
	console.log(
		`\nSaved "${deckName}" (${deckId}) into src/lib/magic/precons.archidekt.json and updated src/lib/magic/precon-oracle.fixture.json.`
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
		if (!args.target) throw new Error('--remove requires <deck-id-or-archidekt-id>');
		removeArchidektDeck(args.target);
		return;
	}
	await importArchidektDeck(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
