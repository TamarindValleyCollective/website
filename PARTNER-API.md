# Partner calendar API

What TVC does with partner access to the accommodation calendar: the API Linger's booking
system calls, how to set a partner up, and what is built versus planned. The design lives in the
"Partner Calendar API: Technical Spec" doc (private Claude Doc) and the Linger-facing proposal;
this file is the working reference for what is actually in the repo.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Agree the design, guest fields, price breakdown, settlement terms and notice wording with Linger | In progress (docs written, not signed off) |
| 1 | Units as data, unit catalogue, read-only availability, key issuance | **Built; migration `0060` applied to TVC ERP on 2026-10-24; function not yet deployed** (merge #456, then follow the runbook) |
| 2 | Holds, pools assigned by TVC, confirm with guest details and price, Razorpay payment, expiry, `updated_since` | Not started |
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
  locked out by an outage of the limiter.

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

## Not yet verified

Phase 1 has been unit-tested, run against a scratch Postgres with the real accommodation
migrations (the `stay_range` text format, closures holding no tent rows, and the exclusion
constraint were confirmed), and the bundled function was driven through a fake PostgREST. It has
**not** been run against the real TVC ERP project, behind Netlify, or with the real PostgREST
(the `ov.` range filter and `or=(...)` filter are the same shapes `accommodation-db.mjs` and
standard PostgREST use). Do that on a deploy preview before giving Linger a key.
