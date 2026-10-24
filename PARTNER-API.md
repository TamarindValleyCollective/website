# Partner calendar API

What TVC does with partner access to the accommodation calendar: the API Linger's booking
system calls, how to set a partner up, and what is built versus planned. The design lives in the
"Partner Calendar API: Technical Spec" doc (private Claude Doc) and the Linger-facing proposal;
this file is the working reference for what is actually in the repo.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Agree the design, guest fields, price breakdown, settlement terms and notice wording with Linger | In progress (docs written, not signed off) |
| 1 | Units as data, unit catalogue, read-only availability, key issuance, an OpenAPI file (not yet written) | **Deployed 2026-10-24** (PRs #456 and #457; migration `0060` applied to TVC ERP). No partner has a key yet; see Verification and Security for what was tested and the known limits |
| 2 | Holds, pools assigned by TVC, confirm with guest details and price, Razorpay payment, the sandbox, expiry, `updated_since` | Not started |
| 3 | Settlement ledger, monthly statements, refund reversals | Not started |
| 4 | Member homes: windows, auto-accept, change requests, three-way split | Not started |

## What phase 1 does

Base address `https://tvc.farm/api/partner/v1`, JSON, `GET` only, `Authorization: Bearer <key>`.

| Call | Returns |
| --- | --- |
| `GET /units` | `{ units: [{ id, name, capacity, group? }], pools: [{ id, name, size, capacity: { min, max } }] }`: only what this partner has been granted |
| `GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD` | Per granted unit `nights: { date: "free" \| "unavailable" }`, and per pool `nights: { date: { free, total } }`, plus `from`, `to` (exclusive) and `generatedAt` |

- A window is at most 90 nights, `from` is today (India time) or later, `to` is after `from` and
  within 365 days of today. Dates are calendar dates; a stay is start date plus nights, so the
  `to` night is not included.
- A night is `unavailable` if the unit has a tent assignment (any booking type), or a
  farm closure or an exclusive booking covers it. A partner is never told why, and never sees
  who owns a unit or a unit's `kind` (which would reveal member homes).
- Errors are `{ "error": { "code", "message" } }`: `401 invalid_key` (identical whatever is wrong
  with the key), `404`, `405`, `422 invalid_window`, `429 rate_limited` (with `Retry-After`),
  `502 upstream_error`.
- Limits: 60 requests a minute per key; 20 failed key attempts per IP per 5 minutes.

## Setting a partner up (operator runbook)

Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment, for example
`netlify dev:exec node scripts/partner-key.mjs ...`.

1. **Migration `0060_partner_api_foundation.sql`** is already applied to the TVC ERP project (done
   2026-10-24, verified: 14 units, 5 tables with row level security, no keys or grants). Migrations
   are not applied on merge, so any future one needs doing by hand.
2. `node scripts/partner-key.mjs units` lists the seeded units.
3. Optional pool, for units sold by quantity: `create-pool tents "TVC tents"`, then
   `add-to-pool tents Tent01 Tent02 ...`.
4. Grant access: `grant-unit linger Tent06 Tent07` and/or `grant-pool linger tents`. Nothing is
   granted by default, so a new key sees an empty catalogue until this is done.
5. `issue linger "Linger production" [--expires 2027-10-01]` prints the key **once**. It is not
   stored (only its SHA-256 hash is). Send it over a secure channel.
6. Rotate: issue a second key, let the partner switch, `keys linger` to find the old id, then
   `revoke <keyId>`. Revocation applies on the very next request.

## Design decisions worth remembering

- **Keys, not Google Sign-In.** Machine-to-machine; a partner key is scoped to a partner id and
  its grants, so a leaked key cannot touch admin or member data.
- **No guest data anywhere in this function.** It reads booking dates only
  (`accommodation_tent_assignments`, and `accommodation_bookings` for closures). Guest tables
  are never queried, so the API is PII-free by construction.
- **Additive migration.** `0060` adds tables and a seed; it changes nothing the admin calendar
  uses. The tent list still also lives in `ACCOMMODATION_UNITS`, the `tent_id` CHECK and the
  farm-closure arrays in the booking RPCs; `scripts/lib/partner-units.test.mjs` keeps the seed
  in step with `ACCOMMODATION_UNITS` until phase 2 moves everything onto `accommodation_units`.
- **Farm closures are applied to every unit explicitly**, because a closure booking stores no
  tent rows. Exclusive bookings are treated the same, which errs towards showing less
  availability.
- **Rate limiter fails open** if Netlify Blobs is down, like `chat.mts`, so a partner is not
  locked out by an outage of the limiter. It reads with strong consistency (see Verification).

## Where the code is

| File | Role |
| --- | --- |
| `supabase/migrations/0060_partner_api_foundation.sql` | `accommodation_units`, `accommodation_unit_pools`, `partner_api_keys`, `partner_unit_access`, `partner_pool_access` |
| `netlify/functions/partner-api.mts` | Thin wrapper: wires Supabase, the limiter and the client IP into the core |
| `scripts/lib/partner-api-core.mjs` | Routing, auth order, limits, responses |
| `scripts/lib/partner-availability.mjs` | Window validation, availability and catalogue rules (pure) |
| `scripts/lib/partner-keys.mjs` | Key generation, hashing, bearer parsing |
| `scripts/lib/partner-db.mjs` | PostgREST access |
| `scripts/partner-key.mjs` | Operator CLI |

Tests: `node --test scripts/lib/partner-*.test.mjs`.

## Verification so far

Before deploy: unit tests; a scratch Postgres with the real accommodation migrations (the
`stay_range` text format, closures holding no tent rows, and the exclusion constraint were
confirmed); and the bundled function driven through a fake PostgREST.

**On production, 2026-10-24** (migration `0060` applied, a temporary key `linger-test` with two
units and a three-unit pool, since revoked): no key, wrong key and revoked key all return the same
401; `POST` is 405 and an unknown path 404; `GET /units` returned exactly the granted units and
pool with no ownership details; `GET /availability` returned 200 with per-unit and per-pool
nights, and `422 invalid_window` for a past, reversed, over-90-night or missing window.

**Not verified on production:** the *occupied* path (a booking, closure or exclusive booking
turning nights `unavailable`), because the live calendar has no bookings in the next 12 months and
a test booking would have meant writing to it. It is covered by unit tests and the scratch
database only.

**Rate limits, found and fixed on production.** The first run showed neither limit ever triggering
(70 rapid valid requests against 60 a minute, 40 bad-key requests against 20 per 5 minutes, no limiter
errors logged). Cause: Netlify Blobs reads are eventually consistent by default, so a burst read a
stale count. Fixed in #457 (strong-consistency reads for this API only). Re-test after the fix:

| Test | Result |
| --- | --- |
| Valid key, 150 requests 25 at a time (limit 60 a minute) | 106 passed, 44 refused with `429` and `Retry-After: 60`; the next request was refused too |
| Valid key, 75 requests one at a time | None refused, because at about 1.5 s each they never put 60 in one minute (a flawed test, not a defect) |
| Bad keys, 120 requests 25 at a time (limit 20 per 5 minutes) | 63 `401`, 57 `429` |
| Bad keys, sequential, with the window already full | A mix of `401` and `429` |

So the per-key limit holds, with leakage under heavy concurrency (read-then-write, no retry). The
failed-key limit is best-effort: it counts by client IP, and behind Cloudflare the IP the function
sees varies between connections. Real enforcement should be a Cloudflare rate-limiting rule on
`/api/partner/*` (not set up yet).

## Security: what it is and what it is not

**Strong:** keys are 256 random bits, stored only as a SHA-256 hash, shown once; every key failure
returns the same generic 401; keys are scoped to granted units and can expire or be revoked at once;
HTTPS only (HSTS), `Cache-Control: no-store`; the function reads booking dates only and never queries
a guest table, so phase 1 is PII-free by construction; all database tables are RLS-on with no
policies; request values are validated before they reach a query and unit ids come from the database;
errors are generic and never reveal upstream detail, owners, unit kinds or reasons a night is blocked.

**Known limits (phase 1):**

- The key is the only credential. Whoever holds it has that partner's access until revoked. Mitigations
  today: expiry, revocation, rotation, `last_used_at`. Planned: an optional allow-list of the
  partner's server IPs, and alerts on unusual use.
- Rate limits are approximate (see above).
- Successful requests are not logged per key, so a leaked key's reads could not be reconstructed.
  Planned for phase 2: a request log (key id, route, status, window) with alerts.
- The function runs with the Supabase service-role key. It is read-only by construction today, but a
  least-privilege database role limited to the tables it needs is the better design and should be done
  before phase 2 adds writes.
- Phase 2 raises the stakes (a leaked key could create holds and push guest data): open-hold caps,
  IP allow-listing for write keys, a request audit log and an independent security review are planned
  before it ships.
- The `tvcp_` prefix makes a leaked key detectable (for example a GitHub secret-scanning custom pattern).
- Not independently reviewed or penetration tested.

## Testing environments (decided 2026-10-24, not built yet)

Partners test against a sandbox that is a separate stack, not a flag on production data, and the
sandbox runs one phase ahead of production. Decided with Sharath: a separate Supabase project and the
hostname `sandbox.tvc.farm`. Still to check: the Supabase plan and its cost, and DNS for the hostname.

| Environment | Address | Data | Payments and messages |
| --- | --- | --- | --- |
| Production | `tvc.farm/api/partner/v1` | Real | Live Razorpay, real notices |
| Sandbox | `sandbox.tvc.farm/api/partner/v1` | Fake, in its own Supabase project, reset on demand and nightly | Razorpay test mode; WhatsApp and email off (logged instead) |
| Specification and mock | OpenAPI file in the repo | None | None |

- Sandbox is its own Netlify deploy (a branch deploy) with its own env vars. Sandbox keys use a
  different prefix (`tvcs_`); neither environment accepts the other's keys. A start-up guard refuses to
  run if the configured database belongs to the other environment.
- Same code as production, or the next phase; only environment variables differ.
- A seed and reset script, with named scenarios (full farm, closure, expiring hold). In the sandbox
  only, an `externalRef` prefix triggers an outcome: `TEST-CONFLICT` 409, `TEST-EXPIRED` 410,
  `TEST-PRICE` `price_mismatch`, `TEST-PAYFAIL` a failed payment.
- Release flow: build, deploy to the sandbox, the partner certifies, promote to production; the partner
  changes only the base address and key. Migrations go to the sandbox project first, then production;
  record which migration each environment has here.
- Versioning: additive changes stay in `v1` (clients ignore unknown fields); a breaking change gets
  `v2` with at least 30 days of overlap plus `Deprecation` and `Sunset` headers.
- An OpenAPI file is the source of truth and ships with phase 1; contract tests run against it.
- Phase 1 is read-only with no personal data, so it needs no sandbox: test on production with a
  read-only key. The sandbox is built for phase 2.
- Costs and risks: a second Supabase project may cost money; branch deploys use Netlify credits, so
  sandbox deploys must be deliberate; every migration is applied twice.

Migrations applied: production `0060` (2026-10-24). Sandbox: none yet.
