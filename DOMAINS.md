# Domains & DNS

> **Keep this file up to date.** Whenever a domain, registrar, DNS provider, or redirect
> relationship changes for `tvc.farm` or `syntropic.in`, update this doc in the same change.
> See the note in `CLAUDE.md`.

## The short version

Two domains, two completely different DNS setups, one destination:

| | `tvc.farm` | `syntropic.in` |
|---|---|---|
| **Role** | The live site | Old member-directory domain — redirects here now |
| **Registrar** | Not confirmed in this session (Squarespace is **not** involved) | **Squarespace Domains** (registrant: Sharath Jeppu) |
| **DNS host** | **Cloudflare** (`adaline.ns.cloudflare.com`, `cartman.ns.cloudflare.com`) | **Netlify DNS** (`dns1-4.p05.nsone.net`) |
| **Path to Netlify** | Cloudflare proxies (orange-cloud) straight to the Netlify site | A `NETLIFY`-type DNS record points at `tvc-farm.netlify.app`; no Cloudflare involved |
| **What visitors see** | The actual site | A 301 redirect to `https://tvc.farm/:splat`, applied by a `netlify.toml` rule — not a DNS-level redirect |

The two domains don't share a DNS provider. That's not a deliberate design choice, it's just how
each one happened to get set up — `tvc.farm` was pointed at Cloudflare early on (see
`ARCHITECTURE.md`'s "Cloudflare (in front of Netlify)" section), while `syntropic.in` was added
later as a Netlify domain alias (2026-07-26) and given a **Netlify-managed** DNS zone directly,
skipping Cloudflare entirely.

## Why this matters in practice

- **Netlify's dashboard lists a DNS zone for `tvc.farm` too** (Team → DNS shows both domains side
  by side). That zone is **not actually authoritative** — `tvc.farm`'s real nameservers are
  Cloudflare's, confirmed via `dig NS tvc.farm`. Don't assume a record added to that Netlify zone
  for `tvc.farm` will ever go live; it won't unless the domain's nameservers are switched to
  Netlify's, which they aren't and aren't planned to be.
- **`syntropic.in`'s Netlify DNS zone is the real one.** Records added there (an apex + `www`
  `NETLIFY` record pointing at `tvc-farm.netlify.app`, plus a TXT record — see below) go live
  immediately; propagation in practice has been near-instant.
- **Squarespace only handles registration for `syntropic.in`**, not DNS. Its own DNS Settings
  panel shows a "You're using custom nameservers" warning for exactly this reason — anything
  entered there is inert since Squarespace isn't the authoritative host. To change `syntropic.in`'s
  DNS, go to Netlify (Team → DNS → `syntropic.in`), not Squarespace.
- **Cloudflare R2** (`media.tvc.farm`, the curated photo store) is a separate product under the
  same Cloudflare account used for `tvc.farm`'s DNS — see `ARCHITECTURE.md`'s "Cloudflare R2"
  section. It has nothing to do with `syntropic.in`.

## `tvc.farm`

- DNS: Cloudflare, proxied (orange-cloud) — see `ARCHITECTURE.md` for the full hosting picture.
- Confirmed via `dig NS tvc.farm`:
  ```
  adaline.ns.cloudflare.com.
  cartman.ns.cloudflare.com.
  ```
- Cloudflare terminates the connection and proxies to Netlify, which serves the actual Astro
  site (visible via the `server: cloudflare` header alongside Netlify's own `x-nf-request-id`).
- `media.tvc.farm` resolves to the same Cloudflare anycast IPs as the apex — it's a custom
  domain connected directly to the `tvc-photos` R2 bucket, proxied through Cloudflare's edge,
  but not routed through Netlify at all.

## `syntropic.in`

- **Registrar**: Squarespace Domains (`account.squarespace.com/domains/managed/syntropic.in`) —
  registrant Sharath Jeppu, renews 2026-08-20. This is a holdover from Google Domains' migration
  to Squarespace; the underlying registry backend (Key-Systems GmbH / RRPProxy) predates that
  move.
- **DNS**: Netlify DNS, added 2026-07-26. Confirmed via `dig NS syntropic.in`:
  ```
  dns1.p05.nsone.net.
  dns2.p05.nsone.net.
  dns3.p05.nsone.net.
  dns4.p05.nsone.net.
  ```
  (Netlify's own managed-DNS product runs on NS1 infrastructure — this `dns#.pXX.nsone.net`
  pattern is how any Netlify DNS zone's nameservers look, not something specific to this domain.)
- **Records** (Team → DNS → `syntropic.in` in Netlify):
  - `syntropic.in` — `NETLIFY` → `tvc-farm.netlify.app`
  - `www.syntropic.in` — `NETLIFY` → `tvc-farm.netlify.app`
  - `syntropic.in` — `TXT` → `google-site-verification=...` (added 2026-07-29, see below)
- **Redirect**: `netlify.toml` force-redirects both hostnames to `https://tvc.farm/:splat` with a
  301 — this is a Netlify-level redirect rule, not a DNS trick, so it only takes effect because
  Netlify (not Cloudflare, not Squarespace) is the thing actually serving the request.
- **History**: used to run a separate, live Wix-hosted site (a member directory). That site is
  gone; the domain now exists purely to catch old links/bookmarks/search results and forward them
  to `tvc.farm`.

## Google Search Console verification (2026-07-29)

`syntropic.in` still ranked in Google search with a stale snippet from its old Wix-hosted days,
even though it now 301s to `tvc.farm`. Fixed by:

1. Verifying `syntropic.in` as its own Search Console property via a DNS TXT record (added to
   Netlify DNS, per above — Squarespace's DNS panel couldn't be used since it isn't authoritative).
2. Running Search Console's **Change of Address** tool (Settings → Change of address) to
   explicitly tell Google `syntropic.in` → `tvc.farm`, since both required checks (301-redirect
   from homepage, verification of both sites) passed. Status: confirmed moving, dated 2026-07-29.
3. Requesting re-indexing on `https://syntropic.in/` directly via URL Inspection.

Google's own consolidation of the two properties' index entries can take days to weeks after
this; no further action is needed unless it stalls.
