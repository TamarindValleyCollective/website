# On-demand AI daily briefing, gated by the existing accommodation admin role

Madhavan (farm manager) needs a daily summary of bookings, arrivals/departures, and guest
preferences to plan the day. We decided this is an **on-demand, admin-only** feature rather
than an automatic/scheduled one: a button in `/internal/accommodation-calendar` calls a new
function that aggregates the day's bookings deterministically (arrivals, departures, in-house
guests, per-guest `preferences` text, linked events/closures) from `accommodation-db.mjs`, then
asks Claude to synthesize that structured data into a short prose briefing — counts and lists
come from code, never from the model, so the summary can't hallucinate who's actually booked.

The endpoint reuses the exact auth pattern already established in `accommodation-admin.mts`
(Google ID token verified server-side, role looked up via `accommodation-access.mjs`) rather
than introducing new auth, restricted to `role === 'admin'`. This is deliberate: guest names,
ages, and preferences are the same PII that file's own auth comment calls out as sensitive, so
the briefing must not be reachable by `restricted`/`viewer` roles even though they can read some
booking data elsewhere.

An "email it to myself" action reuses the existing Resend integration and sends only to the
email address verified from the caller's own ID token — never a free-text address — so the
endpoint can't become an arbitrary email relay.

## Considered Options

- **Automatic/scheduled generation** (e.g. a cron job emailing Madhavan every morning) — rejected
  because he asked for on-demand generation specifically, and a scheduled job would run (and
  incur model cost) on days he doesn't need it, or go stale if generated too early before
  same-day changes land.
- **New auth/role mechanism for this feature** — rejected in favor of reusing
  `accommodation-access.mjs`'s existing `admin`/`restricted`/`viewer` roles, since Madhavan
  already holds `admin` there and the guest data involved is the same data that system already
  protects.
- **A new standalone `/internal/*` page** — rejected for now in favor of a panel inside the
  existing accommodation-calendar page, consistent with the direction noted in issue #89
  (consolidate internal admin pages) rather than adding another one-off page ahead of it.

## Status

Design only — not yet built.
