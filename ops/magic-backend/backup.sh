#!/usr/bin/env bash
# Create a consistent online SQLite snapshot of magic.sqlite and prune backups older than 14 days.
# Safe to run while magic-backend is serving requests under WAL mode.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/magic-backend}"
DB_PATH="${MAGIC_SQLITE_PATH:-${DATA_DIR}/magic.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-${DATA_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

if [[ ! -f "${DB_PATH}" ]]; then
	echo "[backup] Database file ${DB_PATH} does not exist yet; skipping backup."
	exit 0
fi

umask 0077
mkdir -p "${BACKUP_DIR}"

STAMP="$(date -u +%Y%m%d)"
FINAL_FILE="${BACKUP_DIR}/magic-${STAMP}.sqlite"
TMP_FILE="${BACKUP_DIR}/.magic-${STAMP}.sqlite.tmp.$$"

rm -f -- "${TMP_FILE}"

# Use Node 24's built-in node:sqlite with VACUUM INTO so no extra apt packages are required,
# and verify integrity of the resulting snapshot with PRAGMA quick_check.
"${NODE_BIN}" --input-type=module - "${DB_PATH}" "${TMP_FILE}" <<'NODE_EOF'
import { DatabaseSync } from 'node:sqlite';

const [srcPath, dstPath] = process.argv.slice(2);
const escapedDst = dstPath.replace(/'/g, "''");

const src = new DatabaseSync(srcPath, { timeout: 10000, readOnly: true });
try {
	src.exec(`VACUUM INTO '${escapedDst}';`);
} finally {
	src.close();
}

const checkDb = new DatabaseSync(dstPath, { readOnly: true });
try {
	const row = checkDb.prepare('PRAGMA quick_check;').get();
	const result = row ? Object.values(row)[0] : '';
	if (result !== 'ok') {
		throw new Error(`Backup integrity check failed: ${result}`);
	}
} finally {
	checkDb.close();
}
NODE_EOF

chmod 0600 "${TMP_FILE}"
mv -f "${TMP_FILE}" "${FINAL_FILE}"
echo "[backup] Created verified snapshot ${FINAL_FILE}"

# Keep the last ${RETENTION_DAYS} days of daily snapshots
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'magic-*.sqlite' -mtime +"${RETENTION_DAYS}" -print -delete
