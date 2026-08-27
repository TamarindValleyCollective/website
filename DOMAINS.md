# Domains & DNS

> **Keep this file up to date.** Whenever a domain, registrar, DNS provider, or redirect
> relationship changes for `tvc.farm` or `syntropic.in`, update this doc in the same change.
> See the note in `CLAUDE.md`.

## The short version

**Both domains' DNS is now on Cloudflare.** `syntropic.in` moved off Netlify DNS onto Cloudflare
at some point after 2026-07-29 (exact date not captured — noticed 2026-08-27 while checking this
doc for drift); `tvc.farm`'s registrar is separately being moved from Squarespace to Cloudflare
too (transfer initiated 2026-08-27, DNS already at Cloudflare beforehand):

| | `tvc.farm` | `syntropic.in` |
|---|---|---|
| **Role** | The live site | Old member-directory domain — redirects here now |
| **Registrar** | **Transfer in progress: Squarespace Domains → Cloudflare Registrar** (initiated 2026-08-27). Squarespace pricing was $50/year; Cloudflare's is $30.20/year (at-cost, no markup). | **Squarespace Domains** (renews 2027-08-20 for $20, registrant: Sharath Jeppu) |
| **DNS host** | **Cloudflare** (`adaline.ns.cloudflare.com`, `cartman.ns.cloudflare.com`) | **Cloudflare** — same two nameservers, same account. Was Netlify DNS as of 2026-07-29; migrated since |
| **Path to Netlify** | Cloudflare proxies (orange-cloud) straight to the Netlify site, via a CNAME to `tvc.netlify.app` | Apex is an **A record → `75.2.60.5`** (Netlify's shared load-balancer IP), proxied; `www` is a CNAME to `tvc.netlify.app`, proxied — same pattern as `tvc.farm` |
| **What visitors see** | The actual site | A 301 redirect to `https://tvc.farm/`, applied by a `netlify.toml` rule — not a DNS-level redirect |

`syntropic.in` is still registered through Squarespace, but its DNS is no longer at Netlify —
it's on Cloudflare now, in the same Cloudflare account as `tvc.farm` (see
`ARCHITECTURE.md`'s "Cloudflare (in front of Netlify)" section for `tvc.farm`'s side of this).
`tvc.farm` used to be registered at Squarespace too, alongside `syntropic.in`, until the
registrar transfer to Cloudflare above. Squarespace's own DNS product was never in the loop for
either domain — it's (or, for `tvc.farm`, was) registrar-only.

## Why this matters in practice

- **Squarespace's DNS panel is inert for both domains.** Visiting DNS Settings for either
  `tvc.farm` or `syntropic.in` in Squarespace shows a "You're using custom nameservers" warning —
  anything entered there (Squarespace even has a pre-existing "Email Forwarding" MX preset
  configured for `tvc.farm`, pointing at `mxa/mxb.mailgun.org`) never takes effect, since
  Squarespace isn't the authoritative host for either domain's DNS. Confirmed: `tvc.farm`'s
  live mail actually flows through Google Workspace (`dig MX tvc.farm` → `aspmx.l.google.com`
  and friends) via Cloudflare's real DNS zone, not that dormant Mailgun preset.
- **Netlify's dashboard may still list a DNS zone for either domain** (Team → DNS). Neither is
  authoritative — both domains' real nameservers are Cloudflare's, confirmed via `dig NS`. Don't
  assume a record added in Netlify's DNS UI for either domain will ever go live; it won't unless
  the domain's nameservers are switched to Netlify's, which they aren't and aren't planned to be.
- **Both domains' DNS zones live in Cloudflare now** (same Cloudflare account, "TVC"). Records
  added there go live immediately; propagation in practice has been near-instant.
- **To change DNS for either domain, go to Cloudflare — never Netlify's DNS UI, never
  Squarespace.** Squarespace is purely where renewal/WHOIS-privacy/registrant details live for
  `syntropic.in`; for `tvc.farm` that's moving to Cloudflare too, per the registrar transfer
  above.
- **2026-08-27 incident**: `syntropic.in`'s DNS migration to Cloudflare left two things broken,
  found while auditing this doc and fixed the same day: the `www.syntropic.in` CNAME record was
  missing entirely (NXDOMAIN — Cloudflare's own dashboard flagged "Visitors cannot reach
  www.syntropic.in"), and the Search Console domain-ownership verification TXT record was gone,
  which had silently revoked `contact@tvc.farm`'s access to the `syntropic.in` property. Fixed by
  adding a `www` CNAME → `tvc.netlify.app` (proxied, matching `tvc.farm`'s pattern) and
  re-verifying Search Console ownership — which auto-verified via the "Domain name provider"
  method (Google's direct integration with Cloudflare as DNS host) with no TXT record needed.
  Neither fix touched the MX/DKIM/SPF/DMARC records (see mail setup below).
- **Cloudflare R2** (`media.tvc.farm`, the curated photo store) is a separate product under the
  same Cloudflare account used for `tvc.farm`'s DNS — see `ARCHITECTURE.md`'s "Cloudflare R2"
  section. It has nothing to do with `syntropic.in`.

## `tvc.farm`

- **Registrar**: transferring from Squarespace Domains
  (`account.squarespace.com/domains/managed/tvc.farm`, renewed 2026-11-19 for $50) to
  **Cloudflare Registrar**, initiated 2026-08-27. Cloudflare charges at-cost with no markup —
  $30.20/year for `.farm`, versus Squarespace's $50/year. DNS was already on Cloudflare before
  this (see above); this transfer only moves where the domain is *registered*, not where its DNS
  is hosted. WHOIS privacy was on at Squarespace (a plain `whois tvc.farm` lookup returned only
  the `.farm` registry's own referral info, not registrant/registrar details) — Cloudflare
  Registrar includes free WHOIS privacy too, so this should carry over once the transfer
  completes.
- **DNS**: Cloudflare, proxied (orange-cloud) — see `ARCHITECTURE.md` for the full hosting
  picture. Confirmed via `dig NS tvc.farm`:
  ```
  adaline.ns.cloudflare.com.
  cartman.ns.cloudflare.com.
  ```
- Cloudflare terminates the connection and proxies to Netlify, which serves the actual Astro
  site (visible via the `server: cloudflare` header alongside Netlify's own `x-nf-request-id`).
  Both `tvc.farm` and `www.tvc.farm` are CNAMEd to `tvc.netlify.app` — but that specific
  `*.netlify.app` hostname doesn't serve the site on its own (it 307s to Netlify's generic
  "select-mode" page); the actual Netlify project's slug is `tvc-farm`
  (`tvc-farm.netlify.app`, 200 OK). This isn't broken: Netlify's edge routes custom domains by
  the request's `Host` header, not by which specific `*.netlify.app` alias reached it, so the
  mismatch is a harmless leftover — most likely `tvc.netlify.app` was the project's original
  default subdomain before a later rename to `tvc-farm`.
- `media.tvc.farm` resolves to the same Cloudflare anycast IPs as the apex — it's a custom
  domain connected directly to the `tvc-photos` R2 bucket, proxied through Cloudflare's edge,
  but not routed through Netlify at all.
- `docs.tvc.farm` → CNAME → `tvc-docs.pages.dev` (proxied) — a separate site entirely,
  **Cloudflare Pages** running **Quartz** (confirmed via `<meta name="generator" content="Quartz"/>`
  in the page source), most likely publishing an Obsidian vault. Not part of the Netlify hosting
  path at all — no `x-nf-request-id` header on responses from this subdomain.
- **Mail**: live MX records (`dig MX tvc.farm`) point to Google Workspace
  (`aspmx.l.google.com` and its alternates), set directly in Cloudflare's DNS zone — not the
  Mailgun-based "Email Forwarding" preset sitting inert in Squarespace's DNS panel (see above).
  DKIM is configured (a `google._domainkey.tvc.farm` TXT record) and so is DMARC
  (`_dmarc.tvc.farm` → `v=DMARC1; p=none;`, policy set to monitor-only rather than
  reject/quarantine). **SPF is still missing** — worth adding, since DKIM+DMARC alone don't stop
  someone else from sending spoofed mail that claims to be from `@tvc.farm` as effectively as SPF
  would. Other TXT records on the apex handle Google/Bing/Apple domain-verification, unrelated to
  mail.
- A handful of other `tvc.farm` subdomains exist for internal tooling, routed through a
  Cloudflare Tunnel rather than exposed directly — intentionally not detailed here since this
  repo is public; see the separate (non-repo) internal-infrastructure note for those.

## `syntropic.in`

- **Registrar**: Squarespace Domains (`account.squarespace.com/domains/managed/syntropic.in`) —
  registrant Sharath Jeppu, renewed 2026-08-27 through 2027-08-20 for $20. This is a holdover
  from Google Domains' migration to Squarespace; the underlying registry backend (Key-Systems
  GmbH / RRPProxy) predates that move. (Not part of the `tvc.farm` registrar transfer above —
  `syntropic.in` stays at Squarespace.)
- **DNS**: Cloudflare, same account as `tvc.farm` ("TVC"). Confirmed via `dig NS syntropic.in`:
  ```
  adaline.ns.cloudflare.com.
  cartman.ns.cloudflare.com.
  ```
  This used to be Netlify DNS (added 2026-07-26, on `dns#.p05.nsone.net`) as documented here as of
  2026-07-29; it had moved to Cloudflare by the time this was rechecked on 2026-08-27. The exact
  migration date wasn't captured.
- **Records** (Cloudflare dashboard → `syntropic.in` → DNS → Records; 15 of 200 used):
  - `syntropic.in` — `A` → `75.2.60.5` (Netlify's shared load-balancer IP), proxied
  - `www.syntropic.in` — `CNAME` → `tvc.netlify.app`, proxied (added 2026-08-27 — see incident
    note above; this record was missing and `www.syntropic.in` was NXDOMAIN until then)
  - `_domainconnect.syntropic.in` — `CNAME` → `_domainconnect.domains.squarespace.com`, proxied
    (a Squarespace Domain Connect artifact, harmless leftover from the registrar)
  - Full Google Workspace mail setup — 5 `MX` records to `aspmx.l.google.com` and its alternates,
    `google._domainkey.syntropic.in` DKIM TXT, `_dmarc.syntropic.in` → `v=DMARC1; p=none;
    rua=mailto:contact@tvc.farm`, and an SPF TXT (`v=spf1 include:_spf.google.com ~all`) — none of
    this was here as of 2026-07-29; whether `@syntropic.in` mail is actually in active use wasn't
    checked, only that the records now mirror `tvc.farm`'s
  - `_gh-tamarindvalleycollective-o.syntropic.in` — TXT, a GitHub organization domain-verification
    token
  - Two more TXT records: `facebook-domain-verification=...` and a bare UUID-format value
    (`2db57230-dfc6-11f0-9c6d-4d862bebf89d`) whose origin/purpose wasn't identified
  - `syntropic.in` — `TXT` → `google-site-verification=iIyHUHznY6GWBRjwxGXjhO_0w_JtepIH5mzV0Tvlp8I`
    (added 2026-08-27, replacing the record documented here as of 2026-07-29 that had gone
    missing — see the Search Console section below)
- **Redirect**: `netlify.toml` force-redirects both hostnames to `https://tvc.farm/:splat` with a
  301 — this is a Netlify-level redirect rule, not a DNS trick, so it only takes effect because
  Netlify (not Cloudflare, not Squarespace) is the thing actually serving the request, once
  Cloudflare has proxied it there.
- **History**: used to run a separate, live Wix-hosted site (a member directory). That site is
  gone; the domain now exists purely to catch old links/bookmarks/search results and forward them
  to `tvc.farm`.

## Google Search Console verification

`syntropic.in` still ranked in Google search with a stale snippet from its old Wix-hosted days,
even though it now 301s to `tvc.farm`. Originally fixed on 2026-07-29 by:

1. Verifying `syntropic.in` as its own Search Console property via a DNS TXT record (added to
   Netlify DNS, per above — Squarespace's DNS panel couldn't be used since it isn't authoritative).
2. Running Search Console's **Change of Address** tool (Settings → Change of address) to
   explicitly tell Google `syntropic.in` → `tvc.farm`, since both required checks (301-redirect
   from homepage, verification of both sites) passed. Status: confirmed moving, dated 2026-07-29.
3. Requesting re-indexing on `https://syntropic.in/` directly via URL Inspection.

**2026-08-27**: the DNS migration to Cloudflare (above) took the verification TXT record with it,
which revoked `contact@tvc.farm`'s access to the property (Search Console showed "Oops, you don't
have access to this property"). Re-verifying via Search Console's "Verify your ownership" flow
**auto-verified through the "Domain name provider" method** — Google's direct OAuth-based
integration with Cloudflare.com as the domain's DNS host (the "Domain name provider" step lets
you pick a specific provider, e.g. Cloudflare.com, or "Any DNS provider" for a plain DNS TXT
record) — with no manual TXT record needed for `contact@tvc.farm`.

**Domain properties only support DNS-based verification** (confirmed via Search Console's own
"Add property" dialog: "Domain... Requires DNS verification" vs. "URL prefix... Allows multiple
verification methods" like HTML tag/Analytics/Tag Manager — those aren't available for a
domain-wide property like this one at all). Within that, `contact@tvc.farm`'s automatic
Cloudflare-provider check pre-empts adding a second method for that same account — every attempt
to re-verify just re-confirms the same automatic check rather than offering a fresh manual token.

**Second verification method, added 2026-08-27**: `sharathjeppu@gmail.com` was already a
delegated owner on this property (Settings → Users and permissions) but, being delegated rather
than independently verified, would have lost access in the same incident. Switching to that
account and choosing **"Any DNS provider"** (instead of "Cloudflare.com") in its own Ownership
verification flow produced a genuine manual DNS TXT token, independent of the OAuth-based
Cloudflare integration:
`syntropic.in` — `TXT` → `google-site-verification=iIyHUHznY6GWBRjwxGXjhO_0w_JtepIH5mzV0Tvlp8I`
(added to Cloudflare, see records above). `sharathjeppu@gmail.com` is now an independently
verified owner via this token — a second, structurally different verification path from
`contact@tvc.farm`'s automatic one, so losing one doesn't take down the other.

(One gotcha hit while adding it: the token's characters are easy to transcribe wrong by eye —
`iIy` is lowercase-i, uppercase-I, lowercase-y, easily misread as `ily` with a lowercase L. First
attempt failed verification silently accepting a wrong character; fixed by reading the token's
literal DOM text rather than eyeballing the rendered font.)
