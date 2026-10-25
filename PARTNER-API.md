# Partner calendar API

What TVC does with partner access to the accommodation calendar: the API Linger's booking
system calls, how to set a partner up, and what is built versus planned. The design lives in the
"Partner Calendar API: Technical Spec" doc (private Claude Doc) and the Linger-facing proposal;
this file is the working reference for what is actually in the repo.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Agree the design, guest fields, price breakdown, settlement terms and notice wording with Linger | In progress (docs written, not signed off) |
| 1 | Units as data, unit catalogue, read-only availability, key issuance, an OpenAPI file (written, see below) | **Deployed 2026-10-24** (PRs #456 and #457; migration `0060` applied to TVC ERP). See Verification for what was tested |
| 2 | Holds, pools assigned by TVC, confirm with guest details and price, Razorpay payment, the sandbox, expiry, `updated_since` | Not started |
| 3 | Settlement ledger, monthly statements, refund reversals | Not started |
| 4 | Member homes: windows, auto-accept, change requests | Not started |

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
5. Issue the key. For a real partner key use the **offline mode**, run by a person at their own
   terminal and never in a chat with an AI assistant:
   `node scripts/partner-key.mjs issue linger "Linger production" --expires 2027-10-01 --print-sql`.
   It needs no secrets: it prints the key (once; only its SHA-256 hash is ever stored) and an `insert`
   statement containing the hash, which you run in the Supabase SQL editor. A mistyped flag is refused
   with a hint, never silently ignored. (Without `--print-sql` the
   command inserts the row itself, which needs `SUPABASE_SERVICE_ROLE_KEY`.)
6. Hand it over (see Key handover below), then confirm receipt.
7. Rotate: issue a second key, let the partner switch, `keys linger` to find the old id, then
   `revoke <keyId>`. Revocation applies on the very next request.

## Key handover

The key is shown once and cannot be recovered, so how it travels matters.

- **Recipient:** one named technical contact at the partner, agreed in advance. Record who and when in
  the key's name or in this repo's private notes, not in the repo itself.
- **Channel:** a one-time secret link (a password manager's share link or a "send once" tool) with
  an expiry and a single view. Send the link to the contact's work email; if the tool uses a passphrase,
  send that by a different channel (a call or a message). Do **not** send the key by plain email,
  WhatsApp or Slack, put it in a ticket or a repo, or paste it into an AI assistant's chat. Strongest
  option when the partner can: they give us a public key (age or PGP) and we encrypt the key to it.
- **Confirm receipt** by quoting the key's prefix (`tvcp_xxxx`), which proves it is the right key without
  revealing it. `keys <partnerId>` shows `last used`: a first use before the partner confirms receipt, or
  from an unexpected time or place, is a reason to revoke and reissue.
- **Sandbox keys** (`tvcs_`, once the sandbox exists) work only against fake data, but follow the same
  process so the habit is the same.
- **Lifetime:** set `--expires` (a year at most), rotate at least yearly and whenever someone with access
  leaves, and revoke at once on any suspicion. Two keys can be active together, so rotation has no
  downtime.
- **Not built yet:** a partner self-service page to rotate its own keys, and per-request logging. Both are
  listed under Security.

## Design decisions worth remembering

- **Keys, not Google Sign-In.** Machine-to-machine; a partner key is scoped to a partner id and
  its grants, so a leaked key cannot touch admin or member data.
- **No guest data anywhere in this function.** It reads booking dates only
  (`accommodation_tent_assignments`, and `accommodation_bookings` for closures). Guest tables
  are never queried, so the API is PII-free by construction.
- **Additive migration.** `0060` adds tables and a seed. Migration `0065` then moved the admin
  calendar onto `accommodation_units` too (see below), so the table is the one source of truth;
  `ACCOMMODATION_UNITS` in code is only the fallback list and the seed `scripts/lib/partner-units.test.mjs`
  compares against.
- **Types are pools.** Since `0065` a unit's type (Tents, Bamboo huts, Bring your own tent, and the member
  types 1 bedroom, 1 BHK, 2 BHK, 3 BHK) is its pool, so what a partner books by quantity is a type.
- **Status.** A unit is `rentable`, `paused` or `offboarded`. A paused unit is shown as unavailable every night
  and does not count towards its pool's size or free count; an offboarded unit is not shown at all.
- **Farm closures are applied to every unit explicitly**, because a closure booking stores no
  tent rows. Exclusive bookings are treated the same, which errs towards showing less
  availability. A unit whose owner set it to stay open (`ignores_farm_closure`) is not closed by either:
  the common kitchen may be closed while a member's own kitchen is not.

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
| `docs/partner-api/openapi.json` | The API contract partners build against (OpenAPI 3.1, JSON) |
| `scripts/lib/partner-openapi.test.mjs` | Contract tests: the handler against the spec, no dependencies |

Tests: `node --test scripts/lib/partner-*.test.mjs`.

## Verification so far

Before deploy: unit tests; a scratch Postgres with the real accommodation migrations (the `stay_range`
text format, closures holding no tent rows and the exclusion constraint were confirmed); the bundled
function driven through a fake PostgREST; and contract tests that run the real handler against
`docs/partner-api/openapi.json`.

On production, 2026-10-24 (migration `0060` applied, temporary keys with a few units and a pool, since
revoked): authentication failures, unsupported methods and unknown paths, the catalogue, availability and
window validation all behaved as documented, and the request limits were tested and corrected (see the
changelog).

**Not verified on production:** the *occupied* path (a booking, closure or exclusive booking turning
nights `unavailable`), because the live calendar has no bookings in the next 12 months and a test booking
would have meant writing to it. It is covered by unit tests and the scratch database only.

## Security

Design principles (what a partner can rely on): keys are random, shown once and stored only as a hash;
every key failure returns the same response; a key sees only the units granted to it and can expire or be
revoked at once; HTTPS only and no caching; the function reads booking dates only and never queries a
guest table; errors never reveal upstream detail, owners or why a night is blocked.

The security assessment, its known limits and the hardening plan are kept in the private technical spec
rather than in this public repository. Ask the core team for them. Report a suspected leak of a key to
`core-team@tvc.farm` at once.

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
- `docs/partner-api/openapi.json` (OpenAPI 3.1, written 2026-10-24) is the source of truth partners build
  against. `scripts/lib/partner-openapi.test.mjs` runs the real handler for every documented outcome
  (200, 401, 404, 405, 422, 429, 502) and fails if a response, status or header stops matching the file,
  so **change the file and the code together**. It is shared with partners as a file for now; serving it
  from the API itself is an option later.
- Phase 1 is read-only with no personal data, so it needs no sandbox: test on production with a
  read-only key. The sandbox is built for phase 2.
- Costs and risks: a second Supabase project may cost money; branch deploys use Netlify credits, so
  sandbox deploys must be deliberate; every migration is applied twice.

Migrations applied: production `0060` (2026-10-24). Sandbox: none yet.
