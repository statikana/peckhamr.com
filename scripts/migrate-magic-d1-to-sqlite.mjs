#!/usr/bin/env node
/**
 * Step 5.1: Migrate Magic tables from a `wrangler d1 export cosmo_users --remote --output=dump.sql`
 * SQL dump into a fresh SQLite database file for magic-backend.
 *
 * Only extracts the 6 Magic tables (leaving Cosmo/Notes/other tables untouched):
 *   MagicUsers, MagicSessions, MagicDecks, MagicLobbies, MagicChatMessages, MagicCardImages
 *
 * Usage:
 *   node scripts/migrate-magic-d1-to-sqlite.mjs <dump.sql> <output.sqlite> [--force]
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const MAGIC_TABLES = [
	'MagicUsers',
	'MagicSessions',
	'MagicDecks',
	'MagicLobbies',
	'MagicChatMessages',
	'MagicCardImages'
];

const MAGIC_TABLE_MAP = new Map(MAGIC_TABLES.map((name) => [name.toLowerCase(), name]));

const FALLBACK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS MagicUsers (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	email TEXT DEFAULT '',
	username TEXT NOT NULL,
	avatar_url TEXT DEFAULT '',
	stats_json TEXT DEFAULT '{}',
	created_at INTEGER NOT NULL,
	last_login_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MagicSessions (
	token TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MagicDecks (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT DEFAULT '',
	commanders_json TEXT NOT NULL,
	cards_json TEXT NOT NULL,
	color_identity TEXT NOT NULL,
	card_count INTEGER DEFAULT 100,
	is_legal INTEGER DEFAULT 1,
	validation_errors_json TEXT DEFAULT '[]',
	win_count INTEGER DEFAULT 0,
	play_count INTEGER DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MagicLobbies (
	code TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	host_user_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'waiting',
	is_private INTEGER DEFAULT 1,
	rules_json TEXT NOT NULL,
	seats_json TEXT NOT NULL,
	game_state_json TEXT DEFAULT '',
	version INTEGER DEFAULT 1,
	bot_resume_at INTEGER DEFAULT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MagicChatMessages (
	id TEXT PRIMARY KEY,
	lobby_code TEXT NOT NULL,
	user_id TEXT NOT NULL,
	username TEXT NOT NULL,
	avatar_url TEXT DEFAULT '',
	seat_idx INTEGER DEFAULT -1,
	kind TEXT DEFAULT 'chat',
	message TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MagicCardImages (
	key TEXT PRIMARY KEY,
	image_url TEXT NOT NULL,
	art_crop_url TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

/**
 * Lexically split a SQL script into individual statements, respecting single-quoted string literals,
 * double/backtick-quoted identifiers, `--` line comments, and block comments so semicolons or
 * newlines inside JSON columns never split a statement prematurely.
 */
export function splitSqlStatements(sqlText) {
	const statements = [];
	let start = 0;
	let i = 0;
	const len = sqlText.length;
	let state = 'code'; // 'code' | 'single' | 'double' | 'backtick' | 'line_comment' | 'block_comment'

	while (i < len) {
		const ch = sqlText[i];
		const next = i + 1 < len ? sqlText[i + 1] : '';

		if (state === 'code') {
			if (ch === "'") {
				state = 'single';
				i++;
			} else if (ch === '"') {
				state = 'double';
				i++;
			} else if (ch === '`') {
				state = 'backtick';
				i++;
			} else if (ch === '-' && next === '-') {
				state = 'line_comment';
				i += 2;
			} else if (ch === '/' && next === '*') {
				state = 'block_comment';
				i += 2;
			} else if (ch === ';') {
				const raw = sqlText.slice(start, i + 1).trim();
				if (raw) statements.push(raw);
				start = i + 1;
				i++;
			} else {
				i++;
			}
		} else if (state === 'single') {
			if (ch === "'" && next === "'") {
				i += 2;
			} else if (ch === "'") {
				state = 'code';
				i++;
			} else {
				i++;
			}
		} else if (state === 'double') {
			if (ch === '"' && next === '"') {
				i += 2;
			} else if (ch === '"') {
				state = 'code';
				i++;
			} else {
				i++;
			}
		} else if (state === 'backtick') {
			if (ch === '`' && next === '`') {
				i += 2;
			} else if (ch === '`') {
				state = 'code';
				i++;
			} else {
				i++;
			}
		} else if (state === 'line_comment') {
			if (ch === '\n') {
				state = 'code';
			}
			i++;
		} else if (state === 'block_comment') {
			if (ch === '*' && next === '/') {
				state = 'code';
				i += 2;
			} else {
				i++;
			}
		}
	}

	const trailing = sqlText.slice(start).trim();
	if (trailing) {
		statements.push(trailing.endsWith(';') ? trailing : `${trailing};`);
	}
	return statements;
}

function stripLeadingComments(stmt) {
	let s = stmt.trimStart();
	while (s.length > 0) {
		if (s.startsWith('--')) {
			const nl = s.indexOf('\n');
			if (nl === -1) return '';
			s = s.slice(nl + 1).trimStart();
		} else if (s.startsWith('/*')) {
			const end = s.indexOf('*/');
			if (end === -1) return '';
			s = s.slice(end + 2).trimStart();
		} else {
			break;
		}
	}
	return s;
}

const IDENT = String.raw`(?:"([^"]+)"|\`([^\`]+)\`|\[([^\]]+)\]|([A-Za-z0-9_]+))`;
const CREATE_TABLE_RE = new RegExp(
	String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
	'i'
);
const INSERT_RE = new RegExp(
	String.raw`^INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|ROLLBACK|FAIL)\s+)?INTO\s+${IDENT}`,
	'i'
);
const CREATE_INDEX_RE = new RegExp(
	String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+ON\s+${IDENT}`,
	'i'
);

function pickIdent(match, offset = 1) {
	return match[offset] || match[offset + 1] || match[offset + 2] || match[offset + 3] || '';
}

export function extractMagicStatements(dumpSql) {
	const all = splitSqlStatements(dumpSql);
	const createStatements = [];
	const insertStatements = [];
	const indexStatements = [];

	for (const stmt of all) {
		const body = stripLeadingComments(stmt);
		if (!body) continue;

		const createMatch = body.match(CREATE_TABLE_RE);
		if (createMatch) {
			const table = MAGIC_TABLE_MAP.get(pickIdent(createMatch, 1).toLowerCase());
			if (table) createStatements.push(body);
			continue;
		}

		const insertMatch = body.match(INSERT_RE);
		if (insertMatch) {
			const table = MAGIC_TABLE_MAP.get(pickIdent(insertMatch, 1).toLowerCase());
			if (table) insertStatements.push(body);
			continue;
		}

		const idxMatch = body.match(CREATE_INDEX_RE);
		if (idxMatch) {
			const table = MAGIC_TABLE_MAP.get(pickIdent(idxMatch, 5).toLowerCase());
			if (table) indexStatements.push(body);
		}
	}

	return { createStatements, insertStatements, indexStatements };
}

/**
 * Migrate a D1 SQL dump file (or string) into a fresh SQLite database at `sqliteOutputPath`.
 * Returns a map of `{ [tableName]: rowCount }`.
 */
export function migrateD1DumpToSqlite({ dumpSql, sqliteOutputPath, force = false }) {
	if (sqliteOutputPath !== ':memory:' && existsSync(sqliteOutputPath)) {
		if (!force) {
			throw new Error(
				`Output file already exists: ${sqliteOutputPath} (pass --force to replace it)`
			);
		}
		rmSync(sqliteOutputPath, { force: true });
		rmSync(`${sqliteOutputPath}-wal`, { force: true });
		rmSync(`${sqliteOutputPath}-shm`, { force: true });
	}

	if (sqliteOutputPath !== ':memory:') {
		mkdirSync(dirname(resolve(sqliteOutputPath)), { recursive: true });
	}

	const { createStatements, insertStatements, indexStatements } = extractMagicStatements(dumpSql);

	const db = new DatabaseSync(sqliteOutputPath);
	try {
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA busy_timeout = 5000;');

		db.exec('BEGIN;');
		try {
			for (const stmt of createStatements) {
				db.exec(stmt);
			}
			// Ensure any Magic table that was absent from the dump still exists
			db.exec(FALLBACK_SCHEMA_SQL);

			for (const stmt of insertStatements) {
				db.exec(stmt);
			}
			// Upgrade pre-pacing D1 dumps whose MagicLobbies lacked `bot_resume_at` after positional INSERTs run
			const lobbyCols = db
				.prepare('PRAGMA table_info("MagicLobbies")')
				.all()
				.map((c) => String(c.name));
			if (!lobbyCols.includes('bot_resume_at')) {
				db.exec('ALTER TABLE "MagicLobbies" ADD COLUMN bot_resume_at INTEGER DEFAULT NULL;');
			}
			for (const stmt of indexStatements) {
				db.exec(stmt);
			}
			db.exec('COMMIT;');
		} catch (err) {
			try {
				db.exec('ROLLBACK;');
			} catch {
				// ignore
			}
			throw err;
		}

		const counts = {};
		for (const table of MAGIC_TABLES) {
			const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`).get();
			counts[table] = Number(row?.cnt ?? 0);
		}
		return counts;
	} finally {
		db.close();
	}
}

function parseCliArgs(argv) {
	const positional = [];
	let force = false;
	for (const arg of argv) {
		if (arg === '--force' || arg === '-f') {
			force = true;
		} else if (arg === '--help' || arg === '-h') {
			return { help: true };
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	return {
		help: false,
		dumpPath: positional[0],
		outputPath: positional[1],
		force
	};
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.help || !parsed.dumpPath || !parsed.outputPath) {
		console.error(
			'Usage: node scripts/migrate-magic-d1-to-sqlite.mjs <d1-dump.sql> <output.sqlite> [--force]'
		);
		process.exit(parsed.help ? 0 : 1);
	}

	const dumpSql = readFileSync(resolve(parsed.dumpPath), 'utf8');
	const counts = migrateD1DumpToSqlite({
		dumpSql,
		sqliteOutputPath: resolve(parsed.outputPath),
		force: parsed.force
	});

	console.log(`Loaded Magic tables into ${resolve(parsed.outputPath)}:`);
	for (const table of MAGIC_TABLES) {
		console.log(`  ${table.padEnd(20)} ${counts[table]} row(s)`);
	}
}
