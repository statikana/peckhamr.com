# Magic Backend (`homelab` mode) — Host Setup, Cutover & Operations Runbook

This runbook covers setting up the home-server Node 24 service (`magic-backend`), exposing it privately behind Cloudflare Tunnel, migrating Magic data between Cloudflare D1 (`cosmo_users`) and SQLite, and switching `magic.peckhamr.com/api/*` between `cloudflare` and `homelab` modes.

> **Prerequisite (Part 0 — App Subdomains):** Complete `ops/app-subdomains/README.md` first (or alongside cutover) so `magic.peckhamr.com` Custom Domain routing and Google/GitHub OAuth callback URLs (`https://magic.peckhamr.com/api/auth?action=callback&provider=google|github`) are configured.

---

## 1. Two Modes Overview (`MAGIC_MODE`)

One codebase supports both deployment modes, controlled by `MAGIC_MODE` in `wrangler.toml` `[vars]`:

| Setting | `cloudflare` (default) | `homelab` |
|---|---|---|
| **Where `/magic/api/*` runs** | Inside the Cloudflare Worker | Node 24 service on home server (Worker streams via `fetch`) |
| **Database** | Cloudflare D1 (`cosmo_users`, 6 Magic tables) | `/var/lib/magic-backend/magic.sqlite` (WAL mode) |
| **CPU limit** | Workers plan limit (10 ms Free / 30 s Paid) | None |
| **Required Worker config** | `MAGIC_MODE = "cloudflare"` (or unset) | `MAGIC_MODE = "homelab"`, `MAGIC_BACKEND_URL`, secret `MAGIC_PROXY_SECRET` |

Key invariants:
- Unset or unknown `MAGIC_MODE` defaults to `cloudflare`.
- `MAGIC_MODE = "homelab"` **never silently falls back** to D1: if `MAGIC_BACKEND_URL` or `MAGIC_PROXY_SECRET` is missing, `/api/*` returns `503` JSON naming the missing setting; if the tunnel/home server is unreachable or times out (>10 s), `/api/*` returns `503` JSON (`"The game server is offline. Try again in a minute."`).
- Check which mode is live at any time:
  ```bash
  curl -sS https://magic.peckhamr.com/api/healthz | jq .
  # cloudflare mode -> { "ok": true, "mode": "cloudflare", "version": 2, "dbOk": true }
  # homelab mode    -> { "ok": true, "mode": "homelab", "version": 2, "uptimeSec": ..., "dbOk": true }
  ```

---

## 2. Host Hardware & OS Setup (4.1)

1. **Hardware:** Any x86_64 or ARM64 mini PC (4+ cores, 8 GB RAM, SSD) on **wired Ethernet**.
2. **BIOS:** Enable **"Restore on AC/Power Loss" (Power On)** so the machine boots automatically after power outages (4.9).
3. **OS:** Install **Ubuntu Server 24.04 LTS** or **Debian 12**.
4. **Network:** Assign a static DHCP reservation on your router for the host's Ethernet MAC address.
5. **SSH & Automatic Security Updates:**
   ```bash
   sudo apt-get update && sudo apt-get install -y curl git ca-certificates gnupg unattended-upgrades
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
   Ensure `/etc/ssh/sshd_config` sets `PasswordAuthentication no` and `PermitRootLogin no`, then `sudo systemctl reload ssh`.

---

## 3. Node 24 Runtime, System User & Directories (4.2)

Install **Node.js 24.x** system-wide at `/usr/bin/node` via NodeSource (preferred over per-user `nvm` so systemd's `ProtectHome=true` and `ExecStart=/usr/bin/node` work cleanly without shell wrappers):

```bash
# 1. Install Node.js 24.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # Verify v24.x.x (includes built-in node:sqlite)

# 2. Create dedicated system user `magic` and directories
sudo useradd --system --user-group --home-dir /opt/magic-backend --create-home --shell /usr/sbin/nologin magic
sudo install -d -m 0755 -o magic -g magic /opt/magic-backend /opt/magic-backend/releases
sudo install -d -m 0700 -o magic -g magic /var/lib/magic-backend /var/lib/magic-backend/backups

# 3. Clone repository into /opt/magic-backend/repo owned by `magic`
sudo -u magic git clone https://github.com/statikana/peckhamr.com.git /opt/magic-backend/repo
```

---

## 4. Environment File `/etc/magic-backend.env` (2.5 & 4.3)

Copy the template and lock permissions to `0600` (`root:root`):

```bash
sudo cp /opt/magic-backend/repo/ops/magic-backend/magic-backend.env.example /etc/magic-backend.env
sudo chown root:root /etc/magic-backend.env
sudo chmod 0600 /etc/magic-backend.env
```

Generate a strong shared secret (save this value — you will also pass it to `wrangler secret put MAGIC_PROXY_SECRET`):

```bash
openssl rand -hex 32
```

Edit `sudo nano /etc/magic-backend.env` and populate:

| Variable | Source / Purpose |
|---|---|
| `HOST` | `127.0.0.1` (bind loopback only; `cloudflared` connects locally) |
| `PORT` | `8787` |
| `MAGIC_SQLITE_PATH` | `/var/lib/magic-backend/magic.sqlite` |
| `MAGIC_PROXY_SECRET` | 64-char hex secret matching Workers `MAGIC_PROXY_SECRET` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID (`getEnvVar` in `auth/+server.ts`) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret (`getEnvVar` in `auth/+server.ts`) |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID (`getEnvVar` in `auth/+server.ts`) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret (`getEnvVar` in `auth/+server.ts`) |
| `MAGIC_READ_ONLY` | `0` during normal operation; set `1` to reject `POST`s (`503`) during reverse migration |

*(Grepped across `src/routes/magic/**` and `src/lib/magic/**`: the four `GOOGLE_*` / `GITHUB_*` keys above are the only runtime variables read via `getEnvVar` by the Magic route handlers.)*

---

## 5. Systemd Service & Initial Build (4.4 & 4.6)

Install the systemd unit and run the initial build/deploy:

```bash
sudo cp /opt/magic-backend/repo/ops/magic-backend/magic-backend.service /etc/systemd/system/magic-backend.service
sudo systemctl daemon-reload
sudo systemctl enable magic-backend.service

# Build and activate the current release (fetches, runs npm ci + build:magic-backend, flips /opt/magic-backend/current, restarts, checks /healthz)
sudo /opt/magic-backend/repo/ops/magic-backend/deploy.sh origin/engine-rewrite

# Verify locally
curl -fsS http://127.0.0.1:8787/healthz
```

---

## 6. Cloudflare Tunnel (`cloudflared`) Setup (4.5)

Outbound-only tunnel — **no router port forwarding required**.

```bash
# 1. Install cloudflared (Debian/Ubuntu official package repo)
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# 2. Authenticate cloudflared with your peckhamr.com Cloudflare zone
cloudflared tunnel login

# 3. Create the tunnel (note the printed <TUNNEL-UUID> and credentials JSON path)
cloudflared tunnel create magic-backend

# 4. Route DNS hostname magic-backend.peckhamr.com to the tunnel
cloudflared tunnel route dns magic-backend magic-backend.peckhamr.com
```

Create `/etc/cloudflared/config.yml` (replace `<TUNNEL-UUID>` and credentials path if needed):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: magic-backend.peckhamr.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Copy the tunnel credentials file into `/etc/cloudflared/` (`chmod 0600`), install as a systemd service, and verify through the tunnel:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
curl -fsS https://magic-backend.peckhamr.com/healthz
# Expected: {"ok":true,"mode":"homelab","version":2,"uptimeSec":...,"dbOk":true}
```

### Optional Additional Hardening: Cloudflare Access Service Token
Every API request already requires the constant-time `X-Magic-Proxy-Secret` header before touching any handler or forwarded headers. If you also want Cloudflare's edge to block unauthenticated traffic before it ever traverses the tunnel:
1. In Cloudflare Zero Trust → **Access → Service Auth → Service Tokens**, create a token (`CF-Access-Client-Id` + `CF-Access-Client-Secret`).
2. Create an Access Application for `magic-backend.peckhamr.com` (bypassing `/healthz` if using an external uptime monitor) with a **Service Auth** policy allowing that token.
3. If enabled, add `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers in `src/hooks.server.ts` alongside `X-Magic-Proxy-Secret`.

---

## 7. Nightly SQLite Backups & Restore (4.7)

Install and enable the nightly systemd backup timer (`03:30` daily, keeps 14 days in `/var/lib/magic-backend/backups/magic-YYYYMMDD.sqlite` using online `VACUUM INTO` + `PRAGMA quick_check`):

```bash
sudo cp /opt/magic-backend/repo/ops/magic-backend/magic-backend-backup.service /etc/systemd/system/
sudo cp /opt/magic-backend/repo/ops/magic-backend/magic-backend-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now magic-backend-backup.timer

# Trigger an immediate test backup and check timer schedule
sudo systemctl start magic-backend-backup.service
sudo ls -lh /var/lib/magic-backend/backups/
systemctl list-timers magic-backend-backup.timer
```

### Optional Off-Box Backup Sync
To copy nightly snapshots off the machine (e.g., with `rclone` to Google Drive / S3 / B2), add a user/root cron or timer running after `03:45`:
```bash
rclone sync /var/lib/magic-backend/backups remote:peckhamr-backups/magic-backend
```

### Restoring from a Backup
```bash
sudo systemctl stop magic-backend.service
sudo rm -f /var/lib/magic-backend/magic.sqlite /var/lib/magic-backend/magic.sqlite-wal /var/lib/magic-backend/magic.sqlite-shm
sudo cp /var/lib/magic-backend/backups/magic-YYYYMMDD.sqlite /var/lib/magic-backend/magic.sqlite
sudo chown magic:magic /var/lib/magic-backend/magic.sqlite
sudo chmod 0600 /var/lib/magic-backend/magic.sqlite
sudo systemctl start magic-backend.service
curl -fsS http://127.0.0.1:8787/healthz
```

---

## 8. Routine Deploys, Monitoring & Power/Updates (4.6, 4.8, 4.9)

- **Deploy a new commit/branch on the home server:**
  ```bash
  sudo /opt/magic-backend/repo/ops/magic-backend/deploy.sh origin/main
  ```
  `deploy.sh` builds `dist/magic-backend/main.mjs`, stages `/opt/magic-backend/releases/<sha>/`, atomically flips `/opt/magic-backend/current`, restarts `magic-backend`, verifies `/healthz`, automatically rolls back the symlink if `/healthz` fails, and prunes releases beyond the newest 5.
- **Live logs & health checks (4.8):**
  ```bash
  sudo journalctl -u magic-backend.service -f
  curl -fsS https://magic-backend.peckhamr.com/healthz
  curl -fsS https://magic.peckhamr.com/api/healthz
  ```
  *(Optional: point UptimeRobot / BetterStack / Healthchecks at `https://magic-backend.peckhamr.com/healthz` — it exposes zero user or game data.)*
- **Reboots & updates (4.9):** `unattended-upgrades` applies security patches automatically. A monthly `sudo reboot` is safe — both `magic-backend.service` and `cloudflared.service` start automatically on boot.

---

## 9. Cutover Runbook: `cloudflare` → `homelab` (5.2 & 5.3)

Expected transition window: ~2–3 minutes. Active games, decks, sessions, and users carry over intact.

1. **Confirm home server + tunnel are healthy:**
   ```bash
   curl -fsS https://magic-backend.peckhamr.com/healthz
   # Must return {"ok":true,"mode":"homelab",...,"dbOk":true}
   ```
2. **Export Cloudflare D1 (`cosmo_users`) and extract Magic tables into SQLite (on your workstation):**
   ```bash
   npx wrangler d1 export cosmo_users --remote --output=/tmp/cosmo-d1-dump.sql
   node scripts/migrate-magic-d1-to-sqlite.mjs /tmp/cosmo-d1-dump.sql /tmp/magic.sqlite --force
   ```
   Verify the printed row counts for `MagicUsers`, `MagicSessions`, `MagicDecks`, `MagicLobbies`, `MagicChatMessages`, and `MagicCardImages`.
3. **Copy `magic.sqlite` to the home server and restart `magic-backend`:**
   ```bash
   scp /tmp/magic.sqlite <home-server>:/tmp/magic.sqlite
   ssh <home-server> '
     sudo systemctl stop magic-backend.service &&
     sudo rm -f /var/lib/magic-backend/magic.sqlite /var/lib/magic-backend/magic.sqlite-wal /var/lib/magic-backend/magic.sqlite-shm &&
     sudo mv /tmp/magic.sqlite /var/lib/magic-backend/magic.sqlite &&
     sudo chown magic:magic /var/lib/magic-backend/magic.sqlite &&
     sudo chmod 0600 /var/lib/magic-backend/magic.sqlite &&
     sudo systemctl start magic-backend.service &&
     curl -fsS http://127.0.0.1:8787/healthz
   '
   rm -f /tmp/cosmo-d1-dump.sql /tmp/magic.sqlite
   ```
4. **Configure Worker secret + `[vars]` and deploy:**
   ```bash
   # Enter the exact same MAGIC_PROXY_SECRET value stored in /etc/magic-backend.env
   npx wrangler secret put MAGIC_PROXY_SECRET
   ```
   In `wrangler.toml` under `[vars]`, set:
   ```toml
   [vars]
   MAGIC_MODE = "homelab"
   MAGIC_BACKEND_URL = "https://magic-backend.peckhamr.com"
   ```
   Build and deploy the Worker:
   ```bash
   npm run build
   npx wrangler deploy
   ```
5. **Post-cutover smoke test (6.2):**
   - `curl -fsS https://magic.peckhamr.com/api/healthz` → confirm `"mode": "homelab"`, `"ok": true`, `"dbOk": true`.
   - Open `https://magic.peckhamr.com`, sign in with Google/GitHub, open an existing deck, start a 4-player Commander game vs 3 bots, play through several turns (including combat and an activated ability menu such as Mind Stone).
   - Confirm `sudo journalctl -u magic-backend -n 50` shows fast `200` responses and `npx wrangler tail` shows zero `"Worker exceeded CPU time limit"` errors.
6. **D1 retention (5.3):** The Magic tables in D1 are intentionally left in place (not dropped) as your immediate point-in-time rollback copy.

---

## 10. Switching Back / Rollback: `homelab` → `cloudflare` (5.4, 5.5, 6.3)

> **Important (Workers Free CPU limit):** On the Cloudflare Workers Free plan (10 ms CPU/request), `cloudflare` mode will hit `"Worker exceeded CPU time limit"` on multi-bot turns. Full bot gameplay in `cloudflare` mode requires Workers Paid ($5/month, 30 s CPU/request).

### Planned Switch (Moving Data Back to D1)
1. **Freeze writes on `magic-backend`** so no new mutations land during export:
   - Either set `MAGIC_READ_ONLY=1` in `/etc/magic-backend.env` and `sudo systemctl restart magic-backend.service` (`POST` requests cleanly return `503` maintenance JSON while `GET` requests continue working), or `sudo systemctl stop magic-backend.service`.
2. **Create a consistent SQLite snapshot and export Magic SQL for D1:**
   ```bash
   ssh <home-server> 'sudo -u magic /opt/magic-backend/repo/ops/magic-backend/backup.sh'
   scp <home-server>:/var/lib/magic-backend/backups/magic-$(date -u +%Y%m%d).sqlite /tmp/magic-from-homelab.sqlite
   node scripts/migrate-magic-sqlite-to-d1.mjs /tmp/magic-from-homelab.sqlite /tmp/magic-to-d1.sql
   ```
3. **Import into Cloudflare D1 (`cosmo_users`):**
   ```bash
   npx wrangler d1 execute cosmo_users --remote --file=/tmp/magic-to-d1.sql
   rm -f /tmp/magic-from-homelab.sqlite /tmp/magic-to-d1.sql
   ```
   *(Only the 6 Magic tables are `DELETE`d and `INSERT`ed; Cosmo, Notes, and other tables in `cosmo_users` are untouched.)*
4. **Flip `MAGIC_MODE` back to `cloudflare` and deploy:**
   In `wrangler.toml`:
   ```toml
   [vars]
   MAGIC_MODE = "cloudflare"
   # MAGIC_BACKEND_URL = "https://magic-backend.peckhamr.com"
   ```
   ```bash
   npm run build
   npx wrangler deploy
   curl -fsS https://magic.peckhamr.com/api/healthz
   # Verify: {"ok":true,"mode":"cloudflare","version":2,"dbOk":true}
   ```

### Emergency Instant Rollback (Home Server Unreachable)
If the home server or ISP goes down and you want immediate read/lobby access without waiting to copy SQLite data:
1. Set `MAGIC_MODE = "cloudflare"` in `wrangler.toml`, run `npm run build && npx wrangler deploy`.
2. `magic.peckhamr.com` immediately serves the D1 snapshot from the last migration. When the home server returns, re-sync data if needed before switching back to `homelab`.
