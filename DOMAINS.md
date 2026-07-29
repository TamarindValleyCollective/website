# Domains & DNS

> **Keep this file up to date.** Whenever a domain, registrar, DNS provider, or redirect
> relationship changes for `tvc.farm` or `syntropic.in`, update this doc in the same change.
> See the note in `CLAUDE.md`.

## The short version

**Squarespace registers both domains. Neither one's DNS is actually hosted at Squarespace.**
That's the one fact that makes the whole setup click:

| | `tvc.farm` | `syntropic.in` |
|---|---|---|
| **Role** | The live site | Old member-directory domain — redirects here now |
| **Registrar** | **Squarespace Domains** (renews 2026-11-19, WHOIS privacy on) | **Squarespace Domains** (renews 2026-08-20, registrant: Sharath Jeppu) |
| **DNS host** | **Cloudflare** (`adaline.ns.cloudflare.com`, `cartman.ns.cloudflare.com`) | **Netlify DNS** (`dns1-4.p05.nsone.net`) |
| **Path to Netlify** | Cloudflare proxies (orange-cloud) straight to the Netlify site | A `NETLIFY`-type DNS record points at `tvc-farm.netlify.app`; no Cloudflare involved |
| **What visitors see** | The actual site | A 301 redirect to `https://tvc.farm/:splat`, applied by a `netlify.toml` rule — not a DNS-level redirect |

Both domains are registered through the same Squarespace account, but each was pointed at a
*different* third-party DNS host at different times — `tvc.farm` at Cloudflare early on (see
`ARCHITECTURE.md`'s "Cloudflare (in front of Netlify)" section), `syntropic.in` at Netlify DNS
later, when it was added as a domain alias (2026-07-26). Squarespace's own DNS product isn't in
the loop for either domain — it's registrar-only for both.

## Why this matters in practice

- **Squarespace's DNS panel is inert for both domains.** Visiting DNS Settings for either
  `tvc.farm` or `syntropic.in` in Squarespace shows a "You're using custom nameservers" warning —
  anything entered there (Squarespace even has a pre-existing "Email Forwarding" MX preset
  configured for `tvc.farm`, pointing at `mxa/mxb.mailgun.org`) never takes effect, since
  Squarespace isn't the authoritative host for either domain's DNS. Confirmed: `tvc.farm`'s
  live mail actually flows through Google Workspace (`dig MX tvc.farm` → `aspmx.l.google.com`
  and friends) via Cloudflare's real DNS zone, not that dormant Mailgun preset.
- **Netlify's dashboard lists a DNS zone for `tvc.farm` too** (Team → DNS shows both domains side
  by side). That zone is **also not actually authoritative** — `tvc.farm`'s real nameservers are
  Cloudflare's, confirmed via `dig NS tvc.farm`. Don't assume a record added to that Netlify zone
  for `tvc.farm` will ever go live; it won't unless the domain's nameservers are switched to
  Netlify's, which they aren't and aren't planned to be.
- **`syntropic.in`'s Netlify DNS zone is the one that's actually live.** Records added there (an
  apex + `www` `NETLIFY` record pointing at `tvc-farm.netlify.app`, plus a TXT record — see below)
  go live immediately; propagation in practice has been near-instant.
- **To change DNS for either domain, go to Netlify or Cloudflare — never Squarespace.**
  `tvc.farm` → Cloudflare dashboard. `syntropic.in` → Netlify (Team → DNS → `syntropic.in`).
  Squarespace is purely where renewal/WHOIS-privacy/registrant details live for both.
- **Cloudflare R2** (`media.tvc.farm`, the curated photo store) is a separate product under the
  same Cloudflare account used for `tvc.farm`'s DNS — see `ARCHITECTURE.md`'s "Cloudflare R2"
  section. It has nothing to do with `syntropic.in`.

## `tvc.farm`

- **Registrar**: Squarespace Domains (`account.squarespace.com/domains/managed/tvc.farm`) —
  renews 2026-11-19 for $50, WHOIS privacy on (so a plain `whois tvc.farm` lookup returns only
  the `.farm` registry's own referral info, not registrant/registrar details).
- **DNS**: Cloudflare, proxied (orange-cloud) — see `ARCHITECTURE.md` for the full hosting
  picture. Confirmed via `dig NS tvc.farm`:
  ```
  adaline.ns.cloudflare.com.
  cartman.ns.cloudflare.com.
  ```
- Cloudflare terminates the connection and proxies to Netlify, which serves the actual Astro
  site (visible via the `server: cloudflare` header alongside Netlify's own `x-nf-request-id`).
- `media.tvc.farm` resolves to the same Cloudflare anycast IPs as the apex — it's a custom
  domain connected directly to the `tvc-photos` R2 bucket, proxied through Cloudflare's edge,
  but not routed through Netlify at all.
- **Mail**: live MX records (`dig MX tvc.farm`) point to Google Workspace
  (`aspmx.l.google.com` and its alternates), set directly in Cloudflare's DNS zone — not the
  Mailgun-based "Email Forwarding" preset sitting inert in Squarespace's DNS panel (see above).

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
