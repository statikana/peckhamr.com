import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type SqliteD1Database = D1Database & {
	close(): void;
	readonly sqlite: DatabaseSync;
};

function toSqlInput(value: unknown): SQLInputValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	return String(value);
}

function makeMeta(changes = 0, lastRowId = 0): D1Meta & Record<string, unknown> {
	return {
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: changes,
		last_row_id: lastRowId,
		changed_db: changes > 0,
		changes
	};
}

class SqliteD1PreparedStatement {
	readonly sql: string;
	readonly params: SQLInputValue[];
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
		this.db = db;
		this.sql = sql;
		this.params = params;
	}

	bind(...values: unknown[]): D1PreparedStatement {
		return new SqliteD1PreparedStatement(
			this.db,
			this.sql,
			values.map(toSqlInput)
		) as unknown as D1PreparedStatement;
	}

	async first<T = unknown>(colName?: string): Promise<T | null> {
		const stmt = this.db.prepare(this.sql);
		const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		const plain = { ...row };
		if (colName !== undefined) {
			const val = plain[colName];
			return val === undefined || val === null ? null : (val as T);
		}
		return plain as T;
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.execAllSync<T>();
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.execRunSync<T>();
	}

	execAllSync<T = Record<string, unknown>>(): D1Result<T> {
		const stmt = this.db.prepare(this.sql);
		const rows = stmt.all(...this.params) as Record<string, unknown>[];
		const results = rows.map((row) => ({ ...row }) as T);
		return {
			success: true,
			meta: makeMeta(0, 0),
			results
		};
	}

	execRunSync<T = Record<string, unknown>>(): D1Result<T> {
		const stmt = this.db.prepare(this.sql);
		const info = stmt.run(...this.params);
		return {
			success: true,
			meta: makeMeta(Number(info.changes), Number(info.lastInsertRowid)),
			results: []
		};
	}

	execBatchItemSync<T = unknown>(): D1Result<T> {
		const stmt = this.db.prepare(this.sql);
		if (stmt.columns().length > 0) {
			const rows = stmt.all(...this.params) as Record<string, unknown>[];
			return {
				success: true,
				meta: makeMeta(0, 0),
				results: rows.map((row) => ({ ...row }) as T)
			};
		}
		const info = stmt.run(...this.params);
		return {
			success: true,
			meta: makeMeta(Number(info.changes), Number(info.lastInsertRowid)),
			results: []
		};
	}
}

/**
 * Create a Cloudflare D1Database-compatible wrapper over Node 24's built-in `node:sqlite`
 * (`DatabaseSync`), implementing the exact surface used by `src/lib/magic/db.ts` and
 * `src/lib/magic/cardImages.ts`.
 */
export function createSqliteD1(path: string): SqliteD1Database {
	const sqlite = new DatabaseSync(path, { timeout: 5000 });
	sqlite.exec('PRAGMA journal_mode = WAL;');
	sqlite.exec('PRAGMA busy_timeout = 5000;');

	const wrapper = {
		sqlite,
		close(): void {
			if (sqlite.isOpen) {
				sqlite.close();
			}
		},
		prepare(query: string): D1PreparedStatement {
			return new SqliteD1PreparedStatement(sqlite, query) as unknown as D1PreparedStatement;
		},
		async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			if (statements.length === 0) return [];
			sqlite.exec('BEGIN;');
			try {
				const out: D1Result<T>[] = [];
				for (const rawStmt of statements) {
					if (!(rawStmt instanceof SqliteD1PreparedStatement)) {
						throw new TypeError('sqliteD1.batch received a statement from another D1 instance');
					}
					out.push(rawStmt.execBatchItemSync<T>());
				}
				sqlite.exec('COMMIT;');
				return out;
			} catch (err) {
				try {
					sqlite.exec('ROLLBACK;');
				} catch {
					// Ignore rollback errors if SQLite already rolled back automatically.
				}
				throw err;
			}
		}
	};

	return wrapper as unknown as SqliteD1Database;
}
