# App Subdomains Runbook (`Part 0`)

This runbook covers the Cloudflare dashboard checks, OAuth callback updates, and post-deploy checks for moving each app from `peckhamr.com/<app>/` to `<app>.peckhamr.com`.

## 1. Pre-Deploy Cloudflare Dashboard Check (Step 0.5)

`wrangler.toml` declares `routes` with `custom_domain = true` for the apex and all six app subdomains:

- `peckhamr.com`
- `magic.peckhamr.com`
- `cosmo.peckhamr.com`
- `notes.peckhamr.com`
- `media.peckhamr.com`
- `convert.peckhamr.com`
- `terminal.peckhamr.com`

Before running `npx wrangler deploy`:

1. Open the **Cloudflare Dashboard → Workers & Pages → `peckhamr` → Settings → Domains & Routes**.
2. Check how `peckhamr.com` (and `www.peckhamr.com`, if configured) is currently attached:
   - If `peckhamr.com` is already attached as a **Custom Domain** on this same `peckhamr` Worker, Wrangler will reconcile `{ pattern = "peckhamr.com", custom_domain = true }` cleanly.
   - If `peckhamr.com/*` is attached as a **Zone Route** (not a Custom Domain) or attached to a *different* Worker/Pages project, remove that conflicting route/binding first (or comment out the `peckhamr.com` entry in `wrangler.toml` if keeping an existing zone route) so `wrangler deploy` does not fail with a duplicate-hostname error.
   - Check **DNS → Records** on `peckhamr.com` to ensure none of `magic`, `cosmo`, `notes`, `media`, `convert`, or `terminal` already have conflicting `A`/`AAAA`/`CNAME` records; Cloudflare Custom Domains automatically provision managed DNS records and TLS certificates on deploy.
   - If `www.peckhamr.com` currently routes to this Worker (or via a Cloudflare Redirect Rule to `peckhamr.com`), keep it as-is (`src/hooks.server.ts` also redirects `www.peckhamr.com/<app>...` → `https://<app>.peckhamr.com/...`).

## 2. Sessions, Cookies, and Browser Storage (Step 0.6)

- **Cookies (`magic_session`, `magic_oauth_state`)**: Kept host-only (`Path=/; HttpOnly; SameSite=Lax`, no `Domain` attribute) on `magic.peckhamr.com`.
  - Existing users logged in on `peckhamr.com` will sign in once on `magic.peckhamr.com`.
  - Existing guests on `peckhamr.com` will get a new guest identity on `magic.peckhamr.com`.
- **Browser storage (`localStorage` / `sessionStorage`)**: Kept per-origin without cross-domain migration:
  - `peckhamr-theme` (`light` | `dark`) starts at default `light` per subdomain.
  - `magic-arena-layout` starts at default panel dimensions on `magic.peckhamr.com`.
  - `magic_session_token` (`sessionStorage`) remains per-tab.

## 3. OAuth Callback URLs & Cutover Timing (Step 0.7)

### Exact Callback URLs

| Provider | New Callback URL (Subdomain) | Legacy Callback URL (Path) |
|---|---|---|
| **Google Cloud OAuth Client** | `https://magic.peckhamr.com/api/auth?action=callback&provider=google` | `https://peckhamr.com/magic/api/auth?action=callback&provider=google` |
| **GitHub OAuth App** | `https://magic.peckhamr.com/api/auth?action=callback&provider=github` | `https://peckhamr.com/magic/api/auth?action=callback&provider=github` |

### Cutover Sequence

1. **Before `wrangler deploy` — Google Cloud Console**:
   - Navigate to **APIs & Services → Credentials → OAuth 2.0 Client IDs**.
   - Under **Authorized JavaScript origins**, add `https://magic.peckhamr.com` (keep `https://peckhamr.com`).
   - Under **Authorized redirect URIs**, **add** `https://magic.peckhamr.com/api/auth?action=callback&provider=google` alongside the existing `https://peckhamr.com/magic/api/auth?action=callback&provider=google`.
   - Save. Keep the legacy redirect URI until the subdomain redirects have been live for a while, then remove it when convenient.
2. **At `wrangler deploy` — GitHub Developer Settings**:
   - GitHub OAuth Apps allow only **one** Authorization callback URL per app.
   - Immediately when deploying the Worker (`npx wrangler deploy`), open **GitHub → Settings → Developer settings → OAuth Apps → (your Magic OAuth app)**:
     - Update **Homepage URL** to `https://magic.peckhamr.com`
     - Switch **Authorization callback URL** from `https://peckhamr.com/magic/api/auth?action=callback&provider=github` to:
       ```text
       https://magic.peckhamr.com/api/auth?action=callback&provider=github
       ```
     - Click **Update application**.
3. **After `wrangler deploy` — Local Daemons / iOS Shortcuts**:
   - Update local `cosmo` scripts / iOS Shortcuts from `https://peckhamr.com/cosmo` (or `/cosmo/api`) to `https://cosmo.peckhamr.com/api` (or `https://cosmo.peckhamr.com/`).
   - Update local `notes` sync scripts (`X-Notes-Sync-Key`) from `https://peckhamr.com/notes/api` to `https://notes.peckhamr.com/api` (HTTP clients often strip custom auth headers across cross-host `308` redirects).
