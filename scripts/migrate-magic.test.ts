import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
	MAGIC_TABLES,
	migrateD1DumpToSqlite,
	splitSqlStatements
} from './migrate-magic-d1-to-sqlite.mjs';
import { exportSqliteMagicToD1Sql } from './migrate-magic-sqlite-to-d1.mjs';

const SYNTHETIC_D1_DUMP = `
PRAGMA defer_foreign_keys=TRUE;
-- Non-Magic tables in cosmo_users that MUST be ignored
CREATE TABLE "cosmo_files" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
INSERT INTO "cosmo_files" VALUES('cf_1', 'secret.txt; DROP TABLE MagicUsers;');
CREATE TABLE notes_entries (id TEXT PRIMARY KEY, body TEXT);
INSERT INTO notes_entries VALUES('n_1', 'some note');

-- Magic tables with tricky SQL payloads: semicolons, quotes, newlines, comments inside strings
CREATE TABLE "MagicUsers" (
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
INSERT INTO "MagicUsers" VALUES('usr_google_1','google','1','urza@tolaria.edu','Urza''s Ghost','https://example.com/a.png','{"gamesPlayed":7,"wins":3}',1700000001,1700000099);
INSERT INTO "MagicUsers" VALUES('usr_guest_2','guest','2','','Guest; -- not a comment','','{"gamesPlayed":1,"wins":0}',1700000002,1700000002);

CREATE TABLE MagicSessions (
	token TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO MagicSessions VALUES('msess_abc','usr_google_1',1999999999999,1700000001);

CREATE TABLE \`MagicDecks\` (
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
INSERT INTO \`MagicDecks\` VALUES('deck_1','usr_google_1','Esper Artifacts','Line 1
Line 2; /* comment-like */','[{"name":"Urza, Chief Artificer"}]','[{"name":"Sol Ring","oracle":"{T}: Add {C}{C}."}]','WUB',100,1,'[]',3,7,1700000010,1700000020);

CREATE TABLE MagicLobbies (
	code TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	host_user_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'waiting',
	is_private INTEGER DEFAULT 1,
	rules_json TEXT NOT NULL,
	seats_json TEXT NOT NULL,
	game_state_json TEXT DEFAULT '',
	version INTEGER DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
INSERT INTO MagicLobbies VALUES('POD777','Urza''s Pod','usr_google_1','active',1,'{"startingLife":40}','[{"seatIndex":0,"userId":"usr_google_1"}]','{"turnNumber":4,"note":"a;b''c\\nd"}',12,1700000030,1700000040);

CREATE TABLE MagicChatMessages (
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
INSERT INTO MagicChatMessages VALUES('msg_1','POD777','usr_google_1','Urza''s Ghost','',0,'chat','Pay 1 for Rhystic Study?; ''No!''',1700000041);
-- Intentionally omit MagicCardImages CREATE TABLE from dump to verify fallback schema creation!
DELETE FROM sqlite_sequence;
`;

function snapshotAllMagicRows(sqlitePath: string): Record<string, Array<Record<string, unknown>>> {
	const db = new DatabaseSync(sqlitePath, { readOnly: true });
	try {
		const out: Record<string, Array<Record<string, unknown>>> = {};
		for (const table of MAGIC_TABLES) {
			const pkCol =
				table === 'MagicSessions'
					? 'token'
					: table === 'MagicLobbies'
						? 'code'
						: table === 'MagicCardImages'
							? 'key'
							: 'id';
			out[table] = db
				.prepare(`SELECT * FROM "${table}" ORDER BY "${pkCol}" ASC`)
				.all()
				.map((r) => ({ ...r }));
		}
		return out;
	} finally {
		db.close();
	}
}

describe('Magic D1 <-> SQLite migration scripts (5.1 & 5.4)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'magic-migrate-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('5.1: extracts only Magic tables, ignores cosmo/notes tables, and preserves multi-line/quoted SQL strings', () => {
		const sqlitePath = join(tempDir, 'migrated.sqlite');
		const counts = migrateD1DumpToSqlite({
			dumpSql: SYNTHETIC_D1_DUMP,
			sqliteOutputPath: sqlitePath
		});

		assert.deepEqual(counts, {
			MagicUsers: 2,
			MagicSessions: 1,
			MagicDecks: 1,
			MagicLobbies: 1,
			MagicChatMessages: 1,
			MagicCardImages: 0
		});

		const db = new DatabaseSync(sqlitePath, { readOnly: true });
		try {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
				.all()
				.map((r: Record<string, unknown>) => String(r.name));
			assert.deepEqual(tables, [...MAGIC_TABLES].sort());

			const urza = db
				.prepare('SELECT username, stats_json FROM MagicUsers WHERE id = ?')
				.get('usr_google_1') as Record<string, unknown>;
			assert.equal(urza.username, "Urza's Ghost");
			assert.equal(urza.stats_json, '{"gamesPlayed":7,"wins":3}');

			const deck = db
				.prepare('SELECT description, cards_json FROM MagicDecks WHERE id = ?')
				.get('deck_1') as Record<string, unknown>;
			assert.equal(deck.description, 'Line 1\nLine 2; /* comment-like */');

			const chat = db
				.prepare('SELECT message FROM MagicChatMessages WHERE id = ?')
				.get('msg_1') as Record<string, unknown>;
			assert.equal(chat.message, "Pay 1 for Rhystic Study?; 'No!'");
		} finally {
			db.close();
		}

		// Refuses to overwrite existing file unless force: true
		assert.throws(() => {
			migrateD1DumpToSqlite({
				dumpSql: SYNTHETIC_D1_DUMP,
				sqliteOutputPath: sqlitePath,
				force: false
			});
		}, /already exists/);
	});

	it('5.4: batches large INSERTs below statement size limit, leaves non-Magic D1 tables intact, and preserves every row in a full D1 -> SQLite -> SQL -> fresh SQLite round trip', () => {
		const sqliteStep1 = join(tempDir, 'step1.sqlite');
		migrateD1DumpToSqlite({
			dumpSql: SYNTHETIC_D1_DUMP,
			sqliteOutputPath: sqliteStep1
		});

		// Add MagicCardImages rows (20 entries) so all 6 tables are non-empty and test size batching
		const db1 = new DatabaseSync(sqliteStep1);
		try {
			const ins = db1.prepare(
				'INSERT INTO MagicCardImages (key, image_url, art_crop_url, updated_at) VALUES (?, ?, ?, ?)'
			);
			for (let i = 0; i < 20; i++) {
				ins.run(
					`exact:card-${i}`,
					`https://cards.scryfall.io/normal/front/${i}/${'x'.repeat(120)}.jpg`,
					`https://cards.scryfall.io/art_crop/front/${i}/${'y'.repeat(120)}.jpg`,
					1700000100 + i
				);
			}
		} finally {
			db1.close();
		}

		const expectedRows = snapshotAllMagicRows(sqliteStep1);

		// Export SQLite -> D1 SQL with a tight 2 KB batch limit to verify multi-statement batching
		const exported = exportSqliteMagicToD1Sql({
			sqliteInputPath: sqliteStep1,
			maxStatementBytes: 2048
		});
		assert.deepEqual(exported.counts, {
			MagicUsers: 2,
			MagicSessions: 1,
			MagicDecks: 1,
			MagicLobbies: 1,
			MagicChatMessages: 1,
			MagicCardImages: 20
		});
		assert.ok(
			exported.insertStatementCount >= 8,
			`Expected 20 ~280B rows with 2KB cap to split into multiple INSERT batches, got ${exported.insertStatementCount}`
		);
		for (const stmt of splitSqlStatements(exported.sql)) {
			assert.ok(
				Buffer.byteLength(stmt, 'utf8') < 100_000,
				'Every generated SQL statement must stay under D1 100 KB limit'
			);
		}

		const exportedSqlFile = join(tempDir, 'to-d1.sql');
		writeFileSync(exportedSqlFile, exported.sql, 'utf8');

		// 1. Round-trip via migrateD1DumpToSqlite into a brand-new SQLite file (D1 dump -> SQLite -> SQL -> fresh SQLite)
		const sqliteRoundTrip = join(tempDir, 'roundtrip.sqlite');
		const rtCounts = migrateD1DumpToSqlite({
			dumpSql: exported.sql,
			sqliteOutputPath: sqliteRoundTrip
		});
		assert.deepEqual(rtCounts, exported.counts);
		assert.deepEqual(snapshotAllMagicRows(sqliteRoundTrip), expectedRows);

		// 2. Also verify applying the exported SQL directly onto a shared D1-like database preserves cosmo_files
		const simulatedD1Path = join(tempDir, 'simulated-d1.sqlite');
		const simD1 = new DatabaseSync(simulatedD1Path);
		try {
			simD1.exec('CREATE TABLE cosmo_files (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
			simD1.exec("INSERT INTO cosmo_files VALUES ('cf_keep', 'important.pdf');");
			simD1.exec(
				"CREATE TABLE MagicUsers (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, email TEXT DEFAULT '', username TEXT NOT NULL, avatar_url TEXT DEFAULT '', stats_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL);"
			);
			simD1.exec(
				"INSERT INTO MagicUsers VALUES ('stale_user', 'guest', '0', '', 'Old', '', '{}', 1, 1);"
			);

			simD1.exec(exported.sql);

			const cosmoRows = simD1.prepare('SELECT * FROM cosmo_files').all();
			assert.equal(cosmoRows.length, 1);
			assert.equal(cosmoRows[0].id, 'cf_keep');
		} finally {
			simD1.close();
		}
		assert.deepEqual(snapshotAllMagicRows(simulatedD1Path), expectedRows);
	});
});
