#!/usr/bin/env bash
# Deploy a release of magic-backend on the home server with atomic symlink swap and automatic rollback.
# Usage: sudo ./ops/magic-backend/deploy.sh [git-ref]
#   git-ref defaults to origin/engine-rewrite (or set DEFAULT_REF / pass a branch, tag, or commit SHA).

set -euo pipefail

REF="${1:-${DEFAULT_REF:-origin/engine-rewrite}}"
BASE_DIR="${BASE_DIR:-/opt/magic-backend}"
REPO_DIR="${REPO_DIR:-${BASE_DIR}/repo}"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
SERVICE_NAME="${SERVICE_NAME:-magic-backend.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/healthz}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
RUN_AS_USER="${RUN_AS_USER:-magic}"

run_as_magic() {
	if [[ "$(id -un)" == "${RUN_AS_USER}" ]]; then
		"$@"
	else
		sudo -u "${RUN_AS_USER}" -- "$@"
	fi
}

if [[ ! -d "${REPO_DIR}/.git" ]]; then
	echo "[deploy] Error: git checkout not found at ${REPO_DIR}" >&2
	echo "[deploy] Clone the repository to ${REPO_DIR} owned by ${RUN_AS_USER} first (see ops/magic-backend/README.md)." >&2
	exit 1
fi

echo "[deploy] Fetching latest refs in ${REPO_DIR}..."
run_as_magic git -C "${REPO_DIR}" fetch --all --tags --prune
run_as_magic git -C "${REPO_DIR}" checkout --detach "${REF}"

GIT_SHA="$(run_as_magic git -C "${REPO_DIR}" rev-parse --short=12 HEAD)"
RELEASE_DIR="${RELEASES_DIR}/${GIT_SHA}"
echo "[deploy] Building release ${GIT_SHA} (from ${REF})..."

run_as_magic bash -c "cd '${REPO_DIR}' && npm ci && npm run build:magic-backend"

run_as_magic mkdir -p "${RELEASE_DIR}"
run_as_magic cp -f "${REPO_DIR}/dist/magic-backend/"* "${RELEASE_DIR}/"

PREV_TARGET=""
if [[ -L "${CURRENT_LINK}" ]]; then
	PREV_TARGET="$(readlink -f "${CURRENT_LINK}" || true)"
fi

echo "[deploy] Switching ${CURRENT_LINK} -> ${RELEASE_DIR}"
TMP_LINK="${CURRENT_LINK}.next.$$"
run_as_magic ln -sfn "${RELEASE_DIR}" "${TMP_LINK}"
run_as_magic mv -Tf "${TMP_LINK}" "${CURRENT_LINK}"

echo "[deploy] Restarting ${SERVICE_NAME}..."
systemctl restart "${SERVICE_NAME}"

check_health() {
	local attempt
	for attempt in {1..15}; do
		if curl -fsS --max-time 2 "${HEALTH_URL}" | grep -q '"ok":true'; then
			return 0
		fi
		sleep 1
	done
	return 1
}

if check_health; then
	echo "[deploy] Health check passed at ${HEALTH_URL} (release ${GIT_SHA})."
else
	echo "[deploy] ERROR: Health check failed at ${HEALTH_URL}!" >&2
	if [[ -n "${PREV_TARGET}" && -d "${PREV_TARGET}" ]]; then
		echo "[deploy] Rolling back ${CURRENT_LINK} -> ${PREV_TARGET}" >&2
		ROLLBACK_TMP="${CURRENT_LINK}.rollback.$$"
		run_as_magic ln -sfn "${PREV_TARGET}" "${ROLLBACK_TMP}"
		run_as_magic mv -Tf "${ROLLBACK_TMP}" "${CURRENT_LINK}"
		systemctl restart "${SERVICE_NAME}"
	fi
	exit 1
fi

# Prune older releases, keeping the newest ${KEEP_RELEASES} (never deleting the active target)
ACTIVE_REAL="$(readlink -f "${CURRENT_LINK}")"
mapfile -t OLD_DIRS < <(ls -1dt "${RELEASES_DIR}"/* 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" || true)
for dir in "${OLD_DIRS[@]}"; do
	if [[ -n "${dir}" && "$(readlink -f "${dir}")" != "${ACTIVE_REAL}" ]]; then
		echo "[deploy] Pruning old release ${dir}"
		rm -rf -- "${dir}"
	fi
done

echo "[deploy] Done."
