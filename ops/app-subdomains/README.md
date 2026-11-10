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
