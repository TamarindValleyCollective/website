# Usage & limits dashboard

> **Keep this file up to date.** Whenever a service is added or dropped from tracking, a threshold
> or alert rule changes, or a typed-in meter is added, update this doc in the same change. See
> the note in `CLAUDE.md`.

TVC runs on several free tiers and prepaid credits that fail *suddenly* when used up. This module
shows how close each one is and emails the core team before it runs out.

- Page: `/internal/usage` (Google sign-in, staff role in the **Usage & limits** module).
- API: `netlify/functions/usage-admin.mts`. Alert emails: `netlify/functions/usage-alerts.mts`
  (hourly) to `core-team@tvc.farm`. Rules: `scripts/lib/usage-rules.mjs` (unit-tested).
- Data: Supabase tables from migrations `0030_usage_metering.sql` and `0031_usage_dashboard.sql`.
- Architecture and the diagram: `ARCHITECTURE.md`.

## What is measured, and what is typed in

| Service | How we know | Notes |
|---|---|---|
| Anthropic (chat + search fallback) | **Measured**: every call the website makes adds its requests/tokens/errors to a daily total (`lib/usage-meter.ts`). | Individual accounts have no usage API, so nothing is read from Anthropic. Local scripts using the same key aren't counted. |
| Anthropic credit balance | **Typed in** by an admin, then *estimated*: balance minus metered spend since, using admin-entered token prices. | An estimate, labelled as one. The Console's own spend limit and low-balance email stay on as the independent backstop. |
| Google Gemini | **Measured** the same way (requests, tokens, HTTP 429 "quota ran out", fallbacks to paid Anthropic). | Google has no remaining-quota API. A daily request limit can be entered to get percentage warnings. |
| Supabase database size | **Measured** every 6 hours by `usage-collect.mts` against the free plan's 500 MB. | |
| Netlify credits | **Credits remaining** is **typed in**, as Netlify's billing page reports it (its API doesn't expose it). The **plan allowance and billing-cycle dates** are **read automatically** every 6 hours from `GET /accounts/{id}` by `usage-collect.mts`, using `NETLIFY_ACCESS_TOKEN`. | The read allowance overrides the typed limit. Credits reset each billing cycle (TVC's runs 19th to 18th), so a reading typed in *before* the current cycle began is flagged on the page and gives no alert. Without the token, everything falls back to fully typed in. |
| Resend emails | **Read automatically** every 6 hours from Resend's Usage API (`GET /usage`) by `usage-collect.mts`, using a separate `RESEND_USAGE_API_KEY` (the site's sending-only `RESEND_API_KEY` is refused with HTTP 401, confirmed 2026-10-10): the monthly quota, plus the daily one on the free plan. | The usage key must be a **full-access** Resend key (no read-only type exists), so it is kept separate from the sending key and flagged secret on Netlify (Functions scope); it can be revoked on its own. If the key is missing, refused, or the readings stop for 2 days, the typed-in Resend meter carries on and a warning is emailed. A fresh API reading hides the typed-in card and form. |
| Cloudflare R2 storage | **Typed in** by an admin from the provider's own dashboard, with the limit entered alongside. | On purpose: reading these automatically needs an API credential per service, broader than a usage reading is worth. Phase 3 can revisit (Cloudflare supports a read-only analytics token). |
| Domain renewals | **Read live** from the registries' public RDAP service (no key), shown on the page; **emailed** by the `domain-expiry.yml` GitHub Action. | The Action runs off Netlify and holds no database credentials, so it still alerts if Netlify pauses. |

## Alert rules

Emailed once when they appear, again only if they get worse (warning → critical), and forgotten
when they clear so a recurrence emails again. One digest per hourly run.

| Alert | Level |
|---|---|
| Anthropic refused requests over billing in the last 2 days | Critical |
| Estimated Anthropic credit ≤ 30% / ≤ 10% of the total entered | Warning / Critical |
| Anthropic credit expiry date (if entered) within 30 / 7 days | Warning / Critical |
| Any Gemini request refused (HTTP 429) today | Warning |
| Gemini requests today ≥ 70% / 90% of the entered daily limit | Warning / Critical |
| Chat daily cap, or search paid-fallback cap, hit today | Warning |
| Supabase database ≥ 70% / 90% of its limit | Warning / Critical |
| Resend emails (monthly or daily, read from its API) ≥ 70% / 90% of the limit | Warning / Critical |
| Resend usage readings not refreshed for over 2 days | Warning |
| Netlify plan data (allowance/cycle) not refreshed for over 2 days, i.e. the token has likely expired | Warning |
| Netlify credits remaining ≤ 30% / ≤ 10% of the plan allowance | Warning / Critical |
| Any typed-in "used" meter ≥ 70% / 90% of the limit entered with it | Warning / Critical |

Domain renewals are separate (GitHub Action): at 60 and 30 days, then daily from 14.

## Setup checklist

1. Apply migrations `0030` and `0031` to the TVC ERP Supabase project.
2. A super admin grants staff a role in **Usage & limits** on `/internal/access` (`read_only` or
   `user` can view; `admin` can type in readings and change settings).
3. An admin opens the page and enters: the Anthropic credit balance (and total, and expiry if any),
   the Anthropic input/output token prices (USD per million tokens, from Anthropic's pricing page),
   the Gemini daily request limit (from the project's rate limits in Google AI Studio), and a first
   reading for Netlify, Resend and Cloudflare R2.
   Current values (entered 2026-10-04): Anthropic **$2 input / $10 output per million tokens**, checked
   against Anthropic's pricing page for `claude-sonnet-5`, the one model both Claude call sites use
   (`chat.mts` and the paid fallback in `search-ai.mts`). **If either file's model changes, update
   the prices on the page too** — they are a typed-in setting, not read from the code. Cache reads
   and writes are priced as 0.1x and 1.25x of the input price automatically.
4. Netlify (optional but recommended): create a personal access token at
   app.netlify.com → User settings → Applications, and set it as `NETLIFY_ACCESS_TOKEN` on the site
   (Netlify dashboard → Environment variables, flagged secret). The `usage-collect` function picks it
   up on its next run. **The token expires 2027-12-30**: renew it before then, or the plan allowance and cycle dates silently stop refreshing (the page keeps showing the last ones). Check the Netlify card shows the billing cycle dates, a "resets in N days" line and credits-a-day pace.
5. Resend (optional): in resend.com → API Keys create a **Full access** key named `tvc-usage-read`, and set it as `RESEND_USAGE_API_KEY` on Netlify (flagged secret, Functions scope), then redeploy. Rotate it alongside `NETLIFY_ACCESS_TOKEN`.
6. Keep the readings fresh: warnings use the latest entry, and a reading more than a month old is
   flagged on the page.

## Adding a typed-in meter

Add it to `MANUAL_METERS` in `scripts/lib/usage-rules.mjs` (id `service.metric`, label, unit, `kind`
`used` or `remaining`, where to find it). The API only accepts meters on that list, the page renders
the card and form from it, and `used`-kind meters alert at 70%/90% automatically. Add a test.

## Limits worth knowing

- Counts use **UTC days**. Google resets its own daily quota at a different hour.
- The credit estimate counts the whole day of the last reading, so it errs toward warning early.
- The alert function runs on Netlify, so it cannot warn about Netlify itself being paused. The
  Netlify credits reading is a typed-in one and is mailed when it is *near* the limit.
- No emails, IPs or message text are stored: only counts, sizes, dates and staff ids.
