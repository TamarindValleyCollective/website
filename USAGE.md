# Usage & limits dashboard

> **Keep this file up to date.** Whenever a service is added or dropped from tracking, a threshold
> or alert rule changes, or a typed-in meter is added, update this doc in the same change. See
> the note in `CLAUDE.md`.

TVC runs on several free tiers and prepaid credits that fail *suddenly* when used up. This module
shows how close each one is and emails the core team before it runs out.

- Page: `/internal/usage` (Google sign-in, admin role in the **Usage & limits** module).
- API: `netlify/functions/usage-admin.mts`. Alert emails: `netlify/functions/usage-alerts.mts`
  (hourly) to `core-team@tvc.farm`. Rules: `scripts/lib/usage-rules.mjs` (unit-tested).
- Data: Supabase tables from migrations `0030_usage_metering.sql` and `0031_usage_dashboard.sql`.
- Architecture and the diagram: `ARCHITECTURE.md`.

## What is measured, and what is typed in

| Service | How we know | Notes |
|---|---|---|
| Anthropic (chat, search fallback, member story check) | **Measured**: every call the website makes adds its requests/tokens/errors to a daily total (`lib/usage-meter.ts`). | Individual accounts have no usage API, so nothing is read from Anthropic. Local scripts using the same key aren't counted. |
| Anthropic credit balance | **Typed in** by an admin, then *estimated*: balance minus metered spend since, using admin-entered token prices. | An estimate, labelled as one. The Console's own spend limit and low-balance email stay on as the independent backstop. |
| TypeSafe (Jev) | **Measured** the same way (calls, input/output tokens, errors, timeouts) from `whatsapp-webhook.mts`'s shadow reads of inbound WhatsApp messages. **Credit balance typed in** (a $5 prepaid top-up on 2026-10-22). | TypeSafe bills input tokens only, at $0.042 per million (`TYPESAFE_USD_PER_MTOK` in `usage-rules.mjs`, a published price, not entered on the page); a read is about 500 tokens, so roughly $0.00002 each. No usage API is read: the balance is typed in from console.typesafe.ai → Billing, and the reads are off unless `TYPESAFE_WHATSAPP_SHADOW=true`, so the card stays at 0 until then. |
| Google Gemini | **Measured** the same way (requests, tokens, HTTP 429 "quota ran out", fallbacks to paid Anthropic). | Google has no remaining-quota API. A daily request limit can be entered to get percentage warnings. |
| Supabase database: size, growth, biggest tables, connections | **Measured** every 6 hours by `usage-collect.mts`: size against the free plan's 500 MB; open direct connections against `max_connections` (60) through the read-only `usage_db_connections()` function (migration `0033`); and the 8 biggest tables (name, size with indexes, row estimate; never contents) through `usage_db_tables()` (migration `0058`). **Growth** is worked out on the page from the last two weeks of size readings (a least-squares line, `projectDbGrowth` in `usage-rules.mjs`): MB per week and the time until the free size is full. It needs about a week of readings first, and a bulk import skews it until it ages out. | Supabase is used as a database only (REST + SQL): no Storage, Auth, Realtime or Edge Functions, so there are no other Supabase limits to track. **Billed egress** (5 GB a month on the free plan) can't be read: the Management API only gives request counts, and the Metrics API's network counter is the host's raw traffic, not what Supabase bills. It is a **typed-in** meter (`supabase.egress_gb`) read off the Supabase dashboard → your organization → Usage. |
| Netlify credits | **Credits remaining** is **typed in**, as Netlify's billing page reports it (its API doesn't expose it). The **plan allowance and billing-cycle dates** are **read automatically** every 6 hours from `GET /accounts/{id}` by `usage-collect.mts`, using `NETLIFY_ACCESS_TOKEN`. | The read allowance overrides the typed limit. Credits reset each billing cycle (TVC's runs 19th to 18th), so a reading typed in *before* the current cycle began is flagged on the page and gives no alert. Without the token, everything falls back to fully typed in. |
| Resend emails | **Read automatically** every 6 hours from Resend's Usage API (`GET /usage`) by `usage-collect.mts`, using a separate `RESEND_USAGE_API_KEY` (the site's sending-only `RESEND_API_KEY` is refused with HTTP 401, confirmed 2026-10-10): the monthly quota, plus the daily one on the free plan. | The usage key must be a **full-access** Resend key (no read-only type exists), so it is kept separate from the sending key and flagged secret on Netlify (Functions scope); it can be revoked on its own. If the key is missing, refused, or the readings stop for 2 days, the typed-in Resend meter carries on and a warning is emailed. A fresh API reading hides the typed-in card and form. |
| Cloudflare R2 storage | **Read automatically** every 6 hours from Cloudflare's GraphQL analytics API (`r2StorageAdaptiveGroups`: current bytes across all buckets) by `usage-collect.mts`, using a read-only `CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read only) and the non-secret `CLOUDFLARE_ACCOUNT_ID`. | Compared with the 10 GB free tier (a GB is 10^9 bytes; the Cloudflare dashboard is the authority). If the token or account id is missing, or readings stop for 2 days, the typed-in R2 meter carries on and a warning is emailed. A fresh API reading hides the typed-in card and form. |
| Domain renewals | **Read live** from the registries' public RDAP service (no key), shown on the page; **emailed** by the `domain-expiry.yml` GitHub Action. | The Action runs off Netlify and holds no database credentials, so it still alerts if Netlify pauses. |

## Which figures update themselves

Each card shows only a summary (the status, one headline figure and one bar, plus anything overdue or out of date); everything else (how it updates, charts, breakdowns, caveats) sits behind its **Details** toggle, and an open card takes the full row and stays open when a saved reading reloads the page. Every card carries a badge: **Automatic** (the 6-hourly `usage-collect` run, with the next run's time shown, and a note if one was missed), **Live** (counted on every request the site makes: Anthropic, Gemini and TypeSafe usage), **Manual** (an admin types it in; shows when the update is due, and goes orange once overdue), or **Part manual** (Netlify credits: balance typed in, allowance and cycle automatic; Anthropic and TypeSafe: usage live, credit balance typed in). The run schedule is `COLLECTOR_EVERY_HOURS` in `usage-rules.mjs`, which must match the cron in `usage-collect.mts`. Typed-in due dates come from `refreshEveryDays` on each meter in `MANUAL_METERS` (7 days for the Netlify balance, 14 for the rest).

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
| TypeSafe credit remaining ≤ 30% / ≤ 10% of the total entered | Warning / Critical |
| TypeSafe (Jev) calls failing: at least 5 errors today and at least 20% of today's calls (the shadow reads fail silently otherwise) | Warning |
| Supabase database ≥ 70% / 90% of its limit | Warning / Critical |
| Supabase database connections ≥ 70% / 90% of the limit (60 on the free plan) | Warning / Critical |
| Supabase database projected full within 60 / 21 days at the last two weeks' pace (needs about a week of readings) | Warning / Critical |
| Supabase egress (typed in) ≥ 70% / 90% of the limit entered with it | Warning / Critical |
| Resend emails (monthly or daily, read from its API) ≥ 70% / 90% of the limit | Warning / Critical |
| Resend usage readings not refreshed for over 2 days | Warning |
| Cloudflare R2 storage ≥ 70% / 90% of the 10 GB free tier (read from its API) | Warning / Critical |
| Cloudflare R2 readings not refreshed for over 2 days | Warning |
| Netlify plan data (allowance/cycle) not refreshed for over 2 days, i.e. the token has likely expired | Warning |
| Netlify credits remaining ≤ 30% / ≤ 10% of the plan allowance | Warning / Critical |
| Any typed-in "used" meter ≥ 70% / 90% of the limit entered with it | Warning / Critical |

Domain renewals are separate (GitHub Action): at 60 and 30 days, then daily from 14.

## WhatsApp account health

A fourth block on the page, "WhatsApp account health", lists the 15 most recent account events
Meta reported (template approved / rejected / paused / disabled, template or phone-number quality
changes, a template recategorised, account restrictions or alerts). These are recorded by
`whatsapp-webhook.mts` into `whatsapp_health_events` (migration `0036`) and **each is also emailed
once** to `core-team@tvc.farm` (subject starts "⚠️ WhatsApp:" for warnings and critical events).
They aren't threshold meters, so they don't use the alert rules above. Meta only sends these if the
webhook fields are subscribed (App Dashboard → WhatsApp → Configuration → Webhook fields):
`message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update`,
`template_category_update`, `account_update`, `account_alerts`. See `WHATSAPP.md`.

## Setup checklist

1. Apply migrations `0030` and `0031` to the TVC ERP Supabase project (and `0033`, `0058` for the connection and table readings; until `0058` is applied the table list is simply absent).
2. A super admin grants admins a role in **Usage & limits** on `/internal/access` (`read_only` or
   `user` can view; `admin` can type in readings and change settings).
3. An admin opens the page and enters: the Anthropic credit balance (and total, and expiry if any),
   the Anthropic input/output token prices (USD per million tokens, from Anthropic's pricing page),
   the Gemini daily request limit (from the project's rate limits in Google AI Studio), the TypeSafe
   credit balance (console.typesafe.ai → Billing; $5 topped up 2026-10-22), and a first
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
6. Cloudflare R2 (optional): in Cloudflare → My Profile → API Tokens, create a custom token with **Account → Account Analytics → Read** and nothing else, restricted to the TVC account. Set it on Netlify as `CLOUDFLARE_ANALYTICS_TOKEN` (flagged secret, Functions scope) with `CLOUDFLARE_ACCOUNT_ID` (not secret; the account id from the Cloudflare dashboard URL), then redeploy. Rotate it alongside the other usage tokens.
7. Keep the readings fresh: warnings use the latest entry, and a reading more than a month old is
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
- No emails, IPs or message text are stored: only counts, sizes, dates and admin ids.
