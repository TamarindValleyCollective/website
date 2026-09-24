# Razorpay

> **Keep this file up to date.** Whenever what we actually do with Razorpay changes — a new
> payment link, the site gains real online checkout, new API/webhook usage, a change to the
> connected account, etc. — update this file in the same change. See the note in `AGENTS.md`.

## What Razorpay is used for today

`tvc.farm` has **real online checkout** for events that opt in — see
[Event payment tracking (live)](#event-payment-tracking-live) below. Every other booking flow
(Visit/camping/day-visit/trekking) is still inquiry-first: visitors submit the Visit inquiry form
or reach out on WhatsApp (`src/components/BookingInquiry.astro`), and payment is arranged
directly with TVC. This split (some events pay online, most bookings are inquiry+arrange) is
documented on `/terms` and `/refund-policy` (added `a7d6649`, 2026-07-27, for Razorpay
compliance — see `CHANGELOG.md`; revisit these two pages if the online-checkout flow's share of
bookings grows enough to warrant leading with it there too).

## Event payment tracking (live)

A reusable module — not tied to any one event — that lets an event page take real payment
online instead of the inquiry-first flow above. Built 2026-09-22 as a prototype on Foraging Day,
proven out there, and taken live 2026-09-24 (real `rzp_live_...` API keys, a live-mode webhook,
and one real payment-link creation verified directly against the live API — see `ARCHITECTURE.md`
for the full technical writeup and diagram).

**How an event opts in** (no code change, ever):

1. Create a **base Payment Link** for the event (Razorpay MCP or dashboard, in whichever
   mode — Test/Live — the site's current API keys are in) with the per-person price as its
   amount, a `reference_id` unique to the event (e.g. `foraging-day-2026-10-10`), and
   `notes.event` set to the event's title. This link is the trusted source of truth for price —
   it's never paid directly once the event is wired up this way.
2. Set that same value as `razorpayReferenceId` in the event's content frontmatter
   (`content.config.ts`) — this is what makes `EventDetailView.astro` render
   `EventBookingForm.astro` (name/email/phone/headcount, "Pay & register") instead of the
   inquiry-first `BookingInquiry` block.
3. Set the event's `price` frontmatter to match the base link's amount (display only — the
   actual charged amount always comes from the base link server-side, computed as
   `unit price × headcount` for whatever the visitor enters).
4. Test once before promoting the page (a real booking, or a dry run that stops short of
   actually paying) — confirms the price lookup and per-booking Payment Link creation work
   before relying on it for a real event.

**What happens on a booking:** `EventBookingForm` posts to `netlify/functions/event-booking.mts`,
which reads the base link's price, multiplies by headcount, and creates a fresh one-off Payment
Link for the total, redirecting the browser there. Once paid, Razorpay calls the
`payment_link.paid` webhook (`netlify/functions/razorpay-webhook.mts`), which verifies the
signature, records the payment in the `event_payments` table (Supabase project "TVC ERP",
`mljavkvkxdejvpzadnrp`), and emails a branded receipt (CC'd to `core-team@tvc.farm` and
`stay@linger.in`). A cancellation link in that receipt leads to `/cancel-booking`
(`netlify/functions/cancel-booking.mts`) — records a **request only**, not an automatic refund
(TVC's `/refund-policy` has day-before-event tiers a human applies by hand), and notifies TVC +
Linger + the guest.

**Live configuration** (Netlify env vars, all deploy contexts):

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — regenerated live keys as of 2026-09-24 (see
  Netlify's env var settings for the actual `rzp_live_...` Key ID — not repeated here verbatim
  since Netlify's build-time secret scanner blocks any deploy whose scanned files contain a
  configured secret's literal value, key ID included); the account's original live key from
  2026-07-27 had no saved secret, so it was regenerated rather than recovered.
- `RAZORPAY_WEBHOOK_SECRET` — an arbitrary shared secret, same value entered on both this env var
  and the Razorpay dashboard webhook config (Settings → Webhooks, Live mode → `payment_link.paid`
  → `https://tvc.farm/api/razorpay-webhook`). Environment variable changes only take effect on
  Netlify Functions after a fresh deploy — not immediately on save (a real gap we hit and fixed
  2026-09-24: the webhook secret was updated but the running function still had the old value
  until the next deploy).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `RESEND_API_KEY` — all reused as-is from the
  WhatsApp integration, no new credentials needed.

**A genuine bug found and fixed going live:** `fetchBasePaymentLink` originally parsed Razorpay's
payment-links list response as `{ items: [...] }`, but the real field is `payment_links` — this
had only ever been tested against constructed mock `Request` objects before, never Razorpay's
real API, so the wrong-shape assumption went undetected until the first live test. Fixed and
reverified directly against the API before going live.

**Internal admin page:** `/internal/event-payments` (Google Sign-In + the same core-team
allow-list as `/internal/whatsapp`/`/internal/photo-pool`, via
`netlify/functions/event-payments-admin.mts`) shows registrations, cancellations, and money
collected per event, and can **issue a real refund** for a booking — calling Razorpay's refund
API (`POST /v1/payments/:id/refund`, via `createRefund` in `netlify/functions/lib/razorpay.ts`)
directly, since Razorpay's own MCP server has fetch/list tools for refunds but no way to create
one. The page pre-fills a suggested amount from `/refund-policy`'s day-before-event tiers
(75%/50%/0%), which the admin can override, and requires an explicit two-step confirm before
anything is sent — no one-click refund. A successful refund is recorded on the `event_payments`
row (`razorpay_refund_id`, `refund_amount`, `refund_status`, `refunded_at`, `refunded_by` —
migration `0020_event_payments_refunds.sql`) and emails the payer a confirmation (cc
`core-team@tvc.farm`/`stay@linger.in`). This is the same underlying table `/cancel-booking`
writes `cancellation_requested_at` to (a guest-initiated *request*, not a refund) — a row only
counts as cancelled in this page's stats once `refunded_at` is actually set.

**Test-mode payments are hidden by default.** Razorpay's `payment_link.paid` webhook payload
carries no explicit test/live flag, so `razorpay-webhook.mts` derives one itself at the moment it
handles each webhook — `mode` is `'test'` if `RAZORPAY_KEY_ID` starts with `rzp_test_`, `'live'`
otherwise (migration `0021_event_payments_mode.sql`) — and stores it on the row. This is
deterministic, not a guess: whichever key is active is the one that actually authenticated that
payment, since a test card/UPI can only ever be paid against test-mode keys in the first place.
(An earlier version of this filter matched Razorpay's test-mode "quick pay" default email,
`void@razorpay.com` — plausible from the data seen so far, but never confirmed as guaranteed
Razorpay-wide behavior, so replaced with this instead.) The dashboard filters `mode = 'test'` rows
out of the booking list and stats by default, with a "Showing N test payments" checkbox to
include them when needed (e.g. verifying the webhook chain still works) — see `isTestPayment()`
in `event-payments-admin.mts`. The five rows recorded proving this module out on 2026-09-24 (before
the switch to live keys that same day) were backfilled to `mode = 'test'` by the migration itself.

**Events using this flow:**

| Event | Amount | Base Payment Link | Reference ID |
|---|---|---|---|
| Foraging Day (10 Oct 2026) | ₹2,250/person | https://rzp.io/rzp/RjF4hjJ1 | `foraging-day-2026-10-10` |

Any new paid event just needs its own base Payment Link + `razorpayReferenceId` (see the
opt-in steps above) — nothing here is Foraging-Day-specific.

Foraging Day's base Payment Link (see the table above) has its own history worth keeping: the
event was originally set for Aug 1 2026 with a link at `https://rzp.io/rzp/Pry5rI8r` (fixed
`66614ab`, 2026-07-17), but was postponed indefinitely and set `draft: true` (`a424212`,
2026-07-25) — draft events are filtered out of both `/events` and their own detail route. It's
since been rescheduled to **10 Oct 2026**; the content file was renamed to match
(`2026-10-10-foraging-day.md`, new URL `/events/2026-10-10-foraging-day`) and a fresh Payment
Link created — the old one had gone untracked by `fetch_all_payment_links` and the event's price
had since firmed up from an earlier ₹2,200 test link to ₹2,250, so rather than reuse either
stale link, a new one was made to match.

Not every event uses the reusable module above — some still link out to a Razorpay-hosted
**Payment Link** by hand, embedded as a plain link in the event's own content rather than
through `EventBookingForm`/`razorpayReferenceId`. Two such links were created 2026-09-06 for
**3Bs&1H Edition 6** (Oct 3-4, 2026), one per
accommodation tier (matching the two tiers in that event's `price` frontmatter and its
`BookingInquiry` tier selector) — both expire at the end of the event (2026-10-04 23:59 IST),
notifications off:

| Tier | Amount | Link | Reference ID |
|---|---|---|---|
| Deck-based tent / bamboo hut | ₹3,500 | https://rzp.io/rzp/CiLAAX9G | `3bs1h-ed6-deck` |
| Campground tent / DIY camping | ₹3,200 | https://rzp.io/rzp/IIvOQGV | `3bs1h-ed6-campground` |

As of this note, these links exist in the connected Razorpay account only — they are **not yet
embedded anywhere in the site's content** (the event page's own CTA is still the inquiry-first
`BookingInquiry` form/WhatsApp flow described above). If/when they're added to the event page,
update this note accordingly.

## What the Razorpay MCP server can do

The assistant has a Razorpay MCP server connected (account-level access, separate from the
website codebase). It's available for account operations — checking on payments, refunds,
settlements, generating new payment links, etc. — on request, but nothing it does is wired into
the site automatically. Tool groups available:

| Area | Tools |
|---|---|
| Orders | `create_order`, `update_order`, `fetch_order`, `fetch_all_orders`, `fetch_order_payments` |
| Payments | `fetch_payment`, `fetch_all_payments`, `update_payment`, `capture_payment`, `fetch_payment_card_details`, `initiate_payment`, `submit_otp`, `resend_otp` |
| Payment Links | `create_payment_link`, `update_payment_link`, `fetch_payment_link`, `fetch_all_payment_links`, `payment_link_notify`, `payment_link_upi_create` |
| Refunds | `fetch_refund`, `fetch_specific_refund_for_payment`, `fetch_multiple_refunds_for_payment`, `fetch_all_refunds`, `update_refund` |
| QR Codes | `create_qr_code`, `fetch_qr_code`, `fetch_all_qr_codes`, `fetch_payments_for_qr_code`, `fetch_qr_codes_by_customer_id`, `fetch_qr_codes_by_payment_id` |
| Settlements & Payouts | `fetch_all_settlements`, `fetch_settlement_with_id`, `fetch_settlement_recon_details`, `fetch_all_instant_settlements`, `fetch_instant_settlement_with_id`, `fetch_all_payouts`, `fetch_payout_with_id` |
| Auth / tokens | `fetch_tokens`, `revoke_token` |
| Integration helpers | `create_registration_link`, `integrate_razorpay_checkout`, `detect_stack` |

`integrate_razorpay_checkout` / `detect_stack` weren't actually used to build the event payment
module above (it's a hand-rolled Payment Links integration, not Razorpay's embedded Checkout) —
they'd be the tools to reach for if a future flow wants Razorpay's own Checkout UI embedded
directly rather than redirecting to a hosted Payment Link.

## Compliance pages

- `/terms` — Terms & Conditions
- `/refund-policy` — Cancellation & Refund Policy

Both describe the inquiry + direct payment arrangement flow that most bookings still use; neither
mentions the event payment module's real online checkout yet (still a single-event pilot as of
2026-09-24 — revisit these pages once it's used widely enough to warrant describing it there,
per the note in "What Razorpay is used for today" above). Legal entity details (name, CIN, PAN,
registered address) come from the `LEGAL_ENTITY_*` constants in `src/data/site-facts.ts`, the
single source of truth also referenced by the footer and `/privacy`.
