# Website Architecture

> **Keep this file up to date.** Whenever a change affects hosting, data flow, external
> services, or how a page/feature is served (new integration, new serverless function, moving
> off Netlify, etc.), update the diagram and the relevant section below in the same change.
> See the note in `AGENTS.md`.

## Overview

**tvc.farm is live**, running this Astro rebuild on Netlify (behind Cloudflare for DNS/CDN),
under the Netlify account owned by `contact@tvc.farm` (ownership moved there from a personal
account on 2026-07-18). The site is almost entirely static (prerendered HTML/CSS/JS, no server
at request time), with a small set of deliberate exceptions that need a serverless backend:
fifteen Netlify Functions (the site-wide chat assistant, `/api/search-ai` backing the site
search's AI answer (Gemini API free tier first, falling back to the same Anthropic API
the chat assistant uses), the event-interest counter backing past
events' "Want this to happen again?" widget, `/api/photo-pool` backing the internal, unlinked
photo review dashboard at `/internal/photo-pool`, `/api/enquiry` logging the membership
enquiry form (`/join`) and the general enquiry form (`/contact`) to Google Sheets,
`/api/rainfall` reading the community's rainfall-log Google Sheet live for the rainfall chart/
table/monsoon stat on `/ecosystem/weather`, `/api/whatsapp-webhook` receiving WhatsApp Cloud
API events — see `WHATSAPP.md`, `/api/whatsapp-admin` backing the internal, unlinked
WhatsApp reply dashboard at `/internal/whatsapp`, a scheduled (cron, no HTTP path)
`whatsapp-stale-alert.mts` emailing an hourly digest of unread WhatsApp messages, and
`/api/accommodation-admin` backing the internal, unlinked tent-booking dashboard at
`/internal/accommodation-calendar` — the public, aggregate-only availability view this admin
tool was originally built alongside was deliberately **not** shipped to production with it
(dropped 2026-08-30, approach TBD), `/api/partner/v1/*` (a read-only, key-authenticated API
through which Linger's booking system reads the unit catalogue and per-night availability —
phase 1 of the partner calendar API, see the entry below), and four functions backing the reusable event payment
module — `/api/event-booking` (saves a pending booking request and alerts Linger; since 2026-10-11 it
no longer creates a payment link), `/api/booking-approval` (Linger staff approve or decline from a
tokenised link; approving creates the per-booking Razorpay Payment Link and sends it to the guest), `/api/razorpay-
webhook` (records a paid booking, emails a receipt), `/api/cancel-booking` (records a guest's
cancellation request), and `/api/event-payments-admin` (backs the internal, unlinked per-event
payments dashboard at `/internal/event-payments` — registrations/cancellations/money collected,
and can issue a real Razorpay refund) — live as of 2026-09-24, see `RAZORPAY.md`), Netlify Blobs
(public storage for the event-interest counter — the site's only *readable* server-side state
that isn't gated behind a secret; everything else below is either write-only or, for photo-pool,
gated), and Netlify Forms (the membership enquiry form on `/join`, the general enquiry form on
`/contact`, the Host an Event inquiry, the shared Visit inquiry form on the camping/day-visit/
trekking pages, and — when an email is given — the event-interest widget).
The old Friends of TVC signup form (name + phone, added to the WhatsApp group by hand) has been
replaced by a direct invite link to that same group — no form, no manual step. See
[Current Production Status](#current-production-status) — the chat assistant's
`ANTHROPIC_API_KEY` was set on 2026-07-18, and it now answers with real, grounded responses,
`/api/event-interest` responds live in production, and `/api/photo-pool`'s Google Cloud service
account, Drive folder tree, and Netlify env vars (all deploy contexts, including production) are
fully configured and **verified directly against production** (`/internal/photo-pool` returns
200, `/api/photo-pool` returns 401 unauthenticated as expected for its Google Sign-In gate).
`/api/enquiry` is **live and verified**: its two Google Sheets
are created, shared Editor-access with the service account, and their ids set as
`MEMBERSHIP_ENQUIRY_SHEET_ID`/`GENERAL_ENQUIRY_SHEET_ID` — a direct `POST` to
`https://tvc.farm/api/enquiry` for each form type appended a real row successfully. The event
payment module (`event-booking.mts`/`razorpay-webhook.mts`/`cancel-booking.mts`) is **live** as
of 2026-09-24: real `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` are set, a
live-mode webhook is configured, and a real Payment Link creation was verified directly against
the live API — see `RAZORPAY.md` for the full writeup, including a real bug found going live.
Email
notification for this form and every other form without its own override runs through one
site-wide "Email notification" rule (Site configuration → Forms → Form notifications, no
per-form `form_name` set), pointed at `core-team@tvc.farm` (moved from `contact@tvc.farm` on
2026-08-19 — see the Forms/WhatsApp section below).

## Diagram

```mermaid
flowchart TD
    subgraph CURATE["0 · Offline photo curation — local machine, not part of the build"]
        SCRIPT_PULL["scripts/pull-approved-photos.mjs<br/>Downloads Drive 'Approved' folder locally,<br/>writes a caption sidecar per curator description,<br/>moves each file to 'Published' after download"]
        SCRIPT_CURATE["scripts/curate-photos.mjs<br/>Extracts EXIF/GPS, converts HEIC via heic-convert,<br/>resizes via sharp, uploads to R2, writes photos/*.md"]
        SCRIPT_CAPTION["scripts/caption-photos.mjs<br/>Sends each thumbnail to Claude,<br/>backfills draft captions into photos/*.md"]
    end

    subgraph SEOTOOLS["0b · Local SEO maintenance — local machine, not part of the build"]
        SCRIPT_GSC["scripts/check-search-console.mjs<br/>Looks up Google's own crawl/index status<br/>(coverageState, last crawl time) for one<br/>or more URLs — e.g. to confirm a<br/>netlify.toml redirect fix has been recrawled"]
    end

    subgraph CIACTIONS["0c · GitHub Actions — CI, on push to main"]
        GHA_MEMBER["member-update-email.yml<br/>+ send-member-update-email.mjs<br/>On push touching src/data/members.ts:<br/>diffs it, classifies changed cards<br/>new/updated, emails members@tvc.farm,<br/>BCCing each changed member's own address"]
        GHA_DOMAIN["domain-expiry.yml + check-domain-expiry.mjs<br/>Daily cron: reads each domain's expiry date from<br/>the registry's public RDAP service, emails<br/>core-team@tvc.farm at 60/30 days then daily from 14.<br/>Holds no database credentials; runs off Netlify<br/>on purpose, so it still alerts if Netlify pauses"]
    end

    subgraph SRC["1 · Source — github.com/TamarindValleyCollective/website (main)"]
        PAGES["src/pages/*.astro<br/>File-based routes: Home, About, Visit,<br/>Events, Ecosystem, Our Journey, Contact, etc."]
        INTERNALPAGE["src/pages/internal/photo-pool.astro<br/>Unlinked, noindex — photo review dashboard shell"]
        INTERNALPAGE2["src/pages/internal/whatsapp.astro<br/>Unlinked, noindex — WhatsApp reply dashboard shell,<br/>two-pane chat UI, 15s visibility-gated polling"]
        INTERNALPAGE3["src/pages/internal/accommodation-calendar.astro<br/>Unlinked, noindex — tent-booking dashboard shell,<br/>day/week/month calendar, guest directory, audit log"]
        INTERNALPAGE4["src/pages/internal/event-payments.astro<br/>Unlinked, noindex — event dropdown, stats,<br/>booking table, tier-suggested refund flow"]
        INTERNALPAGE5["src/pages/internal/usage.astro<br/>Unlinked, noindex — usage &amp; limits dashboard:<br/>alerts, per-service meters, domain renewals,<br/>admin forms for typed-in readings"]
        COMPONENTS["src/components/<br/>Nav, Footer, PageHero, ChatWidget,<br/>CookieConsent, JourneyTimelineStandalone,<br/>BiodiversityExplorer, PhotoGallery"]
        CONTENT["src/content/*<br/>Markdown collections: events, partners,<br/>community-outreach, photos"]
        FUNC_SRC["netlify/functions/chat.mts<br/>Serverless function, calls Anthropic API server-side"]
        FUNC_SRC10["netlify/functions/search-ai.mts<br/>Serverless function — the site search's only result<br/>type (no client-side keyword index). Gemini API free<br/>tier first, falls back to Anthropic. Shares retrieval<br/>logic with chat.mts via netlify/functions/lib/site-<br/>retrieval.ts. Self-rate-limits per-IP + a daily<br/>Anthropic-fallback budget via Blobs"]
        FUNC_SRC2["netlify/functions/event-interest.mts<br/>Serverless function, reads/writes Netlify Blobs"]
        FUNC_SRC3["netlify/functions/photo-pool.mts<br/>Serverless function, Google Sign-In gated —<br/>verifies ID token, checks the caller&#39;s<br/>role (staff_module_roles), lists Inbox (+ uploader/EXIF/GPS/<br/>description), moves photos, saves descriptions"]
        FUNC_SRC4["netlify/functions/enquiry.mts<br/>Serverless function — appends a row to a<br/>Google Sheet per membership/general enquiry,<br/>fired via sendBeacon alongside each form's<br/>own native Netlify Forms submission"]
        FUNC_SRC5["netlify/functions/rainfall.mts<br/>Serverless function — reads the community's<br/>rainfall-log Sheet (monthly + daily tabs) on<br/>every page view, computes the monsoon<br/>to-date stat, returns JSON"]
        FUNC_STATION["netlify/functions/station-weather.mts<br/>Serverless function — reads public weather-station<br/>sensors + last 24h from the HomeAssistant Supabase<br/>project (service_role, server-side only), CDN-cached 5 min"]
        FUNC_SRC6["netlify/functions/whatsapp-webhook.mts<br/>Serverless function — verifies Meta's GET<br/>handshake and each POST's HMAC signature,<br/>persists to Supabase per incoming WhatsApp<br/>message (no inbox exists for Cloud API<br/>numbers otherwise)"]
        FUNC_SRC7["netlify/functions/whatsapp-admin.mts<br/>Serverless function, Google Sign-In gated —<br/>lists conversations/messages from Supabase,<br/>sends replies via Meta's Send Message API"]
        FUNC_SRC8["netlify/functions/whatsapp-stale-alert.mts<br/>Scheduled function (cron, every 15 min) —<br/>emails core-team@tvc.farm one digest of<br/>WhatsApp conversations unread 60+ min,<br/>re-sent hourly per conversation until read"]
        FUNC_SRC9["netlify/functions/accommodation-admin.mts<br/>Serverless function, Google Sign-In gated —<br/>full tent-booking CRUD backed by Postgres<br/>(EXCLUDE constraints make double-booking<br/>physically impossible), guest directory,<br/>full audit log, past-booking justification"]
        FUNC_SRC11["netlify/functions/event-booking.mts<br/>Serverless function — checks the event's base<br/>Payment Link is open, saves a pending request<br/>in Supabase, WhatsApps + emails Linger a<br/>tokenised approve link, emails the guest"]
        FUNC_SRC18["netlify/functions/event-booking-approval.mts<br/>Serverless function, tokenised link (no login) —<br/>GET reads, POST approves or declines; approve<br/>creates the per-booking Payment Link (price x<br/>headcount, 48h) and sends it to the guest"]
        FUNC_SRC19["netlify/functions/partner-api.mts<br/>Serverless function, bearer-key auth (no login) —<br/>read-only unit catalogue + per-night availability<br/>for Linger; booking dates only, never guest data"]
        FUNC_SRC12["netlify/functions/razorpay-webhook.mts<br/>Serverless function — verifies signature, records<br/>payment_link.paid in Supabase (idempotent), emails<br/>a branded receipt; also handles refund.created/<br/>processed/failed — Razorpay's own confirmation is<br/>the only thing that marks a row actually refunded"]
        FUNC_SRC13["netlify/functions/cancel-booking.mts<br/>Serverless function — records a guest's<br/>cancellation request (not an automatic<br/>refund), notifies TVC + Linger + guest"]
        FUNC_SRC14["netlify/functions/event-payments-admin.mts<br/>Serverless function, Google Sign-In gated —<br/>per-event registrations/cancellations/money<br/>collected from Supabase, issues real Razorpay<br/>refunds (tier-suggested, admin-confirmed)"]
        FUNC_SRC15["netlify/functions/usage-collect.mts<br/>Scheduled function (cron, every 6 hours) — appends<br/>the Supabase database size, open connections + biggest tables, Netlify's plan<br/>credits + billing cycle and Resend's email quota to usage_snapshots for<br/>the free-tier usage dashboard. Optional secrets:<br/>NETLIFY_ACCESS_TOKEN, RESEND_USAGE_API_KEY,<br/>CLOUDFLARE_ANALYTICS_TOKEN"]
        FUNC_SRC16["netlify/functions/usage-admin.mts<br/>Serverless function, Google Sign-In gated (usage module) —<br/>overview of free-tier/credit usage, live domain<br/>expiry lookups, typed-in provider readings and<br/>price/limit settings (admins only, audit-logged)"]
        FUNC_SRC17["netlify/functions/usage-alerts.mts<br/>Scheduled function (cron, hourly) — evaluates the<br/>usage rules and emails core-team@tvc.farm one digest<br/>per new or worsened warning; remembers what it sent"]
        SCRIPT_SRC["scripts/build-chat-context.mjs<br/>Strips nav/footer from built HTML →<br/>content corpus for the chatbot"]
    end

    subgraph BUILD["2 · Build — on push to main"]
        B1["npm run build<br/>→ astro build (prerenders every page)"]
        B2["→ build-chat-context.mjs<br/>writes site-content.json (gitignored) —<br/>also grounds search-ai.mts's answers"]
        B2C["→ submit-indexnow.mjs (production builds only)<br/>pushes the sitemap URL list to api.indexnow.org,<br/>fanned out to Bing/Yandex/Seznam/Naver"]
        B3["Output: dist/ (static site) + bundled function<br/>netlify.toml declares build cmd, publish dir, functions dir"]
    end

    subgraph HOST["3 · Hosting: Netlify — LIVE"]
        CDN["Static CDN<br/>Serves dist/ — everything except<br/>the exceptions to the right"]
        APIFN["Netlify Function: /api/chat<br/>Deployed and live —<br/>ANTHROPIC_API_KEY set, calls the<br/>Anthropic API for grounded answers"]
        APIFN10["Netlify Function: /api/search-ai<br/>The site search's only result type.<br/>Deployed and live — verified against production<br/>2026-09-21, answering from the Gemini free tier"]
        APIFN2["Netlify Function: /api/event-interest<br/>Deployed and live —<br/>reads/writes the per-event count below"]
        APIFN3["Netlify Function: /api/photo-pool<br/>(+/thumb, +/description)<br/>Configured — Drive service account + folder IDs<br/>set as Netlify env vars for all deploy contexts"]
        APIFN4["Netlify Function: /api/enquiry<br/>Live and verified — Sheet ids set,<br/>Sheets shared Editor-access with the<br/>service account, real appends confirmed"]
        APIFN5["Netlify Function: /api/rainfall<br/>Reads the rainfall-log Sheet (view-access<br/>only, read-only path) — RAINFALL_SHEET_ID"]
        APIFN_STATION["Netlify Function: /api/station-weather<br/>Public sensors only, grouped by station"]
        APIFN6["Netlify Function: /api/whatsapp-webhook<br/>Deployed and live — verified end-to-end<br/>with a real WhatsApp message on 2026-08-19"]
        APIFN7["Netlify Function: /api/whatsapp-admin<br/>Deployed and live — real conversations<br/>read/replied to via /internal/whatsapp"]
        APIFN8["Netlify Function: whatsapp-stale-alert<br/>Scheduled (cron), no HTTP path —<br/>deployed and live"]
        APIFN9["Netlify Function: /api/accommodation-admin<br/>Deployed and live — merged 2026-08-30,<br/>verified against production"]
        APIFN11["Netlify Function: /api/event-booking<br/>Request-only since 2026-10-11 (approval-gated);<br/>Payment Link creation moved to APIFN19"]
        APIFN19["Netlify Function: /api/booking-approval<br/>Linger approve/decline; needs migration 0038<br/>applied before it can work"]
        APIFN20["Netlify Function: /api/partner/v1/*<br/>Phase 1, read-only — built, not deployed;<br/>migration 0060 applied; needs a key issued"]
        APIFN12["Netlify Function: /api/razorpay-webhook<br/>Deployed and live — live-mode webhook<br/>configured, signature verification confirmed"]
        APIFN13["Netlify Function: /api/cancel-booking<br/>Deployed and live"]
        APIFN14["Netlify Function: /api/event-payments-admin<br/>Deployed and live — backs /internal/event-payments,<br/>issues real refunds via Razorpay's API"]
        APIFN15["Netlify Function: usage-collect<br/>Scheduled (cron), no HTTP path"]
        APIFN16["Netlify Function: /api/usage-admin<br/>Deployed with the usage dashboard"]
        APIFN17["Netlify Function: usage-alerts<br/>Scheduled (cron, hourly), no HTTP path"]
        APIFN18["Netlify Function: whatsapp-event-reminders<br/>Scheduled (cron, daily 09:00 IST), no HTTP path —<br/>built, dormant until template approved"]
        BLOBS["Netlify Blobs<br/>'event-interest' store — one JSON record per<br/>past event id, {count, emails[]}, optimistic-<br/>concurrency writes. Reset via netlify blobs:delete<br/>event-interest &lt;id&gt;.<br/>'search-ai-rate-limit' store — per-IP window +<br/>daily Anthropic-fallback budget records.<br/>'chat-rate-limit' store — per-IP window +<br/>global daily message cap for /api/chat"]
        FORMS["Netlify Forms<br/>Captures /contact membership + general<br/>enquiries, /visit/host-an-event inquiries,<br/>/visit camping·day-visit·trekking inquiries,<br/>and event-interest submissions with an email"]
    end

    CF["Cloudflare<br/>DNS + CDN for tvc.farm,<br/>proxies to Netlify"]

    subgraph BROWSER["4 · Visitor's Browser"]
        CHATW["ChatWidget.astro<br/>Floating widget, site logo.<br/>Calls /api/chat"]
        SEARCH["SiteSearch.astro (in Nav)<br/>Submit-triggered (Enter, mobile keyboard 'Go',<br/>or tapping the search icon) — calls /api/search-ai<br/>for a grounded AI answer plus source links.<br/>No client-side keyword index"]
        FRIENDS["Friends of TVC —<br/>direct WhatsApp group invite link,<br/>no form involved"]
        MEMBERFORM["Membership enquiry form (/join)<br/>data-netlify=true + honeypot,<br/>also sendBeacons to /api/enquiry"]
        GENERALFORM["General enquiry form (/contact)<br/>data-netlify=true + honeypot,<br/>also sendBeacons to /api/enquiry;<br/>plus a WhatsApp link to Madhavan"]
        HOSTFORM["Host an Event inquiry form<br/>Plain HTML POST,<br/>data-netlify=true + honeypot"]
        BOOKING["Visit inquiry form (camping,<br/>day-visit, trekking pages)<br/>One shared form + WhatsApp link,<br/>data-netlify=true + honeypot"]
        INTEREST["Event interest widget (past events)<br/>Reads/writes /api/event-interest;<br/>if an email is given, also POSTs<br/>into Netlify Forms"]
        BIODIV["BiodiversityExplorer<br/>Fetches sightings directly from<br/>iNaturalist's public API"]
        PHOTOS["PhotoGallery (/in-pictures)<br/>Filters, Grid/Map toggle, lightbox —<br/>images served directly from R2"]
        TIMELINE["Our Journey / other pages<br/>Era-based year timeline, event listings —<br/>pure static, no calls out"]
        GA["Google Analytics (GA4)<br/>Loaded from BaseLayout, consent-gated by<br/>CookieConsent, skipped on localhost"]
        CLARITY["Microsoft Clarity<br/>Loaded from BaseLayout, same consent gate<br/>as GA, skipped on localhost"]
        WEATHER["WeatherWidget (/ecosystem/geography)<br/>Fetches current conditions from<br/>Open-Meteo, no API key"]
        RAINFALL["Rainfall chart/table/monsoon stat<br/>(/ecosystem/weather)<br/>Fetches /api/rainfall client-side,<br/>1hr-cached in localStorage"]
        STATIONCARD["Live station card (/ecosystem/weather)<br/>StationWeather.astro fetches /api/station-weather,<br/>hidden if the station is silent for 3h"]
        BOOKINGFORM["EventBookingForm.astro<br/>(rendered on an opted-in event's page)<br/>name/email/phone/headcount, calls<br/>/api/event-booking, shows "request received"<br/>(no charge yet). Prefills from a returning visitor's<br/>last booking via localStorage"]
        APPROVEPAGE["/approve-booking page<br/>Noindex, sitemap-excluded — linked from the<br/>WhatsApp/email alert to Linger; Approve /<br/>Decline buttons POST to /api/booking-approval"]
        CANCELPAGE["/cancel-booking page<br/>Linked from the receipt email —<br/>shows booking summary, confirms<br/>cancellation request via /api/cancel-booking"]
    end

    subgraph INTERNAL5["5 · Internal tool — admin-only, not part of the public site flow"]
        POOLDASH["Photo Pool dashboard (/internal/photo-pool)<br/>Google Sign-In gated client-side shell — shows uploader,<br/>EXIF/GPS, editable description; unlinked, noindex,<br/>sitemap-excluded"]
        WHATSAPPDASH["WhatsApp dashboard (/internal/whatsapp)<br/>Google Sign-In gated two-pane chat UI — conversation<br/>list + thread + reply box; unlinked, noindex,<br/>sitemap-excluded"]
        ACCOMMODATIONDASH["Accommodation Allocation (/internal/accommodation-calendar)<br/>Google Sign-In gated tent-booking dashboard —<br/>day/week/month views, guest directory + typeahead,<br/>audit log; unlinked, noindex, sitemap-excluded"]
        EVENTPAYDASH["Event Payments (/internal/event-payments)<br/>Google Sign-In gated dashboard — event dropdown,<br/>registrations/cancellations/money-collected stats,<br/>tier-suggested refund with two-step confirm;<br/>unlinked, noindex, sitemap-excluded"]
        USAGEDASH["Usage &amp; limits (/internal/usage)<br/>Google Sign-In gated dashboard — Anthropic, Gemini,<br/>TypeSafe, Supabase measured; Netlify allowance + Resend quota read<br/>from their APIs; Cloudflare R2 storage read from its<br/>analytics API; Netlify balance and the Anthropic credit<br/>balance typed in by an admin; domain<br/>renewals read live; unlinked, noindex, sitemap-excluded"]
    end

    subgraph EXTERNAL["External services (called directly by the browser)"]
        INAT["iNaturalist API"]
        GMAPS["Google Maps (iframe, directions only)"]
        YT["YouTube (iframe)"]
        ANTHROPIC["Anthropic Claude API<br/>(chat.mts server-side,<br/>search-ai.mts's fallback,<br/>members-me.mts's story check,<br/>and caption-photos.mjs locally)"]
        GEMINI["Google Gemini API (free tier)<br/>search-ai.mts server-side —<br/>site search's AI answer, tried first"]
        TYPESAFE["TypeSafe API (Jev model)<br/>whatsapp-webhook.mts server-side —<br/>shadow-mode read of each inbound WhatsApp<br/>message; off unless TYPESAFE_WHATSAPP_SHADOW=true"]
        R2["Cloudflare R2<br/>media.tvc.farm — curated photo storage,<br/>served directly to the browser"]
        GTAG["Google Analytics<br/>googletagmanager.com/gtag/js"]
        CLARITYEXT["Microsoft Clarity<br/>www.clarity.ms tag → scripts.clarity.ms<br/>bundle → *.clarity.ms/collect (subdomain<br/>varies, load-balanced)"]
        METEO["Open-Meteo API<br/>Free, no key required"]
        GDRIVE["Google Drive API<br/>Shared Inbox/Approved/Rejected/Published<br/>folders — service-account auth,<br/>called server-side only (Function + local script)"]
        GSHEET["Google Sheets API<br/>membership/general enquiry logs (write,<br/>enquiry.mts) + rainfall log (read,<br/>rainfall.mts) + Members story-form<br/>responses (read + write Processed-at/Notes,<br/>check-member-story-responses.mjs) —<br/>same service account, called server-side<br/>only (Functions) or from a local script"]
        GIDTOKEN["Google Identity Services / OAuth<br/>Curator sign-in (browser) +<br/>ID token verification against<br/>Google's public JWKS (photo-pool.mts)"]
        GSC["Google Search Console API<br/>urlInspection.index.inspect — read-only,<br/>same service account (Full user on the<br/>property as of 2026-08-08),<br/>called from a local script only"]
        NETLIFYAPI["Netlify API<br/>GET /accounts/{id} — plan credits + billing cycle<br/>dates; the site's deploy list + build minutes (credits<br/>USED is not exposed), called by usage-collect.mts<br/>with NETLIFY_ACCESS_TOKEN"]
        RESEND["Resend API<br/>Transactional email — noreply@tvc.farm,<br/>domain verified 2026-08-19,<br/>called from the GitHub Action above,<br/>whatsapp-stale-alert.mts and usage-collect.mts<br/>(GET /usage quota read)"]
        WAMETA["Meta WhatsApp Cloud API<br/>Sends inbound message + template-status<br/>events to /api/whatsapp-webhook;<br/>receives replies from whatsapp-admin.mts<br/>and (once approved) guest/staff templates<br/>from lib/whatsapp-send.ts; see WHATSAPP.md for setup status"]
        LINGERSYS["Linger booking system<br/>External partner — calls /api/partner/v1/*<br/>server-to-server with its own API key"]
        SUPABASE["Supabase Postgres ('TVC ERP' project)<br/>whatsapp_conversations/whatsapp_messages,<br/>event_payments, staff_users/staff_module_roles/<br/>staff_audit_log (gate all four admin Functions),<br/>staff_mfa_factors/staff_recovery_codes/<br/>staff_mfa_state (super-admin second factors),<br/>usage_daily/usage_snapshots/usage_settings/<br/>usage_alert_state (free-tier metering + alerts) —<br/>service_role key, called server-side only"]
        SUPABASE_HA["Supabase Postgres (separate 'HomeAssistant' project/org)<br/>sensor_readings (Home Assistant pushes with the anon key,<br/>insert-only, registered sensors only), sensors registry,<br/>sensor_hourly rollup — supabase/homeassistant/"]
        HASSIST["Home Assistant (farmassistant.tvc.farm)<br/>Automation 'Push weather sensors to Supabase'<br/>from the Meshtastic campground weather station"]
        RAZORPAY["Razorpay API<br/>Payment Links (create/fetch) +<br/>payment_link.paid webhook + refunds<br/>(admin-triggered, event-payments-admin.mts) +<br/>payment fees and settlement recon<br/>(nightly reconcile-event-payment-fees.mjs).<br/>Live keys as of 2026-09-24 —<br/>see RAZORPAY.md"]
        RDAP["Registry RDAP service (via IANA bootstrap,<br/>rdap.org fallback)<br/>Public, no key — domain expiry dates for<br/>tvc.farm and syntropic.in"]
    end

    SRC --> BUILD
    BUILD --> HOST
    HOST --> CF
    CF --> BROWSER
    BIODIV -.-> INAT
    APIFN -.-> ANTHROPIC
    SEARCH -.->|"search submit"| APIFN10
    APIFN10 -.->|"tried first"| GEMINI
    APIFN10 -.->|"fallback"| ANTHROPIC
    PHOTOS -.-> R2
    GA -.-> GTAG
    WEATHER -.-> METEO
    RAINFALL --> APIFN5
    APIFN5 -.->|"read monthly + daily tabs"| GSHEET
    STATIONCARD --> APIFN_STATION
    APIFN_STATION -.->|"read public sensors + hourly rollup"| SUPABASE_HA
    HASSIST -.->|"insert readings (anon key)"| SUPABASE_HA
    FUNC_STATION -.-> SUPABASE_HA
    WAMETA -.->|"POST webhook events"| APIFN6
    APIFN6 -.->|"send notification email"| RESEND
    APIFN6 -.->|"upsert conversation,<br/>insert inbound message,<br/>store Jev read (shadow)"| SUPABASE
    APIFN6 -.->|"read of each inbound message<br/>(shadow mode, flag off by default)"| TYPESAFE
    APIFN8 -.->|"query unread 60+ min"| SUPABASE
    APIFN8 -.->|"send digest email"| RESEND
    BOOKINGFORM --> APIFN11
    APIFN11 -.->|"fetch base link (open?)"| RAZORPAY
    APIFN11 -.->|"insert pending request,<br/>alert emails"| SUPABASE
    APPROVEPAGE --> APIFN19
    APIFN19 -.->|"fetch base link price,<br/>create per-booking link"| RAZORPAY
    APIFN19 -.->|"claim approve/decline,<br/>store link"| SUPABASE
    RAZORPAY -.->|"payment_link.paid / refund.created /<br/>refund.processed / refund.failed webhooks"| APIFN12
    APIFN12 -.->|"record payment<br/>(idempotent)"| SUPABASE
    APIFN12 -.->|"send branded receipt"| RESEND
    CANCELPAGE --> APIFN13
    APIFN13 -.->|"look up + record<br/>cancellation request"| SUPABASE
    APIFN13 -.->|"notify TVC + Linger + guest"| RESEND
    SCRIPT_CURATE -.->|"S3-compatible upload"| R2
    SCRIPT_CURATE -->|"writes"| CONTENT
    SCRIPT_CAPTION -.->|"vision request per photo"| ANTHROPIC
    SCRIPT_CAPTION -->|"backfills caption:"| CONTENT
    SCRIPT_PULL -.->|"download + move files"| GDRIVE
    SCRIPT_GSC -.->|"inspect URL indexing/crawl status"| GSC
    GHA_MEMBER -.->|"look up changed members' emails"| GSHEET
    GHA_MEMBER -.->|"send update email"| RESEND
    CHATW --> APIFN
    HOSTFORM --> FORMS
    BOOKING --> FORMS
    MEMBERFORM --> FORMS
    GENERALFORM --> FORMS
    MEMBERFORM -.->|"sendBeacon"| APIFN4
    GENERALFORM -.->|"sendBeacon"| APIFN4
    APIFN4 -.->|"append enquiry row"| GSHEET
    INTEREST --> APIFN2
    APIFN2 --> BLOBS
    APIFN10 -.->|"rate-limit checks"| BLOBS
    INTEREST -.->|"only when an email is given"| FORMS
    CF --> INTERNAL5
    POOLDASH --> APIFN3
    APIFN3 -.->|"list Inbox, proxy thumbnails,<br/>move on approve/reject"| GDRIVE
    APIFN3 -.->|"check admin role"| SUPABASE
    APIFN3 -.->|"verify curator's ID token"| GIDTOKEN
    POOLDASH -.->|"Sign in with Google"| GIDTOKEN
    WHATSAPPDASH --> APIFN7
    APIFN7 -.->|"list/read conversations + messages"| SUPABASE
    APIFN7 -.->|"send reply"| WAMETA
    APIFN7 -.->|"check admin role"| SUPABASE
    APIFN7 -.->|"verify admin ID token"| GIDTOKEN
    WHATSAPPDASH -.->|"Sign in with Google"| GIDTOKEN
    ACCOMMODATIONDASH --> APIFN9
    APIFN9 -.->|"read/write bookings, guests,<br/>audit log"| SUPABASE
    APIFN9 -.->|"check admin role"| SUPABASE
    APIFN9 -.->|"verify admin ID token"| GIDTOKEN
    LINGERSYS -.->|"GET /units, /availability<br/>(Bearer key)"| APIFN20
    APIFN20 -.->|"check key hash + grants,<br/>read booking dates only"| SUPABASE
    ACCOMMODATIONDASH -.->|"Sign in with Google"| GIDTOKEN
    EVENTPAYDASH --> APIFN14
    APIFN14 -.->|"read/write bookings,<br/>record refunds"| SUPABASE
    APIFN14 -.->|"issue refund"| RAZORPAY
    APIFN14 -.->|"send refund<br/>confirmation email"| RESEND
    APIFN14 -.->|"check admin role,<br/>audit refunds"| SUPABASE
    APIFN14 -.->|"verify admin ID token"| GIDTOKEN
    EVENTPAYDASH -.->|"Sign in with Google"| GIDTOKEN

    GHA_DOMAIN -.->|"look up expiry dates"| RDAP
    GHA_DOMAIN -.->|"send renewal reminder"| RESEND
    APIFN15 -.->|"db size snapshot"| SUPABASE
    APIFN15 -.->|"plan credits + cycle"| NETLIFYAPI
    APIFN15 -.->|"email quota read"| RESEND
    APIFN15 -.->|"R2 storage analytics"| R2
    APIFN -.->|"per-call usage counts"| SUPABASE
    APIFN10 -.->|"per-call usage counts"| SUPABASE

    USAGEDASH --> APIFN16
    APIFN16 -.->|"read usage_daily/usage_snapshots/settings,<br/>write readings + settings"| SUPABASE
    APIFN16 -.->|"live domain expiry"| RDAP
    APIFN16 -.->|"check admin role"| SUPABASE
    APIFN16 -.->|"verify admin ID token"| GIDTOKEN
    USAGEDASH -.->|"Sign in with Google"| GIDTOKEN
    APIFN17 -.->|"read usage data, remember<br/>alerts already sent"| SUPABASE
    APIFN17 -.->|"send alert digest"| RESEND
    APIFN18 -.->|"bookings for tomorrow,<br/>claim reminder"| SUPABASE
    APIFN18 -.->|"send tvc_event_reminder<br/>template"| WAMETA

    classDef staticStyle fill:#e8f2ea,stroke:#17723b,color:#0f5029
    classDef netlifyStyle fill:#fdead3,stroke:#f78520,color:#9a5310
    classDef externalStyle fill:#f6f1e7,stroke:#c9c2a8,color:#22291f
    classDef cfStyle fill:#fef3e0,stroke:#e8891c,color:#7a4a00
    classDef localStyle fill:#eef0f5,stroke:#6b7280,color:#374151
    classDef ciStyle fill:#eef4fb,stroke:#3b6ea5,color:#1c3f5f

    class PAGES,INTERNALPAGE,INTERNALPAGE2,INTERNALPAGE3,INTERNALPAGE4,INTERNALPAGE5,COMPONENTS,CONTENT,CHATW,SEARCH,FRIENDS,MEMBERFORM,GENERALFORM,HOSTFORM,BOOKING,INTEREST,BIODIV,PHOTOS,TIMELINE,GA,WEATHER,RAINFALL,STATIONCARD,CDN,POOLDASH,WHATSAPPDASH,ACCOMMODATIONDASH,EVENTPAYDASH,USAGEDASH,BOOKINGFORM,CANCELPAGE,APPROVEPAGE staticStyle
    class FUNC_SRC,FUNC_SRC2,FUNC_SRC3,FUNC_SRC4,FUNC_SRC5,FUNC_STATION,FUNC_SRC6,FUNC_SRC7,FUNC_SRC8,FUNC_SRC9,FUNC_SRC10,FUNC_SRC11,FUNC_SRC12,FUNC_SRC13,FUNC_SRC14,FUNC_SRC15,FUNC_SRC16,FUNC_SRC17,FUNC_SRC18,FUNC_SRC19,SCRIPT_SRC,SCRIPT_SRC2,APIFN,APIFN2,APIFN3,APIFN4,APIFN5,APIFN_STATION,APIFN6,APIFN7,APIFN8,APIFN9,APIFN10,APIFN11,APIFN12,APIFN13,APIFN14,APIFN15,APIFN16,APIFN17,APIFN18,APIFN19,APIFN20,BLOBS,FORMS,ANTHROPIC netlifyStyle
    class INAT,GMAPS,YT,R2,GTAG,METEO,GDRIVE,GSHEET,GIDTOKEN,GSC,RESEND,WAMETA,LINGERSYS,SUPABASE,SUPABASE_HA,HASSIST,GEMINI,TYPESAFE,RAZORPAY,RDAP externalStyle
    class CF cfStyle
    class SCRIPT_CURATE,SCRIPT_CAPTION,SCRIPT_PULL,SCRIPT_GSC localStyle
    class GHA_MEMBER,GHA_DOMAIN ciStyle
```

**Legend:** 🟢 static / no server required · 🟠 depends on Netlify specifically (Functions or
Forms) · ⬜ external third-party service (includes R2, which is a Cloudflare product but plays
the role of an external media store here, not part of the Netlify hosting path) · 🟡 Cloudflare
DNS/CDN layer in front of Netlify · ⚪ runs locally on a contributor's machine, outside the
Netlify build (the offline photo curation and captioning scripts) · 🔵 runs in GitHub Actions CI,
outside both the local machine and Netlify (the member-update-email workflow).

## Layer-by-layer detail

### 1. Source (GitHub)

- **`src/pages/*.astro`** — file-based routes for every page: Home, About, Visit, Events,
  Ecosystem, Our Journey, Contact, In Pictures, and their sub-pages.
- **`src/pages/internal/photo-pool.astro`** — unlinked, `noindex`, sitemap-excluded. A static
  page whose only content is a Google Sign-In gated client-side dashboard (see `netlify/functions/
  photo-pool.mts` below) for reviewing photos dropped into a shared Google Drive "Inbox" folder —
  each card shows the uploader (Drive's `lastModifyingUser`, falling back to `owners[0]`, since
  ownership doesn't reliably transfer across non-Workspace accounts), EXIF (camera, aperture,
  shutter speed, ISO, focal length) and GPS (linked out to Google Maps) that Drive already
  extracts server-side on upload, and an editable description saved independently of the
  Approve/Reject decision via its own "Save" action.
- **`src/pages/internal/whatsapp.astro`** — unlinked, `noindex`, sitemap-excluded. Same shell
  pattern as `photo-pool.astro` (Google Sign-In gate, `sessionStorage`-held ID token, `authedFetch`
  helper), backing a two-pane chat UI (see `netlify/functions/whatsapp-admin.mts` below): a
  conversation list on the left, the selected thread on the right with a reply box. Polls every 15
  seconds while the tab is visible (`document.visibilityState`) rather than real-time/WebSockets —
  deliberately a small internal tool.
- **`src/pages/internal/accommodation-calendar.astro`** — unlinked, `noindex`, sitemap-excluded.
  Same Google Sign-In shell pattern as `photo-pool.astro`/`whatsapp.astro`, backing the farm
  manager's tent-booking dashboard (see `netlify/functions/accommodation-admin.mts` below): a
  day/week/month calendar (day view redesigned 2026-08-30 into a wide, name-visible list per
  tent rather than a cramped single-column table), tapping a grid cell opens a booking dialog
  pre-filled with that tent/date, a guest directory with name/mobile-number typeahead, and a
  full create/update/delete audit log. Built alongside a public, aggregate-only availability
  view (`AvailabilityView.astro` + `/visit/availability`) that was **deliberately not shipped**
  with this initial production launch — dropped rather than deferred, pending a rethink of that
  approach.
- **`src/pages/internal/event-payments.astro`** — unlinked, `noindex`, sitemap-excluded. Same
  Google Sign-In shell pattern as the three pages above, backing per-event payment tracking (see
  `netlify/functions/event-payments-admin.mts` below): an event dropdown (built at request time
  from the `events` content collection, filtered to entries with a `razorpayReferenceId`), a
  stats row (registrations/attendees, cancelled/pending count, gross/net collected), and a
  booking table. A "Cancel & refund" action per row expands an inline form pre-filled with a
  suggested amount from `/refund-policy`'s day-before-event tiers (computed client-side from the
  event's own `date`), then requires a second explicit "Yes, refund ₹X" click before it ever
  calls the admin function — no amount is sent to Razorpay from a single click.
- **`src/components/`** — shared UI: Nav, Footer, PageHero, the ChatWidget, the year-by-year
  `JourneyTimelineStandalone` component, the live `BiodiversityExplorer`, and `PhotoGallery`
  (In Pictures - filters, Grid/Map toggle, lightbox; its map, `photo-map.ts`, reuses the same
  Leaflet + OpenStreetMap setup as the biodiversity map, adapted for photo-thumbnail pins).
- **`src/content/`** — Markdown content collections that change over time without touching
  code: `events`, `partners`, `community-outreach`, `photos` (the last one populated by the
  offline curation script below, not authored by hand).
- **`netlify/functions/chat.mts`** — powers the chat widget. Rather than stuffing the entire
  `site-content.json` corpus into every request's system prompt (the original approach — risked
  exceeding the function's ~10s Netlify execution timeout on a prompt-cache miss, since ~28.5k
  corpus tokens plus Claude's own response time could exceed it), it runs a small keyword-overlap
  retrieval step per request (`selectRelevantPages()`) to pick a handful of relevant pages plus a
  fixed core set (home/about/visit/people), and separately matches the message against
  `src/data/members.ts` directly to inject a matched member's full record (bio/family/why-TVC/
  social) — the last three of those fields only ever render client-side from the Members page's
  popup JSON, so they're invisible to `build-chat-context.mjs`'s static-HTML scrape no matter how
  the page corpus itself is tuned.
- **`netlify/functions/lib/rate-limit.ts`** — shared rate limiting for the two public, unauthenticated
  LLM endpoints (`chat.mts`, `search-ai.mts`): `checkIpRateLimit` (per-IP fixed window) and
  `checkDailyCap` (global, date-keyed so it resets itself), both on Netlify Blobs. `chat.mts` had
  no limit at all until 2026-10-04 and spends paid Anthropic credits on every message; it now
  allows 20 messages per IP per 10 minutes and 100 per day across everyone (lowered from 500 on 2026-10-04 after measuring ~14k input tokens per message; constants at the top of
  `chat.mts`), and fails *open* — logging, not blocking — if Blobs itself errors, so a storage
  hiccup can't take the chat down. Part of the groundwork for the planned usage/free-tier
  dashboard (a new admin module); see that module's docs once it lands.
- **`netlify/functions/lib/usage-meter.ts` + `usage-collect.mts` + `scripts/check-domain-expiry.mjs`**
  — the measuring half of the free-tier usage dashboard (see the next bullet for the dashboard
  itself). There is no usage API to read for an individual Anthropic account or
  the Gemini free tier, so we count our own calls: `callAnthropic()` and `search-ai.mts`'s Gemini call
  add requests/tokens/error counts (incl. `billing_errors`, Gemini `quota_exhausted`) to per-day
  running totals in Supabase `usage_daily` through the atomic `usage_record()` function. Metering
  never fails a request (errors are logged and swallowed, 2s timeout), and stores counts only — no
  message text, IPs or emails. `usage-collect.mts` (scheduled, every 6h) records the database size
  to `usage_snapshots` against the free plan's 500 MB (plus open connections and the 8 biggest tables via
  `usage_db_connections()` / `usage_db_tables()`, migrations `0033` / `0058`; the page derives growth and time-to-full from the
  size history, and an alert fires if the database would fill within 60 days), and — when `NETLIFY_ACCESS_TOKEN` is set —
  reads the TVC team's plan credit allowance and billing-cycle dates from the Netlify API
  (`GET /accounts/{id}`; credits *remaining/used* is not exposed, so the remaining balance stays a typed-in reading), and the
  cycle's deploy activity (`GET /sites/{id}/deploys` and `GET /{account_id}/builds/status`: production deploys at a flat 15
  credits each, failed/preview counts, build minutes, last deploy; counts and timings only, stored as a `netlify/deploy_activity`
  snapshot) so the page can show credits spent on deploys and warn when the pace would exhaust the allowance; a Netlify
  call failing never fails the Supabase one, and each read is independent of the others). It likewise reads Resend's daily/monthly email quota
  from `GET https://api.resend.com/usage` with a separate full-access `RESEND_USAGE_API_KEY` (the sending-only key is refused), and R2 storage
  from Cloudflare's GraphQL analytics API (`POST https://api.cloudflare.com/client/v4/graphql`,
  read-only `CLOUDFLARE_ANALYTICS_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). Both tables and functions are service_role
  only (migration `0030_usage_metering.sql`, applied to production 2026-10-04; RLS on, no policies). Domain renewals are checked by the
  `domain-expiry.yml` GitHub Action instead: it reads each domain's expiry from the registry's public
  RDAP service (no key, same answer whichever registrar holds it) and emails `core-team@tvc.farm` at
  60 and 30 days, then daily from 14. It runs in GitHub, not Netlify, deliberately — if Netlify
  pauses the site over exhausted credits a Netlify-hosted monitor would go silent too — and it holds
  no database credentials, only the `RESEND_API_KEY` already used by `member-update-email.yml`.
- **`netlify/functions/usage-admin.mts` + `usage-alerts.mts` + `/internal/usage` +
  `scripts/lib/usage-rules.mjs`** — the usage & limits module (see `USAGE.md`). A new `usage` admin
  module (`view` for any role, `configure` admin-only). `usage-admin.mts` serves the page: the
  overview (Anthropic, Gemini and TypeSafe counts, Supabase size, typed-in readings, active warnings), a
  separate `/domains` route (live RDAP lookups with a 4s timeout, cached an hour, so a slow registry
  can't hold up the page), and the two admin writes — a typed-in reading from a provider's own
  dashboard and the price/limit settings — each audit-logged by admin id before it is written and
  refused if the log can't be written. Nothing it returns contains an email or message text.
  `usage-alerts.mts` (hourly) evaluates the same rules and emails `core-team@tvc.farm` one digest,
  mailing a condition once and again only if it gets worse; `usage_alert_state` remembers what has
  been sent and forgets it when the condition clears. All thresholds and the Anthropic credit
  *estimate* (typed-in balance minus metered spend since, using admin-entered token prices) live in
  `usage-rules.mjs`, pure functions with unit tests. Tables from migration `0031_usage_dashboard.sql`.
  Typed-in services (the Netlify balance, the Anthropic balance, and the fallbacks for Resend and Cloudflare R2) are typed in on purpose:
  holding an API credential for each would add a secret broader than a usage reading is worth.
- **`netlify/functions/lib/site-retrieval.ts`** — shared retrieval + Anthropic-call plumbing
  factored out of `chat.mts` so it and `search-ai.mts` below can't drift apart:
  `selectRelevantPages()`, `matchMembers()`, `formatPages()`/`formatMembers()`, the
  language-instruction builder, and `callAnthropic()` (the Anthropic request/response shape,
  including the "not always `content[0]`" parsing quirk noted above).
- **`netlify/functions/search-ai.mts`** — powers the site search's only result type (see
  `SiteSearch.astro` below): same grounded retrieval as `chat.mts` via the shared lib above, but
  single-shot (no conversation history) and answers from the Gemini API's free tier first, falling
  back to the same Anthropic API `chat.mts` uses only if `GEMINI_API_KEY` is unset, rate-limited,
  or erroring — so a free-tier hiccup degrades to a paid-but-working answer rather than an outright
  failure. Both `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are live in production — verified
  directly against `tvc.farm/api/search-ai` on 2026-09-21, answering from the Gemini free tier as
  expected. Being public and unauthenticated, this
  endpoint also rate-limits itself: a per-IP fixed window before any provider call, plus a separate
  global daily cap on Anthropic-fallback invocations specifically (50 a day, lowered from 200 on 2026-10-04 after measuring ~9.5k tokens per search), both backed by a Netlify Blobs
  store (`search-ai-rate-limit`, see Hosting below) — guards against cost exhaustion on the paid
  fallback from either a single abusive client or many distinct ones.
- **`netlify/functions/event-interest.mts`** — powers the "Want this to happen again?" widget
  (Netlify Blobs, see Hosting below).
- **`netlify/functions/photo-pool.mts`** — backs `/internal/photo-pool`. Gated by real Google
  Sign-In rather than a shared password: a curator authenticates client-side via Google Identity
  Services, and this Function verifies the resulting ID token itself
  (`scripts/lib/google-id-token.mjs`) before checking the person's role in the `photo-pool`
  module (`view` to list/thumbnail, `review` to approve/reject/describe) via the shared
  `requireStaff` helper below — migrated 2026-10 from a one-column "Photo Pool Curators" Google
  Sheet allow-list. A real Google Group wasn't an option since curators are a mix of Workspace
  and personal Gmail accounts (group-membership APIs only work within a Workspace domain you
  administer). The uploader's email is never sent to the browser, and their name is masked for
  `read_only` roles. Once authenticated and authorized, it
  lists images in the Drive "Inbox" folder (with uploader/EXIF/GPS/description), proxies their
  thumbnails, saves an edited description to a file's Drive `description` field on its own, and
  moves a file to "Approved" or "Rejected" on a curator's decision. Drive itself is the state
  machine — no database. Normalizes `imageMediaMetadata.time`, which Drive returns
  EXIF-formatted (`"2015:04:11 15:20:33"`) rather than RFC 3339 like every other Drive
  timestamp — passing it straight to `Date` silently produces "Invalid Date". Uses
  `scripts/lib/google-drive.mjs`'s hand-rolled service-account JWT auth (Node's built-in
  `crypto`, no `googleapis`/`google-auth-library` dependency) rather than a heavier client
  library, matching this repo's preference for small hand-rolled implementations for
  well-defined tasks (see `src/utils/calendar.ts`'s ICS generation).
- **`netlify/functions/enquiry.mts`** — backs the membership enquiry form (bottom of `/join`)
  and the general enquiry form (`/contact`). Each form submits natively via Netlify Forms (email
  handled by the site-wide "Email notification" rule in the Netlify dashboard, pointed at
  `core-team@tvc.farm`); this Function exists purely
  for the one thing Netlify Forms can't do on its own — logging the same enquiry as a row in a
  Google Sheet, one sheet per form type. The page fires it via `navigator.sendBeacon` alongside
  the form's own native submission (rather than intercepting/replacing it), since `sendBeacon` is
  designed to survive the page navigating away right after — unlike a plain `fetch()` in the same
  submit handler, which isn't guaranteed to complete once the browser starts navigating. Reuses
  `scripts/lib/google-drive.mjs`'s `appendSheetRow()` (added alongside this Function; widened the
  file's Sheets scope from `spreadsheets.readonly` to full `spreadsheets` since this is the first
  write path — actual access is still gated per-spreadsheet by sharing, not by the scope alone).
- **`netlify/functions/rainfall.mts`** — backs the multi-year rainfall line chart, its monthly
  table, and the "this monsoon so far" stat on `/ecosystem/weather`. That data used to be a
  hand-copied snapshot baked into `WeatherView.astro`'s frontmatter, updated by hand whenever
  someone remembered to; this Function reads the community's shared "Tvc rain data" Google Sheet
  live on every page view instead (`RAINFALL_SHEET_ID`, view-access only — this path never
  writes), so a new row logged in the Sheet shows up on the site with no code change or rebuild.
  Reads two tabs, both calendar-year-native (not agricultural-year, as they were before an
  August 2026 restructure of the Sheet — see `buildCalendarYears()`'s comments for the exact
  shape): "Rain data monthly" (one row per month, one column per plain calendar year, e.g.
  "2025") drives the chart's one-line-per-year view and its table, reshaped to null out months
  that haven't happened yet rather than guessing from blank cells (the Sheet pre-fills future
  cells with a literal "0" instead of leaving them blank, so blankness alone can't signal "not
  logged yet"). "Daily rain data" (a flat table, one row per calendar year+month, day-of-month
  columns) is what makes a fair "same stretch last year" comparison possible, summing each year
  from Jan 1 through today's exact date rather than comparing a partial year against another
  year's full total. Until the current month has at least one day logged (typically the first
  day or two of each month), the cutoff steps back to the end of the latest logged month and
  that month's pre-filled "0" is treated as not-yet-reached, so the stat, chart line and
  today-marker all stop at the same date instead of the stat blanking to "—". Reuses `scripts/lib/google-drive.mjs`'s `getSheetValues()` (a small
  generalization of the existing single-column `getAllowedEmails()` reader into a full-grid one,
  used by both now).
- **`netlify/functions/station-weather.mts`** — backs the live "Campground station" card on
  `/ecosystem/weather` (`StationWeather.astro`). Home Assistant (`farmassistant.tvc.farm`) pushes
  the Meshtastic weather station's readings (temperature, humidity, pressure) into a *separate*
  "HomeAssistant" Supabase project/org — not "TVC ERP" — table `sensor_readings`, via an
  automation using that project's anon key. The schema lives in `supabase/homeassistant/` (applied
  by hand to that project only, not part of `supabase/migrations/`): a `sensors` registry
  (station, kind, label, `public` flag), an anon INSERT policy restricted to *registered* sensors
  (so a leaked anon key can't write arbitrary rows — register a new sensor before pointing Home
  Assistant at it), grants stripped to insert-only, and an hourly `sensor_hourly` rollup view. This
  Function (`STATION_SUPABASE_URL` / `STATION_SUPABASE_SERVICE_ROLE_KEY`, deliberately not the
  `SUPABASE_*` pair, which is TVC ERP's) returns only `public` sensors grouped by station — latest
  value plus the last 24 hourly averages, never the raw `attributes` — with a 5-minute Netlify CDN
  cache so page views don't each hit the database. The card renders nothing if the fetch fails or a
  station has been silent for 3 hours, leaving the Open-Meteo `WeatherWidget` beside it as the
  fallback. A new station or sensor appears on the site by adding `sensors` rows, with no code change.
- **`netlify/functions/whatsapp-webhook.mts`** — the WhatsApp Cloud API webhook endpoint (see
  `WHATSAPP.md` for the full setup checklist). Handles Meta's one-time GET verification handshake
  (`hub.mode`/`hub.verify_token`/`hub.challenge`, echoing the challenge back if the token matches
  `WHATSAPP_VERIFY_TOKEN` — an arbitrary string chosen ourselves, not a Meta-issued secret) and
  POST requests carrying real events, each verified via its `X-Hub-Signature-256` header (HMAC-
  SHA256 over the *raw* request body using `WHATSAPP_APP_SECRET`, the Meta app's own secret) before
  the payload is trusted at all — computed with Node's built-in `crypto`, no dependency added.
  Cloud API numbers have no inbox of their own (confirmed by checking every tab in WhatsApp
  Manager and Meta's own docs), so every inbound message is persisted to Supabase
  (`scripts/lib/supabase.mjs`, upserting a conversation by phone number then inserting a message
  row) so `/internal/whatsapp` below can show and reply to it. `message_template_status_update`
  events are logged only, not emailed, for now. **Live** — verified end-to-end with a real
  WhatsApp message on 2026-08-19. Used to also email `core-team@tvc.farm` on every message —
  removed 2026-08-20 in favor of `whatsapp-stale-alert.mts`'s digest below, once per-message
  emails turned out to be more clutter than signal.
- **`netlify/functions/whatsapp-admin.mts`** — backs `/internal/whatsapp`, the WhatsApp reply
  dashboard (2026-08-20). Same Google Sign-In auth pattern as `photo-pool.mts` (verifies the ID
  token, then `requireStaff` checks the caller's role in the `whatsapp` module: `view` to read,
  `reply` to send, `manage` to block — migrated 2026-10 from the shared Sheet allow-list). A
  contact's phone number never leaves this Function: replies and blocks look it up server-side by
  conversation id, responses carry only a `label` (the contact's name, masked for `read_only`
  roles, or an opaque "Contact XXXX" when they have none), and search never matches on it. The
  reply signature is the name typed on the page; only if that is missing does it fall back to the
  admin's registered name, then the name on their Google account (the ID token's `name`
  claim), then a masked address like `a••••@gmail.com` (`maskEmail`) — never the full email, which
  used to be printed into the customer's chat. Blocking is audit-logged before it happens and refused if the log write fails.
  Four routes: list conversations (optionally filtered by a `search` query param — matches contact
  name (not for `read_only` roles) or message content, never phone, via `scripts/lib/supabase.mjs`'s `searchConversations`, two REST calls merged
  client-side since PostgREST can't `OR` a top-level column condition with an inner-embedded-
  resource condition in one request), list one conversation's messages (both reading from
  Supabase), send a reply — which calls Meta's Send Message API directly (`WHATSAPP_ACCESS_
  TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`) and records the outcome as a message row, `status='failed'`
  with Meta's own error text when it's rejected (most likely WhatsApp's 24-hour customer-service-
  window rule, since no approved message templates exist yet) rather than a generic failure — and
  block/unblock a number (added 2026-09-07), which calls Meta's native Cloud API `block_users`
  endpoint (`POST`/`DELETE .../{phone-number-id}/block_users`) directly, then mirrors the outcome
  into `whatsapp_conversations.is_blocked`/`blocked_at` purely so the admin UI can show a "Blocked"
  badge without a live Graph API round-trip on every poll — Meta's own block state is the source
  of truth, not this column. Once blocked, Meta silently drops future inbound messages from that
  number before they ever reach `whatsapp-webhook.mts`; no notification to the sender either way.
- **`netlify/functions/whatsapp-stale-alert.mts`** — scheduled function (Netlify cron,
  `config.schedule = "*/15 * * * *"`, no HTTP path). The "make sure it actually gets answered"
  safety net: queries `scripts/lib/supabase.mjs`'s `listStaleUnreadConversations` for
  conversations unread 60+ minutes and, if any exist, emails `core-team@tvc.farm` one digest
  listing all of them (contact, last-message preview, wait time) — never one email per
  conversation. Deliberately a recurring hourly nag rather than a one-shot alert: a conversation
  is re-included in the digest every hour for as long as it stays unread (tracked via
  `whatsapp_conversations.last_stale_alert_at`, reset to null on every new inbound message so
  each message gets its own full 60-minute countdown), so a single missed email can't let a
  message silently go unanswered.
- **WhatsApp guest panel** — `whatsapp-admin.mts`'s `GET /api/whatsapp-admin/guest` calls
  `lib/guest-context.ts`, which matches the conversation's number (normalized E.164) to the guest's
  online bookings (`event_payments`, via `scripts/lib/event-payments-db.mjs`, plus per-booking WhatsApp
  delivery from `whatsapp_template_sends`) and stays (`accommodation_people` / `accommodation_guests`,
  via `scripts/lib/accommodation-db.mjs`). Each section is gated by the viewer's role in its own module
  (`requireStaff` for `event-payments` and `accommodation`), and no contact detail is returned. The
  conversation list also carries `needsReply` (`lib/whatsapp-guest.ts`), from the last messages
  fetched by `listRecentMessagesByConversation`.
- **`netlify/functions/whatsapp-suggest.mts`** — the inbox's "Suggest reply" (POST
  `/api/whatsapp-suggest`, `reply` capability of the `whatsapp` module). Reads the last messages of a
  conversation from Supabase, retrieves the relevant site pages (`lib/site-retrieval.ts`) and asks Claude
  (`callAnthropic`, `claude-sonnet-5`) or, if `WHATSAPP_SUGGEST_PROVIDER=gemini`, Gemini first with Claude
  as the fallback, for a JSON draft (`lib/whatsapp-suggest.ts`: prompt, transcript with no names or
  numbers, parsing, removal of non-tvc.farm links). Returns the draft, a needs-staff flag with a reason and
  the pages used; never sends. Per-staff and daily rate limits in Netlify Blobs; usage counted in
  `usage_daily`.
- **WhatsApp inbound media** — `whatsapp-webhook.mts` records a message's media id/kind/mime/
  filename (`lib/whatsapp-media.ts`, migration `0037`); `whatsapp-admin.mts`'s `GET
  /api/whatsapp-admin/media` (`view`) fetches the file from Meta's Graph API on demand (media id
  looked up server-side, token never leaves the function), capped at 5.5 MB and served inline only
  for a short allowlist of image/audio/video types. Files are not stored by us.
- **WhatsApp inbox controls** — `whatsapp-admin.mts` also serves `/api/whatsapp-admin/opt-out`
  (`manage`: add/remove the contact on `whatsapp_opt_outs`, audit-logged first) and
  `/api/whatsapp-admin/seen` (`reply`: marks the guest's latest message read and optionally shows
  the typing indicator, one Cloud API call). The conversation list now carries each contact's
  opt-out state. Canned replies live in `src/data/whatsapp-quick-replies.ts`.
- **WhatsApp account-health alerts** — `whatsapp-webhook.mts` passes Meta's non-message webhook
  fields (template status/quality/category, phone-number quality, account updates and alerts)
  through `lib/whatsapp-health.ts`, stores each in `whatsapp_health_events` (migration `0036`,
  deduped by a delivery hash) and emails core-team via `sendStaffAlert`. `usage-admin.mts` serves
  the latest events at `/api/usage-admin/whatsapp-health` for a panel on `/internal/usage`.
- **WhatsApp STOP opt-out** — `whatsapp-webhook.mts` treats an exact STOP/START text
  (`lib/whatsapp-optout.ts`) as a command: it writes/deletes the sender's E.164 number in
  `whatsapp_opt_outs` (migration `0035`) and replies with a confirmation. `lib/whatsapp-send.ts`
  checks that table before every template send and fails closed if it can't be read.
- **WhatsApp message reads (Jev, shadow mode)** — with `TYPESAFE_WHATSAPP_SHADOW=true` (off by
  default; needs `TYPESAFE_API_KEY`), `whatsapp-webhook.mts` sends each inbound text/button message to
  TypeSafe's Jev model (`scripts/lib/whatsapp-assess.mjs`: four questions — intent, language, urgency,
  needs-reply — over the last few messages, labelled Guest/TVC with no names or numbers) and stores
  the answers in `whatsapp_message_assessments` (migration `0057`, one row per message, no message
  text; reply time is derived by joining the next outbound message). It runs after persistence, the
  opt-out reply and the auto-reply, never throws and times out at 3s, so a TypeSafe outage cannot
  delay or fail a delivery. **Nothing reads the table yet**: no inbox, filter, alert or guest reply
  depends on it. The model is pinned (`jev-1.14.0`, override `TYPESAFE_MODEL`), not the `jev-latest`
  alias. Calls are metered as the `typesafe` service on `/internal/usage` (see `USAGE.md`).
- **WhatsApp consent** — `EventBookingForm.astro` has an optional "send updates on WhatsApp"
  checkbox; `event-booking.mts` puts the answer in the Payment Link's `notes.whatsappOptIn`,
  `razorpay-webhook.mts` stores it as `event_payments.whatsapp_opt_in` (migration `0034`), and
  `lib/whatsapp-send.ts` skips any guest message when it is `false`. See `docs/whatsapp-templates.md`.
- **`netlify/functions/whatsapp-event-reminders.mts`** — scheduled function (Netlify cron,
  `config.schedule = "30 3 * * *"`, i.e. 09:00 IST, no HTTP path). Sends the `tvc_event_reminder`
  WhatsApp template to every `event_payments` booking whose `event_date` is tomorrow (IST) and that
  isn't refunded or mid-refund. Each booking is claimed via `whatsapp_reminder_sent_at` (migration
  `0033`) before sending and released if the send fails or the template isn't approved yet. The
  booking-confirmation template (`tvc_booking_confirmed`) is sent from `razorpay-webhook.mts`, and
  `whatsapp-webhook.mts` additionally stores Click-to-WhatsApp `referral` data on the conversation
  and, when `WHATSAPP_AUTOACK_ENABLED=true`, sends a rate-limited out-of-hours auto-reply
  (`lib/whatsapp-autoack.ts`). See `docs/whatsapp-templates.md`.
- **`netlify/functions/accommodation-admin.mts`** — backs `/internal/accommodation-calendar`.
  Same Google Sign-In auth pattern as `photo-pool.mts`/`whatsapp-admin.mts`: `requireStaff`
  checks the caller's role in the `accommodation` module — `view` to read, `edit` to write and to
  search the guest directory. Migrated 2026-10 from its own dedicated "Accommodation Calendar -
  Allowed Emails" Sheet (split out 2026-08-30 so calendar access isn't a side effect of
  photo/WhatsApp access); the old roles map onto the shared ones: `admin` -> `admin`,
  `restricted` -> `user` with `scope.allowedTypes` (write only a listed subset of booking types,
  e.g. a Linger contact scoped to `casual-stay`/`public-event`), `viewer` -> `read_only`. Every
  role sees the full grid; only writes are type-scoped, and `canWriteType()` enforces that
  server-side in `accommodation-admin.mts` against both a booking's existing type and its new
  type on update/delete — never left to the client form to hide options for. The page still
  reasons in the old three roles, so the server translates (`pageAccess`). **Guest mobile and
  email are write-only**: they never leave the Function (responses carry `hasMobile`/`hasEmail`
  and a short `ref` tag to tell same-named guests apart in the typeahead); the page shows "On file
  (hidden)" with a Replace button, and a save that omits them keeps the stored values because
  `accommodation_resolve_person` coalesces missing values. Guest names and preferences/allergies
  are withheld/masked for `read_only`, and `created_by`/`updated_by`/the booking audit log now hold
  the admin id, not an email. Full booking CRUD plus guest search/history,
  all against the `accommodation_*` tables in the "TVC ERP" Supabase project via
  `scripts/lib/accommodation-db.mjs`. The core guarantee this whole feature was built around:
  double-booking a tent is *physically impossible*, not just checked for in application code — an
  `EXCLUDE USING gist` constraint on `accommodation_tent_assignments` makes an overlapping insert
  fail at the database level even under concurrent requests (replacing an earlier Netlify Blobs
  design that let two identical bookings land 38 seconds apart under Blobs' eventual consistency).
  A second `EXCLUDE` constraint does the same for a single guest being double-booked into two
  different tents on an overlapping night. Guest identity (`accommodation_people`) resolves by
  mobile number + name together, not by number alone, so two people sharing a phone number (a
  couple, for instance) don't silently overwrite each other; a full audit log
  (`accommodation_booking_audit_log`, populated by table triggers, not application code, so no
  write path can bypass it) records every create/update/delete, and editing or deleting a booking
  whose stay has already happened requires and records a reason.
  **Stay notifications (2026-10-12, member stays only).** An admin-triggered "Finalize & notify"
  button on a member-stay booking card calls `POST /api/accommodation-admin/bookings/notify`,
  which messages each guest on WhatsApp (if a mobile is on file) and email (if an email is on
  file) via `lib/stay-notify.ts` (templates `tvc_stay_confirmed`/`_updated`/`_cancelled`), plus a
  summary to core-team + Linger (email and `tvc_stay_staff_alert`). Nothing is sent when a booking
  is merely saved. What guests were told is stored in `accommodation_booking_notices`
  (migration `0048`); `scripts/lib/stay-notice.mjs` diffs it against the live booking so an edit
  shows "Changed since guests were told" and "Send update" messages only the guests affected, and
  deleting a notified booking offers a cancellation message (`notifyGuests` on `/bookings/delete`).
  Gated by `NOTIFIABLE_BOOKING_TYPES` in `stay-notice.mjs`. Test mode (Razorpay test keys) routes
  to the test inbox / `WHATSAPP_TEST_NUMBER`.
- **`netlify/functions/partner-api.mts`** — the partner calendar API Linger's booking system
  calls, at `/api/partner/v1/*`. **Phase 1 (read-only), built 2026-10-24, not yet deployed**;
  holds, confirmation, guest details, payment and settlement are later phases (design: the
  "Partner Calendar API: Technical Spec" doc; `PARTNER-API.md` is the working reference). Two
  endpoints: `GET /units` (the units and pools that partner may sell) and `GET /availability?from=&to=`
  (per night `free`/`unavailable` for each unit, and `{free, total}` per pool; windows of at most 90
  nights, starting today in India time at the earliest, within a year). Not behind Google
  Sign-In: auth is a per-partner **bearer key** (`tvcp_` + 256 random bits), stored only as a
  SHA-256 hash in `partner_api_keys` (migration `0060`), issued and revoked with
  `scripts/partner-key.mjs`, shown once. Every key failure (missing, malformed, unknown,
  revoked, expired) returns the same generic 401 and counts toward a per-IP limit (20 per 5
  minutes); a valid key is limited to 60 requests a minute, both via Netlify Blobs through
  `lib/rate-limit.ts` (fails open, like `chat.mts`). What a partner sees is exactly its grants
  in `partner_unit_access`/`partner_pool_access`; nothing is granted by default. A pool is a
  group of interchangeable units (e.g. TVC tents) reported by count, not by unit. The function
  reads booking *dates* only — it never queries a guest table — and never reveals who owns a
  unit, its `kind` (which would expose member homes) or why a night is unavailable. A farm
  closure or an exclusive booking closes every unit (closures have no tent rows, so they are
  applied explicitly). All logic is in `scripts/lib/partner-api-core.mjs` (handler, tested with
  fakes), `partner-availability.mjs` (pure window/availability rules), `partner-keys.mjs` and
  `partner-db.mjs`; the `.mts` only wires in Supabase, the limiter and the client IP.
  **Units as data (migration `0060`):** `accommodation_units` (seeded with the 14 existing ids)
  plus `accommodation_unit_pools` hold the inventory in the database. This is additive only:
  the admin calendar still uses `ACCOMMODATION_UNITS` in `scripts/lib/accommodation.mjs` and the
  hardcoded `tent_id` CHECK and farm-closure arrays in the booking RPCs. Moving those onto the
  table is deferred to phase 2; until then `scripts/lib/partner-units.test.mjs` fails if the
  seed and `ACCOMMODATION_UNITS` drift apart. `0060` was applied to TVC ERP by hand on 2026-10-24 (migrations are not applied on merge).
- **`netlify/functions/lib/staff-access.ts` + `staff-registry.ts`** — the shared access layer
  for the internal admin tools (issue #89), meant to replace the per-function Sheet allow-lists
  above. `requireStaff(req, module, capability)` verifies the Google ID token (for tvc.farm /
  syntropic.in addresses the token's `hd` claim must match, so a non-org-managed account with
  such an address is refused), then looks the person up in `staff_users` /
  `staff_module_roles` (TVC ERP Supabase project, migration `0028_staff_access.sql`, service_role
  only — RLS on with no policies) and checks that their role in that module carries the
  capability. Roles are `admin`/`user`/`read_only` per module, with an optional `scope` (the
  accommodation `restricted` role's allowed booking types); `super_admin` is a global flag that
  manages access and grants **no** implicit module access. What each role may do lives in
  `staff-registry.ts`, not the database. Every denial returns the same 403 so responses don't
  reveal who exists; lookup errors fail closed; a 30-second cache means a revoked role takes
  effect within seconds. `logStaffAction` appends to the append-only `staff_audit_log`, which
  stores admin ids, never emails. **Status:** tables, the helper, and role rows for everyone on the
  two Sheet allow-lists (9 admins, 21 grants, backfilled 2026-10-04 and applied as data, not a
  migration, so admin emails stay out of version control) exist. `photo-pool.mts` and
  `whatsapp-admin.mts`, `event-payments-admin.mts` and `accommodation-admin.mts` now all gate on
  `requireStaff` (2026-10), so the Google Sheet allow-lists are no longer read by anything (the
  Sheets and their `PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID` / `ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID`
  env vars can be retired). Access is changed on `/internal/access` (super admins only; the
  API, `staff-admin.mts`, is below) or, as before, with SQL on `staff_module_roles`. Masking helpers live in `lib/staff-masking.ts`. The first time an
  authorized person signs in with an empty `staff_users.name`, `requireStaff` copies the name
  from their Google account (guarded by `name=is.null`, so it never overwrites one on file).
- **`netlify/functions/staff-mfa.mts` + `lib/staff-mfa-crypto.ts` + `/internal/security`** —
  second factors and step-up authentication for **super admins** (issue #89), built ahead of the
  Access module that will consume them (nothing requires a step-up yet except replacing your own
  authenticator, regenerating recovery codes, and resetting another super admin). A super admin
  signs in with Google (first factor) and then proves a second factor to get a ten-minute,
  stateless, HMAC-signed step-up token bound to them, sent as `X-Stepup-Token`. Methods held at
  once: an authenticator app (TOTP, RFC 6238 — checked against the RFC's published vectors) and
  ten single-use recovery codes, and **passkeys** (WebAuthn: Face ID, Touch ID or a security key;
  `lib/staff-webauthn.ts` wraps `@simplewebauthn/server`). A passkey is stored as a `passkey` row in
  `staff_mfa_factors` (public key and counter in `credential`, never a private key) and is bound to
  the admin host: the relying-party id is `admin.tvc.farm` and only `https://admin.tvc.farm`
  and localhost (for trying it locally) are accepted origins, so previews, the public site and
  look-alike domains fail. User verification (biometric/PIN) is required and no attestation statement is requested.
  Each registration/sign-in challenge is a row in `staff_webauthn_challenges` (migration
  `0030_staff_webauthn_challenges.sql`) consumed by deleting it, so a response is accepted once;
  five wrong attempts share the same 15-minute lockout as codes. Adding a passkey when other methods
  exist, and removing one, need a step-up; removing is refused when it would leave a ready person
  with fewer than two methods. A first passkey also issues the recovery codes. Passkey routes live
  under `/api/staff-mfa/passkey/*`; the browser glue is `registerPasskey`/`passkeyStepUp` in
  `scripts/lib/staff-client.mjs`, shown on Security (add, name, remove, unlock) and as "Use a
  passkey" in the Access unlock strip. The Access module unlocks only with at least two different
  methods enrolled. TOTP secrets are stored AES-256-GCM encrypted and recovery codes only as an HMAC, both
  keyed from one Netlify variable, `STAFF_MFA_KEY` (32+ random bytes, base64, set by a human, never
  in the repo or the assistant's hands); if it is missing every keyed operation fails closed with
  `MFA_NOT_CONFIGURED`. **Losing or changing that key invalidates every stored authenticator and
  every recovery code at once** — there is no rotation procedure yet, so keep a copy in a password
  manager. A used code can't be replayed (a per-factor last-used time step, guarded atomically in
  the database), five wrong codes lock a person out for 15 minutes (a genuine code that was just used — a double tap or a retried slow request — is refused as `CODE_ALREADY_USED` and not counted; the pages also send one check at a time), a second super admin can reset
  someone's enrolment, and every security event goes to `staff_audit_log` as ids and method names
  only. Only an active `is_super_admin` passes `requireSuperAdmin` (which grants no module access).
  Tables: migration `0029_staff_mfa.sql`. Wrong codes answer 400, not 401, so the page can tell a
  bad code from an expired Google session. The setup page shows the authenticator QR code, drawn
  in the browser by `scripts/lib/qr-svg.mjs` using the zero-dependency `qrcode-generator` package
  (bundled at build; the secret never goes to an online QR service), with the typed key and an
  `otpauth://` link as fallbacks; the secret and QR are wiped from the page when setup finishes
  or the session ends.
- **Admin host**: the admin tools are served from **`admin.tvc.farm`**, a domain alias on the same Netlify project (proxied Cloudflare CNAME to `tvc-farm.netlify.app`), like `members.tvc.farm`. `netlify.toml` rules that match only that host show `/internal/` at `/`, serve each admin page without the `/internal` prefix (`admin.tvc.farm/usage/` is a rewrite to `/internal/usage/`; `StaffLayout.astro` shortens in-page links on that host only), pass through the assets and the admin functions (`/api/*-admin`, `staff-mfa`, `staff-me`, `staff-today`, `photo-pool`, `whatsapp-suggest`), and send everything else back to the admin home; `/internal/*` on that host, `tvc.farm`, `www.tvc.farm` and `members.tvc.farm` redirect (302) to the short form. Passkeys are bound to `admin.tvc.farm` (`relyingParty()` in `lib/staff-webauthn.ts`, plus `localhost` for dev), so they only work there; alert emails link to it. See `DOMAINS.md`.
- **Admin portal shell, tours and local demo**: `StaffLayout.astro` is titled "Admin Portal" and is laid out like the member
  portal: a white side menu with a round collapse button, a sticky translucent top bar, and the signed-in user as a pill at its
  right (initial, name, "Super admin" or "Admin") that opens a menu with the masked email, "Take the tour of this page" and
  "Sign out" (the older account block at the foot of the menu is gone). Home and every tool have a guided tour like the member
  portal's: steps and who sees which in `scripts/lib/staff-tour.mjs` (tested, including that every step's `data-tour` target
  still exists in its page), the spotlight and "What's new" card in `scripts/lib/staff-tour-ui.mjs`, global styles in
  `StaffLayout.astro`. The shell starts a page's tour on the first visit (only for someone who can see that page); a returning
  admin sees only steps added since (a "What's new" card on Home, a short tour elsewhere); the user menu replays it. What each
  account has seen, per page, is kept in that browser's `localStorage` (no database column, so a new browser repeats it). Adding a
  step to a page's list needs a `data-tour` attribute on the element it points at. Locally, `astro dev` then `/internal/?demo` (or `?demo=limited`)
  fakes the sign-in and `/api/staff-me` (`src/lib/staff-demo.ts`, called from `scripts/lib/staff-client.mjs` behind
  `import.meta.env.DEV`, so production builds drop it); `?tour` replays the tour without recording. The demo also answers
  `/api/staff-admin/people` with a made-up set of people, so the Access page can be seen locally.
- **Admin design primitives** (`StaffLayout.astro`, guarded by `scripts/lib/admin-primitives.test.mjs` and a Stylelint rule
  in `.stylelintrc.json`): the shell defines the card surface, page hint, notes, error text, page rhythm, text-style buttons,
  visually hidden labels and the button modifiers (`--primary`, `--danger`, `--danger-outline`, `--small`) once; the nine
  pages no longer carry copies, and every font size in them is a `--text-*` token with a 0.8rem floor. The admin's
  **look** follows the Apple-style concept: calm cool neutrals and the system type face, as token overrides on admin pages
  only (`html:root` block in `StaffLayout.astro`, which outranks global.css's `:root`), large 34px titles, a translucent side
  menu whose current item is filled with the accent, flat hairline cards, and a `toolbar` slot in the top bar for page
  controls. The pieces the concept introduced (search `.field`, `.segmented` control, grouped `.list` and `.row`, `.pill`,
  `.sheet`, `.toast` with `showToast()`, the red `.crit-row`) live in the shell and are reused: Home is a grouped list of
  tools; Event Payments has a pop-up event picker, segmented Live and Test, one surface for the headline figures, bookings
  as a grouped surface and "Cancel event…" as a red row under them; Security's methods, passkeys and other super admins
  are grouped lists with pills; WhatsApp's search and All / Needs reply filter, the Member register's search and filter
  pop-up, and the Accommodation calendar's Day / Week / Month toggle use the shared controls. The Usage page is a status line plus grouped lists: one row per service opens a sheet
  with the figure, facts and (for admins) an inline "Enter a new reading" form; prices and limits are a sheet behind a Settings row. The admin also has a **dark appearance** (token overrides at the foot of
  `StaffLayout.astro`, so components follow with no rules of their own): it follows the device, and the account menu's
  Appearance control (Auto, Light, Dark) pins one, remembered in `localStorage` and applied by a script in `<head>`
  before first paint. Hard-coded greys were the only blockers (the accommodation calendar's past and closed cells now mix
  `--tvc-ink` into `--tvc-white`). Details and the rules for adding to a shared rule are in Design language in `CLAUDE.md`.
- **Admin Google pictures** (`netlify/functions/lib/staff-picture.ts`, migration `0059_staff_google_picture.sql`,
  `staff_users.google_picture_url`): the pill in the top bar shows the signed-in admin's own Google picture, which
  `/api/staff-me` returns straight from their token (so it shows with no database change) and falls back to their initial.
  `staff-me` also keeps the picture on the person (best effort, refreshed or cleared on each sign-in, only a https address
  on Google's image hosts), and `GET /api/staff-admin/people` returns it for each person, so the Access page can show a face
  beside each name. Only that person and super admins on Access ever see it. Reads and writes are isolated from the sign-in
  queries and swallow errors, so an unapplied migration costs nothing but the faces. The Access People tab follows the
  concept: a search field and one segmented filter (All, Super admins, Has tools, No tools, Deactivated) above one grouped list
  of faces and names; the details beside it are a large face, masked email and badges, a grouped list with a pop-up for each
  tool's role, and a separate "Deactivate" row. The unlock strip is now a **lock in the toolbar** (the layout's `toolbar`
  slot): "Unlock editing", "Editing unlocked · N minutes" or "Set up to edit", which opens a sheet with the code field, the
  passkey button and "Lock now". Deactivating or reactivating someone happens at once with an **Undo** toast (no `confirm()`);
  role changes still save on selection.
- **`netlify/functions/staff-admin.mts` + `lib/staff-admin-guard.ts`** — the API behind the
  Access module (issue #89): who is in the system, who holds which module role, an activity feed,
  and the changes themselves. **Super admins only.** Reading (`GET /api/staff-admin/people`,
  `/activity`) needs a signed-in super admin; every change (`POST` add a person, set or remove a
  module role with an optional accommodation booking-type limit, deactivate or reactivate) goes
  through `requireAccessAdmin`, which also requires **two different second-factor methods already
  enrolled** (`MFA_NOT_READY` otherwise) and a **valid step-up token** from `/internal/security`
  (`STEP_UP_REQUIRED`). Each change is written to `staff_audit_log` *before* it is made and is
  refused if the entry can't be written (a newly added person, who must exist to be the entry's
  target, is taken straight back out). It deliberately cannot create, promote, deactivate or
  remove a super admin (that stays a manual database step, so the last one can't be removed from
  here), never deletes anyone (people are deactivated so history keeps its names), and never
  returns an email: an address is typed once to add someone and no response contains one. People
  are shown by name, or until Google fills one in by their address masked (`p••••@tvc.farm`, built
  server-side by `maskEmail`; the function reads the address only to mask it). The role/capability descriptions the screen
  shows come from `MODULE_INFO` in `staff-registry.ts`, which also now owns the booking-type list
  that `accommodation-admin.mts` validates against. The shared "which methods does this person
  have" query moved to `lib/staff-mfa-store.ts`.
- **`/internal/access`, `/internal` and `netlify/functions/staff-me.mts`** — the screens in front
  of that API. `/internal/access` (super admins only) is a **people × tools grid**: one row per
  person (by name), one column per tool, and each cell a role picker (No access / Read-only / User /
  Admin, coloured by level) that **saves as soon as it is changed** (a refused change puts the cell
  back and says why). A User in the accommodation calendar gets a "Limited to N booking types" control
  that opens the booking-type checkboxes. Row actions deactivate/reactivate; adding a person is a
  button that reveals the email form. A second tab, "What each role can do", is a read-only permission
  matrix per tool (capabilities × Read-only/User/Admin, built from the registry), and a third is the
  activity log with ids shown as names. The page starts read-only; a slim "unlock changes" strip
  takes the authenticator code (see below) and keeps the step-up for ten minutes; without two enrolled
  methods it links to `/internal/security` instead. Names are placed with `textContent`
  only, so a name that looks like HTML is displayed, never run, and an address is typed once to add
  someone and then never shown. **Code entry** (`wireCodeEntry` in `scripts/lib/staff-client.mjs`,
  used by Access and Security) is a single numeric `autocomplete="one-time-code"` field with no
  method dropdown in front of it; six digits submit automatically, and "Use a recovery code" swaps the
  same field to plain text. `/internal` is the landing page: one sign-in and a list of the tools
  you hold a role in (from `staff-me.mts`, which answers only about the caller, returns no email and
  lists a tool only because a role exists — each tool still checks its own capability), plus Access
  and Security for super admins. The landing page is **Today**: above the tools it lists what is waiting on the
  person, from `netlify/functions/staff-today.mts` (`GET /api/staff-today`, any active admin, read-only, counts and
  timings only). It checks only the tools the caller holds a role in: WhatsApp conversations needing a reply, live
  event-payment cancellation requests, member stories and family requests awaiting review, usage alerts from
  `usage_alert_state`, and (super admins) admins without two second factors. Each runs in its own try/catch, so a
  failed check is named as "couldn't check X" rather than shown as all clear. **Every internal page shares one Google sign-in per browser tab**
  through `scripts/lib/staff-client.mjs` (storage key `tvc-staff-idtoken`, imported by the photo
  pool, WhatsApp, event payments and accommodation pages as well as the new ones), so signing in
  once opens them all and "use a different account" signs out of all of them; Access and Security
  also share one step-up (`tvc-staff-stepup`). Each tool still checks its own role on the server for
  every request. **Every internal page and the member portal show the same sign-in card, `components/SignInGate.astro`**
  (logo, heading, one line of copy, the Google button, and, on internal pages, a "No access" card), so the
  wording and look are changed in one place; each page's script still drives it by id. **All seven internal pages share one app shell, `layouts/StaffLayout.astro`**: a
  collapsible left menu (Home, the four tools, and Access/Security for super admins) that sits
  flush left with the page content using the full remaining width, a slide-over menu with a top bar
  on phones, and none of the public site's header, footer or analytics (the pages stay `noindex`).
  The shell also has a keyboard layer (all in `StaffLayout.astro`, no server involvement): Command/Ctrl K opens a
  "Go to a tool" dialog that lists exactly the menu's links, so it only offers tools the person holds a role in, and
  Left/Right/Home/End move and choose inside any `role="tab"` or `role="radio"` group.
  The menu reads `/api/staff-me` (cached in `sessionStorage` key `tvc-staff-me`, refreshed on
  focus and after sign-in) and shows only tools the person holds a role in; it is navigation only,
  never authorisation. The collapsed/expanded choice is kept in `localStorage`
  (`tvc-staff-nav-collapsed`); WhatsApp and the accommodation calendar start collapsed to give
  their wide layouts room. The shell owns the page title style (one `h1` size for every tool), the only Sign-out
  control, and a compact **admin button** style (the public site's large orange `.button` becomes a
  36px dark-green control with a quiet outlined secondary, via low-specificity `main .button` rules in
  `StaffLayout.astro` so a page's own `--danger`/`--primary` modifiers still win; 44px on touch screens); admin screens use a four-step type scale (0.8 / 0.9 / 1 / 1.125 rem) and
  `--tvc-line-strong` for control borders (3:1 on white; `--tvc-line` stays for dividers). Each link is still a full page load (in-page navigation, per-tool
  sub-menus and tabs are later steps); `components/StaffNav.astro` was removed. Where each tool
  lives is `MODULE_INFO[...].path` in `staff-registry.ts`.
- **`scripts/lib/accommodation-db.mjs`** — hand-rolled Supabase PostgREST REST client (same style
  as `supabase.mjs` below, no `@supabase/supabase-js`), the sole data-access layer for
  `accommodation-admin.mts`. Conflict-checking lives entirely in Postgres (see above) — this file
  just calls the `accommodation_create_booking`/`_update_booking`/`_delete_booking` RPCs and reads
  back the result, mapping a thrown RPC error's HTTP status (`404`/`409`/`422`, via
  `RAISE EXCEPTION ... USING ERRCODE = 'PTnnn'`) straight through. The public, guest-free
  availability view this once also backed (`listBookingsForAvailability`) was removed when that
  view was dropped from this launch (2026-08-30) — a future public view is separate, undesigned
  work.
- **`netlify/functions/event-booking.mts`** — backs `EventBookingForm.astro` (rendered on any
  event whose content frontmatter sets `razorpayReferenceId` — see `content.config.ts` and
  `EventDetailView.astro`). A reusable, event-agnostic flow: each opted-in event has its own
  hand-created base Razorpay Payment Link (created via the Razorpay MCP, same as every link in
  `RAZORPAY.md`'s table) whose amount is the trusted per-person price and whose `reference_id` is
  what the event's frontmatter points at — that link is never paid directly. This function looks
  it up by `reference_id` via Razorpay's REST API, multiplies its price by the attendee count the
  visitor submitted, creates a fresh one-off Payment Link for that total (carrying
  `baseReferenceId`/`event`/`attendeeCount`/`primaryContactName` in `notes` so
  `razorpay-webhook.mts` below needs no per-event code of its own), and redirects the browser to
  it. **Live** as of 2026-09-24 — real live-mode keys, one real Payment Link creation verified
  directly against the API. A genuine bug (Razorpay's list endpoint returns `payment_links`, not
  `items` as the code originally assumed) was found and fixed via this first real test, since the
  code had only ever previously been exercised against constructed mock `Request` objects — see
  `RAZORPAY.md`. Also carries `notes.eventDate` (the event's date at booking time, from
  `EventBookingForm`'s new `eventDate` prop — see `event_date` below) and, since 2026-09-25, guards
  against duplicate payments two ways: the per-booking Payment Link's `reference_id` is now
  deterministic per (event, email) so a resubmit before paying reuses the same still-open link
  (`fetchPaymentLinksByReferenceId`) instead of minting a new one, and a `POST` for an email that
  already has a paid, live booking for this event returns `{ duplicateWarning, existingCount }`
  instead of creating a link until the caller confirms with `confirmDuplicate: true`
  (`countActivePaymentsForEmail`, `scripts/lib/event-payments-db.mjs`) — see `RAZORPAY.md`.
- **`netlify/functions/lib/razorpay.ts`** — shared Razorpay REST helpers for the functions
  below: `fetchBasePaymentLink()`, `createPaymentLink()` (hand-rolled `fetch` + Basic Auth, no
  `razorpay` npm package, matching this repo's small-hand-rolled-client-over-heavy-SDK preference —
  see `google-drive.mjs`/`supabase.mjs`), `verifyWebhookSignature()` (HMAC-SHA256 over the raw
  webhook body using `RAZORPAY_WEBHOOK_SECRET`, same shape as `whatsapp-webhook.mts`'s Meta
  signature check), and `createRefund()` (`POST /payments/:id/refund` — Razorpay's MCP server has
  fetch/list tools for refunds but no way to create one, so `event-payments-admin.mts` below goes
  straight to the REST API like everything else in this file).
- **`netlify/functions/razorpay-webhook.mts`** — Razorpay's webhook endpoint, subscribed to
  `payment_link.paid` (Razorpay dashboard, Settings → Webhooks — a separate config per Test/Live
  mode; see `RAZORPAY.md`'s setup notes). Verifies the signature, then records the payment in the
  `event_payments` table (Supabase "TVC ERP" project, via
  `scripts/lib/event-payments-db.mjs`'s ignore-duplicates insert on `razorpay_payment_id` — safe
  against Razorpay's documented at-least-once webhook delivery/retries) and emails a branded
  receipt (`netlify/functions/lib/payment-receipt.ts`, with the TVC logo mark) via Resend, CC'd to
  `core-team@tvc.farm` and `stay@linger.in`. Zero per-event code: which event and how many people
  travel entirely in the Payment Link's own `notes`, set either by hand on a base link paid
  directly, or by `event-booking.mts` above on a per-booking link. `payer_email`/`payer_contact`
  are read from those same `notes` (`primaryContactEmail`/`primaryContactPhone` — what the visitor
  actually typed into `EventBookingForm`), not from the confirmed payment's own
  `payment.entity.email`/`.contact`: Razorpay's test-mode/Quick Pay checkout was found to
  substitute its own `void@razorpay.com` placeholder for email regardless of what was prefilled,
  so trusting our own captured value is more reliable — falls back to the payment entity only for
  Payment Links paid without going through this form (no `notes` at all). Also captures
  `payment.entity.method` (`payment_method` column) and `notes.eventDate` (`event_date` column,
  null for bookings made before 2026-09-25) — but deliberately *not* `payment.entity.fee`/`.tax`,
  which Razorpay doesn't reliably populate by the time this webhook fires; those are backfilled
  separately (see `scripts/reconcile-event-payment-fees.mjs` below). **Live** as of 2026-09-24 — a
  real signature-mismatch was hit and fixed the same day (the webhook secret was updated in both
  places, but Netlify Functions only pick up an environment variable change on the *next* deploy,
  not immediately — a real, documented Netlify behavior, not a bug in this code). Also subscribed
  to `refund.created`/`refund.processed`/`refund.failed` (added to the dashboard config
  2026-09-24) — Razorpay is treated as the source of truth for whether a refund actually
  completed, not our own synchronous API response: `refund.created` records that a refund
  started (`recordRefundInitiated()` — the only place a refund issued straight from the Razorpay
  dashboard, not through `/internal/event-payments`, gets recorded at all), `refund.processed` is
  the *only* place `refunded_at` itself gets set (`confirmRefundProcessed()`), and `refund.failed`
  flips `refund_status` to `'failed'` (`markRefundFailed()`) so a row that didn't actually go
  through reads as failed rather than silently stuck. Any refund failure — Razorpay rejecting the API call
  (e.g. insufficient balance) in `event-payments-admin.mts`, or `refund.failed` here — also emails an internal
  alert via `netlify/functions/lib/refund-alert.ts` to `core-team@tvc.farm` (cc `stay@linger.in`, never the guest); a
  bulk "Cancel event" sends one summary alert listing every failed booking, and first closes the event's base
  Razorpay Payment Link so no new bookings arrive. `refund.processed` also emails the payer "Refund processed". The same `lib/refund-alert.ts` `sendStaffAlert()` (to
  `core-team@tvc.farm`, cc `stay@linger.in`) also fires on a guest cancellation request (`cancel-booking.mts`, "Action
  needed") and when a payment lands after registration closed (`razorpay-webhook.mts`). The bulk cancel writes an
  `event-payments.event_cancelled` admin audit entry. Alongside those emails, `lib/whatsapp-send.ts` can send approved
  WhatsApp templates via Meta's Send Message API (event cancelled / refund initiated / processed / request declined
  to the guest, and an admin alert from `enquiry.mts`) — dormant until each template is approved and listed in
  `WHATSAPP_APPROVED_TEMPLATES`; delivery is tracked in `whatsapp_template_sends` (migration `0032`), updated by
  `whatsapp-webhook.mts` from Meta's delivery `statuses` and shown per booking on the Event Payments dashboard; see `docs/whatsapp-templates.md` and `WHATSAPP.md`. Emails about test-mode bookings are rerouted to `contact@tvc.farm` only (`lib/email-routing.ts`). `POST /api/event-payments-admin/decline` lets an admin decline a
  guest's cancellation request (`declineCancellationRequest()`, migration `0029`): audit-logged, guest emailed, booking stays live. All three guard on `razorpay_refund_id` (and
  `refunded_at is.null` where relevant), so whichever path — our own admin action or this webhook
  — reaches Supabase first for a given step wins, and a duplicate/out-of-order delivery is a
  no-op.
- **`netlify/functions/cancel-booking.mts`** — backs `src/pages/cancel-booking.astro`, linked
  from the receipt email above. A guest-initiated **cancellation request**, not an automatic
  refund: TVC's `/refund-policy` has day-before-event tiers a human applies by hand, so this only
  records that a guest asked (`requestCancellationIfNew`, idempotent) and emails TVC + Linger +
  the guest — the same "request, human follows up" shape `BookingInquiry.astro`'s forms already
  use elsewhere on the site. A `GET ?paymentId=` returns the booking summary for the page to show
  before the guest confirms; `POST` records the request. Reusable the same way
  `razorpay-webhook.mts` is — nothing here is specific to one event.
- **`netlify/functions/event-payments-admin.mts`** — backs `/internal/event-payments`, the
  per-event registrations/cancellations/money-collected dashboard. Google Sign-In gated, then
  `requireStaff` checks the caller's role in the `event-payments` module — `view` to read,
  admin-only `refund` for both refund routes (migrated 2026-10 from the shared "core team" Sheet
  allow-list). Payer **email and phone never leave this Function**: each booking carries a
  `payerLabel` (the name, masked for `read_only` roles, or an opaque "Payer XXXX") and
  `hasEmail`/`hasPhone` flags; the duplicate-booking flag is still computed server-side from the
  email, and the refund email is sent to the stored address server-side. The admin is
  recorded by id (not email) in `refunded_by` and in the notes stored by Razorpay, and every
  refund is audit-logged **before** any money moves (refused if the log write fails).
  `GET ?eventReferenceId=` returns every booking
  for that event plus computed aggregates (gross/net collected, cancelled count, pending
  cancellation-request count). `POST` with `{ id, amount, reason? }` **triggers** a real refund:
  looks the row up, rejects it if already refunded or already has a non-failed refund in progress
  or `amount` exceeds what was paid, calls `createRefund()` (`lib/razorpay.ts`), and records only
  **initiation** on the row (`razorpay_refund_id`/`refund_amount`/`refund_status`/
  `refund_initiated_at`/`refunded_by` — `supabase/migrations/0020_event_payments_refunds.sql`/
  `0022_event_payments_refund_initiated.sql`) — `refunded_at` itself is set later, only by
  `razorpay-webhook.mts`'s `refund.processed` handler once Razorpay confirms completion. Also
  backfills `cancellation_requested_at` if the guest never went through `/cancel-booking` first,
  and emails the payer that a refund has started via Resend. The page itself pre-fills a suggested
  amount from `/refund-policy`'s day-before-event tiers (now based on the guest's actual
  cancellation-request date and the event date they paid against, not "today"/the event's current
  date — see `event_date` below) and requires a two-step confirm before this endpoint is ever
  called — nothing here re-derives or enforces that tier server-side, the admin's typed amount is
  what's sent. Since 2026-09-25 also flags a booking `isDuplicate` when another live (non-refunded)
  row shares its payer email within the same event, and exposes a second endpoint,
  `POST /api/event-payments-admin/bulk-refund` (`{ eventReferenceId, fraction, reason?,
  mode: 'live' | 'test' }`; the bookings list takes the same `mode`, so test and real bookings are never mixed) — refunds every still-eligible booking for an event at a uniform fraction in one
  call, for a full-event cancellation (weather, low turnout), sequentially against Razorpay so one
  failure doesn't take the batch down. `netCollected` now subtracts each row's known `fee_amount`
  (see `fee_amount` below) rather than just refunds, and the response includes
  `unreconciledFeeCount` for rows that haven't been fee-checked yet. Since 2026-10-01 the
  aggregates also carry the fee tally TVC absorbs: `totalFeeTax` (GST portion; MDR = `totalFees` −
  that), `feesOnRefunded`, `totalRefundFees` (subtracted from `netCollected` too), `feesByMethod`
  (per payment method: count, gross, fees, GST, plus the gross whose fee is known so the effective
  rate isn't diluted by unreconciled rows), and `settledNet`/`settlementCount`/`unsettledCount`
  from the settlement columns. A shared `refundOneBooking()`
  backs both the single-row and bulk paths; on a Razorpay rejection it surfaces Razorpay's own
  `error.description` (parsed in `lib/razorpay.ts`'s `createRefund()`) instead of a generic message
  — found live that refunding a pre-settlement payment can fail with "account does not have enough
  balance," which previously only reached server logs, never the admin clicking the button.
- **`scripts/lib/event-payments-db.mjs`** — hand-rolled Supabase PostgREST REST client (same
  style as `supabase.mjs`/`accommodation-db.mjs`) for the `event_payments` table
  (`supabase/migrations/0018_event_payments.sql` through `0027_event_payments_fee_tax_settlement.sql`).
  `recordPaymentIfNew()` (ignore-duplicates insert, keyed on a unique index over
  `razorpay_payment_id`), `getPaymentByRazorpayId()`, and `requestCancellationIfNew()`
  (cancel-only-if-not-already-requested update) are used by `razorpay-webhook.mts` and
  `cancel-booking.mts` above; `listPaymentsForEvent()`, `getPaymentById()`,
  `recordRefundInitiated()` (guarded on no initiation yet, or the last one having failed —
  used by both `event-payments-admin.mts` and `razorpay-webhook.mts`'s `refund.created`
  handler), `confirmRefundProcessed()` (the only function that sets `refunded_at`, guarded on the
  specific `razorpay_refund_id` and not already confirmed), and `markRefundFailed()` (guarded the
  same way) are used by `event-payments-admin.mts` and `razorpay-webhook.mts` above. Since
  2026-09-25 also `countActivePaymentsForEmail()` (`event-booking.mts`'s duplicate guard),
  `listUnreconciledPayments()`/`recordFeeReconciled()` (`scripts/reconcile-event-payment-fees.mjs`
  below), and since 2026-10-01 `listUnsettledPayments()`/`recordSettlement()` (its settlement pass).
- **`scripts/reconcile-event-payment-fees.mjs`** — standalone script (not a Netlify Function),
  added 2026-09-25, two passes over live rows. **Fees:** polls Razorpay's `GET /payments/:id` for
  every row paid more than 6 hours ago with no `fee_reconciled_at` yet, and records Razorpay's
  `fee` (which already includes GST) as `fee_amount` and `tax` as `fee_tax` once Razorpay has
  computed them (before 2026-10-01 it stored `fee + tax`, double-counting GST — migration `0027`
  re-queued existing rows). **Settlements** (2026-10-01): reads Razorpay's Settlement
  Reconciliation report (`GET /settlements/recon/combined`, per month since the oldest unsettled
  row) and records which settlement each payment and processed refund landed in, plus each
  refund's own fee. Runs nightly via `.github/workflows/reconcile-event-payment-fees.yml`, cron
  `0 22 * * *` (~03:30 IST), live with repo secrets since 2026-09-26. Can't run locally via
  `netlify dev:exec`: Netlify masks the Sensitive-flagged service-role key on read. Trigger it
  with `gh workflow run` instead. See `RAZORPAY.md`.
- **`scripts/lib/supabase.mjs`** — hand-rolled Supabase PostgREST REST client (`fetch` + the
  `service_role` key, no `@supabase/supabase-js` dependency — matching this repo's preference for
  small hand-rolled clients over heavy libraries) for the `whatsapp_conversations`/
  `whatsapp_messages` tables in the "TVC ERP" Supabase project (see
  `supabase/migrations/0001_whatsapp_reply_admin.sql`). Used by `whatsapp-webhook.mts` (write) and
  `whatsapp-admin.mts` (read + write). `wa_message_id` has a partial unique index; inserts use
  `Prefer: resolution=ignore-duplicates` so a re-delivered webhook (Meta documents at-least-once
  delivery with retries) is a no-op rather than a duplicate row. Its `restHeaders()` helper (the
  `service_role` auth header builder) is also exported and reused directly by
  `accommodation-db.mjs` above — same project, same auth, no reason for a second copy.
- **`scripts/lib/google-id-token.mjs`** — verifies a Google Identity Services ID token: fetches
  and caches Google's JWKS, hardcodes the expected `RS256` algorithm (defense against
  algorithm-confusion attacks), verifies the RSA signature via Node's built-in `crypto`, and
  exact-matches `iss`/`aud`/`email_verified`. The reverse direction of `google-drive.mjs`'s JWT
  *signing* — same hand-rolled, dependency-free approach.
- **`scripts/build-chat-context.mjs`** — post-build script that prepares the chat widget's
  knowledge base.
- ~~Pagefind~~ (removed 2026-09-21) — used to power a client-side keyword index for site search
  (`src/components/SiteSearch.astro`). Site search is now AI-only (submit-triggered, calls
  `netlify/functions/search-ai.mts` — see above) with no client-side keyword index, so the
  `pagefind --site dist` build step, the `pagefind` npm package, the dev-only stub in
  `astro.config.mjs`, `BaseLayout.astro`'s `data-pagefind-body` attribute, and the CSP's
  `'wasm-unsafe-eval'` allowance (only needed for Pagefind's WASM search worker) were all removed
  together.
- **`scripts/submit-indexnow.mjs`** (last step of `npm run build`, added 2026-09-17) — pushes the
  full sitemap URL list to `api.indexnow.org`, which fans the submission out to every
  participating search engine (Bing, Yandex, Seznam, Naver, ...) instead of waiting for each to
  crawl on its own schedule. Only runs when `CONTEXT=production` (Netlify's build var) - a local
  build or a deploy-preview/branch-deploy has no live URL worth notifying anyone about. Reads
  `dist/sitemap-index.xml` then each sub-sitemap it points to, rather than hardcoding a filename,
  so it keeps working if `@astrojs/sitemap` ever splits output across more than the one
  `sitemap-0.xml` file it currently produces. Ownership proof is the flat key file at
  `public/051fae095f051244a7cf06c7e1271dbf.txt` (IndexNow's protocol: the key must be servable at
  `https://<host>/<key>.txt` before a submission signed with it is accepted) - not a secret, just
  a public capability token; regenerating it (a new random hex string, a new key file, delete the
  old one) invalidates anyone else's ability to submit URLs under this key, if that's ever needed.
  A failed or non-200 submission logs a warning but never fails the build - IndexNow is a
  nice-to-have nudge, not something a deploy should block on.
- **`scripts/curate-photos.mjs`** — run locally, not part of the Netlify build. Reads a folder
  of already-selected photos, extracts EXIF/GPS, uploads a display and thumbnail size of each to
  Cloudflare R2, and writes one `src/content/photos/*.md` entry per photo — still just expects an
  "already hand-picked" local folder, wherever that folder came from (by hand, or via
  `pull-approved-photos.mjs` below). Handles HEIC/HEIF (iPhone photos): `exifr`'s EXIF extraction
  is format-agnostic and needed no changes, but `sharp`'s bundled libheif rejects most real
  iPhone photos outright (`Security limit exceeded: Number of references in iref box` — modern
  iPhones attach enough auxiliary images, thumbnail/depth map/portrait/HDR data, to trip a
  hard-coded libheif limit sharp doesn't expose a way to raise), so HEIC input is decoded to a
  JPEG buffer via `heic-convert` (a WASM libheif build with no such limit) before sharp ever sees
  it. Also picks up a curator-written caption: if a photo has a sibling `<filename>.caption.txt`
  (written by `pull-approved-photos.mjs`), its contents become the real caption instead of the
  usual filename-derived placeholder.
- **`scripts/caption-photos.mjs`** — also run locally. Backfills a draft `caption:` for any
  `photos/*.md` entry still carrying the filename-derived placeholder, by sending that photo's
  thumbnail to the Anthropic API (vision) and writing back a short literal description. Drafts
  are meant to be reviewed/rewritten by hand before publishing, not used as final copy.
- **`scripts/pull-approved-photos.mjs`** — run locally. Downloads everything a curator approved
  via `/internal/photo-pool` (Drive's "Approved" folder) into a local folder, writing a
  `<filename>.caption.txt` sidecar alongside any photo whose Drive `description` field was
  filled in during review, then moving each file to "Published" in Drive right after its own
  download succeeds. Prints a reminder to run `curate-photos.mjs` against that folder next —
  never invokes it itself.
- **`scripts/lib/google-drive.mjs`** — shared Drive REST client (auth, list, get, move, download)
  plus Sheets read (`getAllowedEmails`) and write (`appendSheetRow`), used by `photo-pool.mts`,
  `pull-approved-photos.mjs`, and `enquiry.mts`. Plain ESM, not TypeScript, so both a bundled
  Netlify Function and a plain `node`-run script can import it directly. Also exports three
  Search Console functions, all read-only scope, used only by the two scripts below — same
  service account, no separate credentials: `inspectUrl()` (`urlInspection.index.inspect`,
  the v1 API host) and `listSitemaps()`/`querySearchAnalytics()` (`sitemaps.list`/
  `searchAnalytics.query`, the older Webmasters v3 host — Google never migrated those two to v1).
- **`.github/workflows/member-update-email.yml`** + **`scripts/send-member-update-email.mjs`** —
  the only GitHub Action in this repo that isn't purely local/report-only (contrast
  `pagespeed.yml`). Runs on every push to `main` that touches `src/data/members.ts`, diffing that
  file's previous committed version against the new one (one member per line in this file, so a
  changed line is a changed member — no TS parsing needed) to find which member cards changed,
  classifying each as "new" (its previous line had no `whyTVC` field — the one question unique to
  the "TVC Members: Your Story" form) or "updated" (it already did; same heuristic drives a
  site-wide "N of 53 members have shared their story" progress stat in the email body). Emails
  `members@tvc.farm`, BCC'ing each changed member's own address (not CC — so members can't see
  each other's addresses) — looked up from the response
  Sheet by name via `getSheetValues()`, reusing `google-drive.mjs` and its existing
  `GDRIVE_SERVICE_ACCOUNT_EMAIL`/`_PRIVATE_KEY` (added as GitHub Actions secrets 2026-08-19,
  alongside the local `.env`/Netlify env vars that already had them) — through the **Resend**
  API (`RESEND_API_KEY` secret, `noreply@tvc.farm`, domain verified via DKIM/SPF/DMARC records
  added to the `tvc.farm` Cloudflare zone the same day). Supports a manual `workflow_dispatch`
  with `compare_ref`/`test_recipient` inputs so a real send can be tested against one inbox
  (skips the member BCCs) without emailing actual members.
- **`scripts/check-search-console.mjs`** — run locally. Looks up Google's own crawl/index status
  (`coverageState` — e.g. "Not found (404)", "Submitted and indexed" — and `lastCrawlTime`) for
  one or more URLs, to confirm whether a `netlify.toml` redirect fix has actually been recrawled
  yet rather than eyeballing the Search Console UI by hand.
- **`scripts/check-search-performance.mjs`** — run locally, `node scripts/check-search-performance.mjs
  [days]` (default 28). Reports sitemap submission/crawl status (warnings, errors, submitted vs
  indexed counts — the last of those is a known-unreliable field on the legacy endpoint, printed
  with a caveat) plus real search performance: site-wide totals and top pages/queries by clicks.
  Needs Full user, not just Restricted — see the service-account note below.


The service account was added as a Restricted user on the `tvc.farm` Search Console property
(2026-08-07), then upgraded to Full user (2026-08-08) — Restricted users can only use URL
Inspection via the API; Full also unlocks `sitemaps.list` and `searchAnalytics.query`, which
`check-search-performance.mjs` above uses.

### 1a. Localization (Kannada / Tamil)

The site is being localized into Kannada (`kn`) and Tamil (`ta`) alongside the existing English
content, using Astro's built-in i18n routing (`astro.config.mjs`'s `i18n` block: `defaultLocale:
'en'`, `locales: ['en', 'kn', 'ta']`, `routing.prefixDefaultLocale: false`). English keeps its
existing unprefixed URLs (`/about`); Kannada and Tamil live under `/kn/...` and `/ta/...`, with a
parallel `src/pages/kn/` and `src/pages/ta/` tree mirroring `src/pages/`. This is a build-time,
static-generation concern only — it doesn't add a hosting dependency or change the diagram above,
just multiplies the number of prerendered pages.

- **`src/i18n/{en,kn,ta}.ts`** — flat translation dictionaries (nav/footer/forms/cookie-banner/
  search/chat-widget/weather-widget strings, shared across many pages) plus **`src/i18n/utils.ts`**,
  which exports `useTranslations(lang)` (a `t(key, params?)` dot-path lookup with `{token}`
  interpolation, falling back to the English entry if a kn/ta key is missing), `SUPPORTED_LOCALES`,
  `DEFAULT_LOCALE`, and `stripLocalePrefix()`. Page-specific prose (the bulk of the actual
  translated copy) lives inline in each page's own view component instead, as a `content = { en,
  kn, ta }` object — see `src/components/views/AboutView.astro` for the canonical pattern.
- **`src/components/views/*View.astro`** — one per page, taking a `lang` prop; the actual
  `src/pages/**/*.astro` files (English at the bare path, plus `kn/`/`ta/` mirrors) are thin
  wrappers rendering the matching view with `lang="en"`/`"kn"`/`"ta"`.
- **`src/i18n/reviewStatus.ts`** — every kn/ta string is an initial AI-drafted pass, not
  final/reviewed copy. `TranslationNotice.astro` (rendered from `BaseLayout` whenever
  `lang !== 'en'` and that locale's `reviewStatus` flag is still `false`) shows a small banner
  saying so; flipping a locale's flag to `true` once a native speaker has reviewed everything
  removes the banner site-wide with no other code changes. See `TRANSLATIONS_REVIEW.md` for the
  reviewer's checklist.
- **`BaseLayout.astro`** sets `<html lang>`, emits `hreflang` alternate `<link>` tags (`en`/`kn`/
  `ta`/`x-default`) for every page that exists in all three locales, and accepts a `translated`
  prop (default `true`) for the handful of pages that deliberately stay English-only — `/privacy`,
  `/terms`, `/refund-policy`, and `/404` (legal boilerplate and an error page; skipped by explicit
  product decision, not an oversight) — which suppresses those alternates and points the language
  switcher at that locale's homepage instead of a nonexistent translated URL.
- **`LanguageSwitcher.astro`** (in `Nav.astro`) — a `<select>` of the 3 locales using
  `getRelativeLocaleUrl()` against the current locale-stripped path, so switching languages lands
  on the equivalent page rather than bouncing to the homepage.
- **Content collections** — `events` and `community-outreach` (which have a full markdown body)
  get sibling locale files, e.g. `src/content/events/kn/<slug>.md`, matching the English entry's
  slug so the URL stays identical across locales; `photos` and `partners` (short frontmatter
  fields only, no body) instead get optional `caption_kn`/`caption_ta` and
  `title_kn`/`excerpt_kn`/`title_ta`/`excerpt_ta` fields added directly to the existing files,
  falling back to the English field when a translation isn't filled in yet.
- **ChatWidget** — the widget sends the visitor's current `lang` alongside each message;
  `chat.mts`'s system prompt instructs Claude to reply in that language while still grounding
  itself in the (English-only) retrieved page content — no need to translate the corpus itself.

### 2. Build

On every push to `main`, Netlify runs:

1. `astro build` — prerenders every route to static HTML into `dist/`.
2. `build-chat-context.mjs` — strips repeated Nav/Footer markup out of the built HTML and
   writes the remaining page text into a single JSON corpus (`site-content.json`, regenerated
   every build, gitignored) — used by both the chat widget and `search-ai.mts`'s retrieval.

`netlify.toml` declares the build command, publish directory (`dist`), and functions directory
(`netlify/functions`).

### 3. Hosting — Netlify (live)

The Netlify project is owned by the `contact@tvc.farm` account (moved there from a personal
account on 2026-07-18). **Deploys auto-trigger from GitHub pushes to `main`** — confirmed
2026-09-22 in the Deploys tab ("Auto publishing is on. Deploys from `main` are published
automatically") and by watching a live merge and a follow-up commit each build within the same
minute they were pushed. (An earlier version of this doc claimed deploys were manual, based on a
real 2026-09-20 observation — that's no longer accurate, cause unconfirmed. If deploy behavior
matters for something you're about to do, re-verify against the live Deploys tab rather than
trusting this note, since it's already flipped once.)

- **Static CDN** — serves every prerendered page directly; the large majority of the site
  needs nothing more than this. Confirmed live via response headers
  (`cache-status: "Netlify Edge"`, `x-nf-request-id`).
- **`syntropic.in` / `www.syntropic.in`** — an old member-directory domain, added as a domain
  alias on this same Netlify project (2026-07-26) so its DNS zone (also managed on Netlify DNS)
  and SSL certificate resolve. `netlify.toml` force-redirects both hostnames to `tvc.farm` with
  a 301 rather than letting the alias silently mirror the site under a second hostname.
- **Netlify Functions** — five. `chat.mts` is deployed and live at `/api/chat`; the
  `ANTHROPIC_API_KEY` environment variable was set in the Netlify dashboard on 2026-07-18,
  verified directly against production (`POST https://tvc.farm/api/chat`) returning real,
  grounded answers sourced from the site's own content. `event-interest.mts` is deployed and
  live — serves `/api/event-interest`, reading/writing Netlify Blobs to back the "Want this to
  happen again?" widget on past event pages, no environment variable needed. `photo-pool.mts`
  serves `/api/photo-pool` (+`/api/photo-pool/thumb`, +`/api/photo-pool/description`) — see
  [Internal tools](#5-internal-tools) below. `GDRIVE_SERVICE_ACCOUNT_EMAIL`,
  `GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GDRIVE_INBOX_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`,
  `GDRIVE_REJECTED_FOLDER_ID`, and `PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID` (the curator allow-list
  Sheet's id) are all set as Netlify environment variables across every deploy context, including
  production. `PUBLIC_GOOGLE_CLIENT_ID` (the OAuth Client ID for Google Sign-In — not secret, it's
  embedded in the dashboard's client-side JS either way) is also set, but scoped to the
  **Builds** context specifically, since it needs to be present at `astro build` time or the
  compiled page permanently embeds an empty string until the next rebuild.
  `GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY` needed a separate "Local development (Netlify CLI)" value
  too, since Netlify withholds secret-scoped variables from `netlify dev`/CLI otherwise; likewise
  `PUBLIC_GOOGLE_CLIENT_ID` needs to be in the local `.env` file directly, since Netlify's env
  injection only covers `netlify dev`'s own process, not the separately-running plain `astro dev`
  server this project's `[dev]` config proxies to. Verified end-to-end via `netlify dev`,
  including a real Google Sign-In (allow-listed account → dashboard loads; removed from the
  allow-list → clean 403 "not authorized" with a "use a different account" recovery); not yet
  independently re-verified against the live production URL. `enquiry.mts` serves `/api/enquiry` —
  **live and verified**: `MEMBERSHIP_ENQUIRY_SHEET_ID` and `GENERAL_ENQUIRY_SHEET_ID` are set,
  each pointing at a Google Sheet shared Editor-access with the same `GDRIVE_SERVICE_ACCOUNT_EMAIL`
  service account photo-pool uses (view access isn't enough here, since this path writes) — a
  direct `POST` against the live production URL for each form type appended a real row.
  `rainfall.mts` serves `/api/rainfall` — reads the community's rainfall-log Sheet
  (`RAINFALL_SHEET_ID`, shared Viewer-access only, since this path never writes) live on every
  page view for the `/ecosystem/weather` chart/table/monsoon stat. `search-ai.mts` serves
  `/api/search-ai`, backing the site search's AI answer — deployed and live, verified directly
  against production 2026-09-21, answering from the Gemini free tier. `event-booking.mts`,
  `razorpay-webhook.mts`, and `cancel-booking.mts` serve `/api/event-booking`,
  `/api/razorpay-webhook`, and `/api/cancel-booking` — **live** as of 2026-09-24.
  `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` (real `rzp_live_...` credentials, regenerated 2026-09-24
  since the account's original 2026-07-27 live key had no saved secret) and
  `RAZORPAY_WEBHOOK_SECRET` (an arbitrary shared value, entered identically on this env var and on
  the Razorpay dashboard's live-mode webhook config) are set for all deploy contexts; a real
  Payment Link creation was verified directly against the live API, and the webhook's signature
  verification was confirmed after a real gap was found and fixed (see `RAZORPAY.md`: updating an
  environment variable doesn't take effect on Netlify Functions until the *next* deploy).
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`RESEND_API_KEY` are reused as-is from the WhatsApp
  integration below — no new credentials needed for those.
- **Netlify Blobs** — live. Two stores. `event-interest` holds one JSON record per past event id
  (`{count, emails[]}`), written only by `event-interest.mts` (optimistic-concurrency writes via
  ETag `onlyIfMatch`/`onlyIfNew`, with a bounded retry loop, so two concurrent submissions can't
  overwrite each other's increment) — the site's only piece of server-side state that's publicly
  *readable*, unlike the write-only Forms below. `search-ai-rate-limit` backs `search-ai.mts`'s
  self-rate-limiting (see above): one record per client IP for the per-IP window, plus one
  date-scoped record for the global Anthropic-fallback daily cap. Both auto-provisioned per-site,
  no setup or environment variable needed. Reset a specific event's record with
  `netlify blobs:delete event-interest <event-id>` (see README.md).
- **Netlify Forms** — live. Detects each `data-netlify="true"` form at build time and captures
  submissions with no custom backend code required. Five things use it: the membership enquiry
  form (name, email, phone, message) at the bottom of `/join` and the general enquiry form (same
  fields, plus a WhatsApp link) at `/contact`, both redirecting to `/contact/thanks` on success —
  live, email notification handled by the site-wide "Email notification" rule (Site configuration
  → Forms → Form notifications) pointed at `core-team@tvc.farm` (moved from `contact@tvc.farm` on
  2026-08-19), and each also fires `/api/enquiry` (see above) to log a Sheets row; the Host an Event inquiry
  (name, org, contact details, event type, headcount, dates, message) at `/visit/host-an-event`,
  redirecting to `/visit/host-an-event/thanks` — pushed to `main` and deployed, but not
  independently re-verified against production; the Visit inquiry form
  (`src/components/BookingInquiry.astro`), one shared `visit-inquiry` Netlify Form reused on
  `/visit/camping`, `/visit/day-visit`, and `/visit/trekking-trails` with a hidden `type`
  field noting which page it came from, redirecting to `/visit/thanks` — replaces the old
  external "Book via Linger" redirect, with pricing/inclusions now published on TVC's own
  pages and a WhatsApp link offered alongside the form; pushed to `main` and deployed, with
  both email notifications (`stay@linger.in` and `core-team@tvc.farm`, the latter moved from
  `contact@tvc.farm` on 2026-08-19) set up in the
  Netlify dashboard under Site configuration → Notifications; and the
  event-interest widget's optional-email path (an AJAX POST, not a page-navigating form
  submit, only fired when a visitor gives an email) — also deployed and live. The old Friends of
  TVC signup form (name + phone, added to the WhatsApp group by hand) no longer exists — `/contact`
  now links directly to that same group's invite URL instead.

### Cloudflare (in front of Netlify)

`tvc.farm`'s DNS resolves through Cloudflare, which proxies requests to Netlify (visible via
the `server: cloudflare` header alongside Netlify's own `x-nf-request-id`). This is a DNS/CDN
layer only, not an application host — Netlify remains the origin serving the actual site and
function. `syntropic.in` (see below) does **not** go through Cloudflare at all — its DNS is
hosted directly on Netlify DNS instead. See `DOMAINS.md` for the full registrar/DNS breakdown
of both domains.

### Cloudflare R2 (curated photo storage)

Separate from the above — same Cloudflare account, different product. The `tvc-photos` R2
bucket holds the display and thumbnail JPEGs `scripts/curate-photos.mjs` uploads, served
publicly at `media.tvc.farm` (a custom domain connected directly to the bucket, so it's on
Cloudflare's edge like the rest of the site, just not proxied through Netlify). The site never
talks to R2's API — pages just embed the public `media.tvc.farm/...` URLs the curation script
already baked into each photo's content-collection entry, the same way any other static image
URL works. No Netlify environment variable is involved; the upload credentials only ever need
to exist on whichever machine runs the curation script.

`scripts/caption-photos.mjs` calls the Anthropic API directly from the same local machine (using
the same `ANTHROPIC_API_KEY` that `netlify dev` uses for local chat-widget testing) to draft
captions — this is unrelated to R2, just another offline step in the same curation workflow, and
never touches Netlify either.

### 4. Visitor's Browser

- **ChatWidget** — floating widget using the site logo; sends the visitor's question to
  `/api/chat` and gets back a real, grounded answer.
- **SiteSearch** (magnifying-glass icon in the nav, opens on click or the `/` key) — AI-only, no
  client-side keyword index (Pagefind was removed 2026-09-21). Submitting the search (Enter, a
  mobile keyboard's "Go"/"Search" action, or tapping the pill's search-icon button) calls
  `/api/search-ai` for a synthesized, grounded answer plus source-page links — see
  `search-ai.mts` above. Deliberately submit-triggered rather than firing as the visitor types,
  since every request costs a real, rate-limited LLM call. Escape or clicking outside the panel
  closes it.
- **Friends of TVC** — live. A direct invite link to the WhatsApp group (no form, no manual
  step) — replaces the old name + phone signup that TVC had to action by hand.
- **Membership enquiry form** (bottom of `/join`, below the existing "how membership works"
  content) and **general enquiry form** (`/contact`) — live and verified end-to-end (see Hosting
  above). Each is a plain HTML form (name, email,
  optional phone, message) with a spam honeypot, submitting natively via Netlify Forms and, via
  `navigator.sendBeacon`, also logging a row to that form's own Google Sheet through
  `/api/enquiry`. The general enquiry form additionally offers a `wa.me` WhatsApp link straight
  to Madhavan, alongside the form rather than instead of it; `/join`'s form instead links back to
  `/contact` for anyone reaching out for a different reason.
- **Visit inquiry** (`/visit/camping`, `/visit/day-visit`, `/visit/trekking-trails`) — pushed
  to `main` and deployed. Each page presents its own pricing/inclusions plus a shared
  `BookingInquiry.astro` block: a plain HTML form (name, email, phone, dates, headcount,
  message, plus an itinerary picker on the Day Visit page) submitting to the same
  `visit-inquiry` Netlify Form, and a `wa.me` WhatsApp link pre-filled with a page-specific
  message. Replaces the previous external redirect to Linger's own booking pages.
- **BiodiversityExplorer** — fetches live biodiversity sightings directly from iNaturalist's
  public API on every page load; no TVC backend involved.
- **PhotoGallery** (`/in-pictures`) — date/camera filter chips and a Grid/Map view toggle over
  the `photos` content collection (server-rendered, no fetch involved); photo files themselves
  load directly from `media.tvc.farm` (R2). The Map view and the lightbox's per-photo mini map
  both use the same Leaflet + OpenStreetMap tiles as the biodiversity map.
- **The Design page's layout map** (`/about/design`) — same Leaflet + OpenStreetMap tiles,
  rendering the property boundary plus ~63 named structures/plots/zones from
  `src/data/tvc-layout.ts` (a static snapshot exported from the community's working Google My
  Maps, not a live fetch). Replaced a directly embedded Google My Maps iframe.
- **Our Journey timeline and other pages** — the era-based year-by-year story, event listings,
  and the rest of the site are pure static content with no external calls.
- A few pages also embed third-party content directly: Google Maps (directions on
  Contact/How to Reach/Visit) and YouTube (aerial drone flyover).
- **Google Analytics (GA4)** — loaded from `BaseLayout.astro`, so the loader is on every page
  site-wide; not tied to any one component. Measurement ID `G-795FTPB47P`. Skips loading
  entirely when `location.hostname` is `localhost`/`127.0.0.1`, so local dev browsing never
  pollutes production traffic data. Consent-gated: the loader only exposes
  `window.tvcAnalytics.load()`/`.revoke()` and does nothing on its own — `CookieConsent.astro`
  (rendered site-wide from `BaseLayout`) shows a banner on first visit and only calls `.load()`
  after the visitor accepts, storing the choice in `localStorage` (`tvc-cookie-consent`) so it
  isn't asked again. Rejecting, or later withdrawing via the footer's "Cookie preferences"
  link, calls `.revoke()`, which sets gtag's own `ga-disable-<id>` flag — the standard kill
  switch, needed because a script already injected earlier in the session can't be
  un-injected. `/privacy` documents what's collected and links back to this same control.
  **CSP note (fixed 2026-09-17, actually fixed 2026-09-19):** `scripts/generate-csp.mjs`'s
  `connect-src` had allowlisted `www.google-analytics.com` since the CSP was first enforced
  (2026-08-21) - a Universal Analytics-era domain gtag.js's GA4 client doesn't actually send hits
  to. The real runtime collect endpoint is `analytics.google.com`, with a fallback to
  `stats.g.doubleclick.net` - neither was allowlisted, so every real visitor's hit was silently
  CSP-blocked for close to a month (script loaded, `gtag('config', ...)` fired, dataLayer looked
  correct - nothing ever actually reached Google, confirmed via GA4's Realtime report showing 0
  users even from a real visit during the same debugging session). The 2026-09-17 fix wildcarded
  the domains as `*.google-analytics.com`, `*.analytics.google.com`, `*.g.doubleclick.net` -
  but a CSP wildcard (`*.example.com`) only matches subdomains, never the bare apex domain, and
  the real hit lands on the bare `analytics.google.com` with no subdomain. So the "fix" kept
  silently dropping every hit for two more days, confirmed 2026-09-19 by triggering a real
  `securitypolicyviolation` DOM event against production. `connect-src` now lists the bare
  `google-analytics.com`, `analytics.google.com`, and `g.doubleclick.net` explicitly alongside
  their wildcards, rather than assuming a wildcard covers the apex.
- **Microsoft Clarity** — loaded from the same `BaseLayout.astro` script block as GA, behind the
  same `window.tvcAnalytics.load()`/`.revoke()` interface and the same consent banner/localStorage
  gate. Project id `xttq21yf39` — the project Bing Webmaster Tools' own "Microsoft Clarity"
  integration tab had already auto-provisioned for this verified property, reused rather than
  creating a second, unlinked one. `.load()` injects Clarity's tag script and calls its
  `clarity('consent')` client API (Clarity's documented mechanism for going from not-tracking to
  tracking - there's no GA-style disable flag, so `.revoke()` can only prevent a *future* load,
  not stop an already-running session within the same page view). The tag script itself fans out
  to more `clarity.ms` subdomains at runtime - `scripts.clarity.ms` for the real bundle, plus a
  data-collection endpoint that isn't fixed (observed as `o.`, `l.`, and `a.clarity.ms` across
  three separate loads of the same code, evidently load-balanced) - which is why
  `scripts/generate-csp.mjs` wildcards `*.clarity.ms` in `script-src`/`connect-src` rather than
  enumerating subdomains one at a time. `/privacy` and the cookie banner (all 3 locales) name it
  alongside GA, since it collects materially different data (session recordings/heatmaps, not
  aggregate pageviews).
  - **Dashboard sign-in issue (2026-09-19), resolved 2026-09-21.** For two days, the project id
    `xttq21yf39`'s dashboard at `clarity.microsoft.com` couldn't be reached with the
    `contact@tvc.farm` account (the tag itself fired fine throughout - data collection was never
    affected). Reproduced at the time with browser automation: both "Sign in to Google" (silent
    `prompt=none` approval, valid code, `hd=tvc.farm` confirmed - Google's side worked) and "Sign
    in to Microsoft" (a real password reset completed successfully) landed back on Clarity's own
    "Welcome back" sign-in wall instead of the dashboard, with no console error either time.
    Escalated to Microsoft support - ticket `UCM000007493055`, filed 2026-09-19. `contact@tvc.farm`
    confirmed sign-in now works (2026-09-21) - whether it was Microsoft's fix or one of the
    untried workarounds (clearing `clarity.microsoft.com` cookies via Chrome's own settings UI, an
    incognito window, a different browser) isn't confirmed either way.
- **WeatherWidget** (`/ecosystem/geography`) — fetches current temperature/humidity/conditions
  for the farm's coordinates from Open-Meteo (free, no API key) on page load, cached in
  `localStorage` for 15 minutes. Hides itself if the fetch fails rather than showing broken UI.
- **Rainfall chart/table/monsoon stat** (`/ecosystem/weather`) — fetches `/api/rainfall`
  client-side on page load (`src/utils/rainfall.ts`, cached in `localStorage` for an hour, same
  shape as `weather.ts`'s cache), then builds a smooth multi-year SVG line chart (one line per
  calendar year with real data, Jan-Dec x-axis, a validated colorblind-safe categorical palette
  assigned by chronological order so a year keeps its color as new ones arrive), a legend that
  doubles as a year filter (checkboxes toggle a `year-hidden` class on that year's pre-built
  chart/table elements rather than re-rendering, so colors and the y-axis scale stay fixed), a
  hover/keyboard-focus crosshair + tooltip, the full monthly table, and the "this monsoon so far"
  stat — entirely in JS from the response. A short context sentence below the stat tiles (only
  shown for years with a verified external source in a small hardcoded `ENSO_CONTEXT` map, e.g.
  citing reporting on the 2026 El Niño monsoon outlook) recomputes from the same live numbers,
  so it updates whenever new rows are logged in the Sheet. Falls back to a short "data isn't
  available" message rather than a broken chart if the fetch fails.

### 5. Internal tools

- **Photo Pool dashboard** (`/internal/photo-pool`) — admin-only, not part of the public site:
  unlinked from nav, `noindex`, excluded from the sitemap. A curator signs in with their own
  Google account (Google Identity Services, an explicit "Sign in with Google" button, not the
  silent One Tap prompt) to see photos sitting in a shared Google Drive "Inbox" folder — anyone
  with edit access to that folder (staff, partners, volunteers) can drop photos in without
  needing any of this tooling themselves. The resulting ID token is stored in `sessionStorage`
  and sent as `Authorization: Bearer <token>` on every call; the server verifies it itself
  (`google-id-token.mjs`) and checks the verified email against a live allow-list — a one-column
  Google Sheet, not a static env var, so adding or removing a curator is a one-line edit, no
  redeploy. A non-allow-listed (but validly signed-in) account gets a clear "this Google account
  isn't authorized to review photos" message with a "use a different account" recovery, without
  being signed out — an expired/invalid token instead re-shows the sign-in button. Each card
  shows who uploaded it, the EXIF/GPS Drive already extracted on upload (camera, aperture,
  shutter speed, ISO, focal length, a Google Maps link for GPS), and an editable description with
  its own "Save" button, independent of the approve/reject decision — saving writes straight to
  the file's Drive `description` field. Approve/Reject buttons call `/api/photo-pool`, which moves
  the Drive file to "Approved" or "Rejected" — Drive's own folder location is the entire state
  machine, so a staffer dragging a file between folders directly in Drive's UI works exactly the
  same as clicking a button here. Real per-curator auth (rather than the shared secret this
  replaced) means an approve/reject/description-edit is attributed to an actual signed-in person,
  not "whoever had the password" — though a decision still never publishes anything to the live
  site on its own: a human still has to run `scripts/pull-approved-photos.mjs` then
  `scripts/curate-photos.mjs` and `git push` afterward. A curator's saved description becomes the
  photo's actual caption once published — see `pull-approved-photos.mjs` and `curate-photos.mjs`
  above. **Live**: Google Cloud service account, the four-folder Drive tree (Inbox/Approved/
  Rejected/Published, `tvc-photo-pool@tvc-farm.iam.gserviceaccount.com` as Editor), an OAuth 2.0
  Client ID (Web application, published to Production — no verification needed since it only
  requests non-sensitive `openid`/`email`/`profile` scopes), the curator allow-list Sheet (shared
  view-only with the same service account, Sheets API enabled on the project), and all Netlify
  env vars are set up; verified end-to-end via `netlify dev`, including a real Google Sign-In with
  an allow-listed account (dashboard loads, list/thumbnail/approve/reject/description all
  functional) and the same account removed from the allow-list (clean 403 with working recovery).
  **CSP note (fixed 2026-09-24):** each card fetches its Drive thumbnail through the authenticated
  Netlify Function (Drive's `thumbnailLink` can't be hit directly from the browser without
  re-attaching credentials) and renders it via `URL.createObjectURL(blob)` — a `blob:` URL.
  `scripts/generate-csp.mjs`'s `img-src` never allowlisted `blob:` (only `'self' data:` plus the
  public-site image hosts), so every thumbnail on this page silently failed to decode under the
  enforcing CSP shipped 2026-08-21 — reported as "can't see the images," reproduced live (thumb
  fetch returns a valid JPEG; a browser-native `<img blob:...>` load, even of a locally-generated
  synthetic blob, fails; the same bytes decode fine as a `data:` URL or with no CSP present).
  `img-src` now includes `blob:`.
  **CSP note (fixed 2026-10-21):** the member register's household cards (`/internal/members`)
  load each member's Google profile picture (`member_people.google_picture_url`, hosts
  `*.googleusercontent.com` / `*.ggpht.com`), but `img-src` didn't allowlist them, so the browser
  blocked every picture and the cards' `error` fallback silently showed initials. `img-src` now
  includes both hosts.
- **WhatsApp dashboard** (`/internal/whatsapp`, 2026-08-20) — admin-only, same shape as Photo Pool
  above: unlinked, `noindex`, Google Sign-In gated, reusing the exact same curator allow-list
  Sheet. Shows every conversation persisted by `whatsapp-webhook.mts` in the "TVC ERP" Supabase
  project, oldest-inbound-message-first within a thread; sending a reply calls Meta's Send Message
  API directly and shows the result inline — a failed send (most likely the 24-hour
  customer-service-window rule, since no approved templates exist yet) is shown as a red bubble
  with WhatsApp's own error text, not silently dropped. Polls every 15 seconds while the tab is
  visible; no real-time/WebSockets, no read receipts, no message pagination beyond the newest
  200 per thread / 50 conversations — deliberately a small internal tool, not a CRM. **Built,
  awaiting `SUPABASE_SERVICE_ROLE_KEY`**: `SUPABASE_URL` and `WHATSAPP_PHONE_NUMBER_ID` are set on
  Netlify (all deploy contexts); the Supabase service-role key still needs pasting into Netlify's
  UI by hand (same secret-handling rule as `WHATSAPP_ACCESS_TOKEN`) before this can go live.
- **Accommodation Allocation** (`/internal/accommodation-calendar`) — admin-only (Madhavan, the
  farm manager, plus role-scoped external contacts like Linger), same shape as Photo Pool/WhatsApp
  above: unlinked, `noindex`, Google Sign-In gated. Briefly reused
  `PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID`'s own Sheet at launch, then split into its own dedicated
  `ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID` Sheet the same day, once it was clear the three internal
  tools' access needed to be managed independently, not as one combined list. That Sheet now
  carries a role per email (`admin`/`restricted`/`viewer`, `restricted` further scoped to a
  booking-type allow-list) rather than being a flat in-or-out list — see
  `accommodation-admin.mts` above. A unified admin console (shared users/roles/permissions across
  all internal tools, instead of a separate Sheet per tool) is under consideration as the next
  step here — see the project memory / conversation this decision came from for the current
  thinking.
  Records who's in which of the farm's 8 tents/huts, for how long, and why — a day/week/month
  calendar (tapping any cell opens a pre-filled booking dialog), a reusable guest directory with
  name/mobile-number typeahead and each guest's past-stay history, and a full audit trail of
  every change. The double-booking guarantee is enforced by Postgres itself (`EXCLUDE` gist
  constraints — see `accommodation-admin.mts` above), not application code, so it holds even
  under concurrent requests. Built alongside a public, aggregate-only availability page
  (`/visit/availability`) that let Linger (TVC's hospitality partner) self-serve rough
  availability instead of calling Madhavan directly — that public half was **deliberately
  dropped, not deferred**, before this launch (2026-08-30): the admin tool graduated to
  production on its own, and the public-facing approach is being rethought from scratch rather
  than shipped as originally designed.
- **Event Payments** (`/internal/event-payments`) — same shape as the three tools above: unlinked,
  `noindex`, Google Sign-In gated, reusing `PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID`'s "core team"
  allow-list rather than a fourth dedicated Sheet (real money movement is at least as sensitive as
  WhatsApp/photo access, same admin bracket). Built 2026-09-24, the same day the event payment
  module itself went live, once Sharath asked not just for a read-only dashboard but for the
  ability to trigger the cancellation refund itself from the same page — see `RAZORPAY.md`'s
  "Internal admin page" note and `event-payments-admin.mts` above for how the refund actually
  reaches Razorpay.
- **Member register** (`/internal/members`, 2026-10-18) — step 1 of the planned member portal
  (`members.tvc.farm`; design in `docs/plans/member-portal.md`, nothing member-facing built yet).
  A read-only admin review of the register that replaces the "TVC Spend Summary" workbook's
  Member Master / Farm Patta / House Patta tabs: one household per farm unit (`F-01`..`F-53`),
  its people, farm and house pattas, and a list of data gaps to fix. Same shape as the tools above
  (unlinked, `noindex`, Google Sign-In, `requireStaff` against the new `members` module in
  `staff-registry.ts`). `netlify/functions/members-admin.mts` reads the `member_*` tables
  (`supabase/migrations/0040_member_portal_schema.sql`, TVC ERP project, RLS on with no policies,
  service-role only) and masks server-side: email and phone values are never returned, only
  whether one is on file, and names are masked for `read_only`. **Admin editing** (same page, same
  function, `POST /api/members-admin/edit`): `edit` (user, admin) corrects a person's name and
  replaces or clears their email and phone (write-only: the current value is never shown);
  `manage` (admin only) changes household membership and roles, a household's house, cluster and
  unit type, and adds, corrects, moves or deletes farm and house patta records. Every edit is
  validated (`scripts/lib/member-edit.mjs`), written to `staff_audit_log` BEFORE it is applied
  (refused if the log write fails), and the log records which records and fields were touched but
  never a name, email, phone or land number. A person left with no household is made inactive, not
  deleted. Data arrives through a one-time,
  re-runnable import (`scripts/export-member-sheet.mjs` reads the workbook, including the emails
  held in Member Master's Google people chips; `scripts/import-members.mjs` +
  `scripts/lib/member-import.mjs` load it, dry-run by default, keyed on `farm_unit` /
  `import_key`). The source sheets number farm units differently
  (patta tabs vs Member Master) and households can swap houses (two did), so each patta row is
  scored against every household by how many name words agree, with the sheet's farm number, then
  house number, as tie-breakers. Farm patta follows the farm plot and house patta follows the
  house; weak matches are reported rather than trusted. Migration 0040 must be applied to TVC
  ERP by hand before the page works. An admin `manage` role can also let a person sign in to the
  member portal (`membership.invite`, needs an email on file; a database trigger caps it at two per
  household).
- **Member portal** (`/members/`, planned home `members.tvc.farm`; 2026-10-18) — where a signed-in
  member sees their own unit. Shaped like a society-management web portal (left menu of modules,
  module search, the member's unit always in the top bar, widget dashboard); modules not built yet
  say "Soon" and nothing shows made-up figures. Its own minimal shell: no public header, footer,
  cookie banner, chat widget or analytics. **Sign-in** is Google (the same token verification as
  admins, `verifyStaffToken`), but Google only proves who someone is: `lib/member-access.ts` then
  requires the verified email to belong to an active `member_people` row that has `can_login` on at
  least one household, otherwise the same neutral 403 whether the person is unknown, inactive or just
  not invited yet. The session is kept apart from admins' (`scripts/lib/member-client.mjs`).
  **Data**: `members-me.mts` (`GET /api/members-me/home`, `POST /api/members-me/profile`) reads only
  the households the member can sign in for, never the register. A member gets their own email and
  mobile back in full; for everyone else in the household a masked form (`p••••@gmail.com`,
  `+91 •••••• 345`, `maskEmail`/`maskPhone`, added in `members-me.mts` because the shared
  `buildHouseholdReview` never carries the values). Members can change
  only their mobile number and directory listing (`scripts/lib/member-profile.mjs`); anything else
  goes through the core team. Each self-service change is written to `member_audit_log`
  (migration 0041, append-only, never holds a name, email or phone) BEFORE it is applied, and refused
  if that write fails. Revoking `can_login` takes effect on the next request. **Family members**: an
  owner adds the people of their own unit who may sign in (`POST /api/members-me/family-add`,
  `/family-update` and `/family-remove`; a removed person is made inactive, and adding the same email again
  brings back that same record; `scripts/lib/member-family.mjs`). Up to two family members per unit sign in with
  no approval (the `member_household_members` trigger caps sign-in at two owners and two family
  members, migration 0053); a third is a row in `member_family_requests` for the core team, who are emailed
  (Resend) because it needs a decision. An add or an email change needs none, so the core team gets no email: it
  is a row in `member_admin_notices` (migration 0055) shown on `/internal/members` until someone dismisses it
  (`GET /api/members-admin/notices`, edit action `notice.dismiss`), and the unit's other owners are emailed. The core team decides on requests in a
  "Family member requests" list on `/internal/members` (`GET /api/members-admin/family-requests`, edit
  actions `familyrequest.approve` / `.reject`, `manage` capability): approving creates the person (or
  brings back an inactive one with the same email) as `family` with sign-in; migration 0054 raises the
  database's family cap to six so an approval can go past the two an owner may add alone. The owner sees
  "N requests are waiting for the core team" in the Family panel. A family member has the `family` role,
  which `lib/member-access.ts` puts on the session: `members-me.mts` refuses them the story editor,
  land documents and family changes (403), and the portal hides those controls. **`members.tvc.farm`**
  is a domain alias on the same Netlify project (DNS: a proxied Cloudflare CNAME to
  `tvc-farm.netlify.app`); `netlify.toml` rules that match only that host show the portal at `/`,
  let through just the portal's own paths, send `/internal/*` to `admin.tvc.farm` and everything else back
  to the portal's home (see `DOMAINS.md`, which also records the Netlify certificate incident).
  **First-login privacy notice**: until a member has acknowledged the current notice
  (`scripts/lib/member-privacy.mjs`, version stored in `member_people.privacy_notice_version`,
  migration 0042), `GET /api/members-me/home` returns only their name and the notice version, no
  household data, and `/profile` refuses; `POST /api/members-me/privacy` records the version and time
  (audit-logged first, `member.privacy.accept`). Raising `PRIVACY_NOTICE_VERSION` asks everyone again.
  Apple sign-in and the invitation email are not built yet.

  **Feature tour** (migration 0056, not auto-applied): the steps live in `scripts/lib/member-tour.mjs`
  (each has a `since` number, an audience, a route and a `data-tour` target on the page). The highest
  `since` a person has seen is `member_people.tour_seen_through`; `/home` returns it as
  `me.tourSeenThrough`. `null` (never signed in before) gets the whole tour on first sign-in, after the
  privacy notice; a number gets only newer steps, as a dismissible "What's new" card on Home. Skipping
  counts as seen (`POST /api/members-me/tour-seen`, never lowers the stored value); "Take the tour
  again" in the account menu replays everything and records nothing. If the column is missing (migration
  not applied) `/home` omits the value and the page shows no tour. To announce a feature, append a step
  with the next `since`.

  **Land documents** (migration 0043, not auto-applied): a member uploads the patta / land survey
  PDF they downloaded from eservices.tn.gov.in (`POST /api/members-me/land-documents`, multipart).
  Limits: PDF 1 MB (a real extract is 50-130 KB), photo 3 MB, 10 uploads per household per day,
  20 MB stored per household; the type is sniffed from the file's bytes. A **PDF is read at upload**
  with a fixed template (`netlify/functions/lib/land-doc-read.ts`, `unpdf` + `parseLandPdfText` in
  `scripts/lib/member-land-docs.mjs`) for the two e-Services layouts, the Integrated Land Record
  (A-Register) and the chitta; one that matches neither is refused and never stored. Photos can't
  be read and are kept for the core team. No AI service is involved. `members-me.mts` writes the
  audit row first, puts the file in a **private Cloudflare R2 bucket**
  (`netlify/functions/lib/land-doc-storage.ts`, S3 API via `aws4fetch`; env `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; the token is scoped to that one bucket and
  the bucket has no public access or custom domain), records a `member_land_documents` row (the R2
  object key is `storage_path`; nothing else about the file is in R2), then calls the background
  function `members-land-extract-background.mts`. Fixed rules reconcile the reading with the
  register: a record the register already holds whose survey number agrees (and patta number and area
  where readable) is marked `verified` (blanks filled, nothing overwritten); a survey number
  with no entry becomes a `pending_review` record; a disagreement, a photo, or a survey number held
  by another household changes nothing and waits. Admins see waiting documents as a flag on the
  household in `/internal/members`, open the file through a 60-second presigned R2 link
  (`POST /api/members-admin/land-document-link`, `manage` role, logged), and approve or reject each
  record (`landdoc.approve` / `landdoc.reject` through `/api/members-admin/edit`, audit-first). Owner
  names are readable only on a chitta; on an A-Register they are damaged Tamil text, so those verify
  on survey/patta/area alone and "owners unknown" never auto-creates anything. **Owner names never block a
  record the register already holds**: the PDFs print a transliteration from Tamil that often disagrees with
  the register's spelling, so only the survey number, patta and area decide (`reconcile`); `ownerMatch` is
  still recorded and the admin queue says how many automatic verifications had names that matched nobody. For a
  record not yet in the register the names remain a hint beside a decision that is always an admin's. Names are
  compared by sound (`soundKey` in `scripts/lib/member-land-docs.mjs`: sh/s, th/t, zh/l, ksh/x, oo/u, doubled letters, ...)
  as well as one letter of slack, so Sivakumar, Shivakumar and Sivakumaar are one name. Initials stand for the words they were made from ("Gopalakrishna HS" is "GOPALAKRISHNA HOSAHALLI SUBRAMANI", the register keeping initials where the PDF spells the family names out), but only beside a word that matched by spelling: initials never prove a match alone. A long owner name that wraps onto a second line in the PDF is read as one name. Files are not deleted
  when a row is; there is no retention job yet.

  **Replacing an earlier upload** (no migration): every upload is processed as a new one. Once it is
  stored and handed to the reader, the household's earlier documents it duplicates are removed (file,
  outline and row; records that pointed at them are repointed by the reader): the identical file
  (SHA-256), or one covering the same survey numbers for the same land type
  (`documentsReplacedBy` in `scripts/lib/member-land-docs.mjs`; a fresh e-Services download is a
  different file because it prints the time). A document still being read is left alone. A second
  upload never auto-verifies a record still waiting for the core team (`reconcile` returns `check`).

  **Document links and parcel outlines** (no migration): members open their own household's files
  through `POST /api/members-me/land-document-link` (their households only, audit-first as
  `member.land.view`, 60-second link); a record's `sourceDocumentId` ties it to the document it came
  from (the admin register links its survey number to that, and the portal uses it to find the parcel's
  outline). In the member portal's land tables each record also carries `pattaDocumentId` and
  `surveyDocumentId`, worked out in `GET /api/members-me/home` by `landDocumentLinks`: the **patta number**
  opens the newest patta document that lists it, and the **survey number** opens the newest FMB sketch
  for it, else the newest survey-number document (`landDocumentKind` tells the three apart: a stand-alone
  sketch, a one-survey file whose sketch was found, anything else is a patta). Files that failed to read
  are never linked. A single-survey
  Integrated Land Record carries a field sketch ("புலப்படம்", the FMB sketch) on page 2 (a
  multi-survey patta has none). Older e-Services files draw it as a small bitmap, current ones as vector
  lines (the sketch's labels are glyph shapes, so the page has no text). The background reader
  (`readLandShape`, `unpdf`) tries both and `scripts/lib/land-shape.mjs` turns either into a closed
  polygon. A bitmap is searched for the long solid straight black lines (a Hough transform, so labels
  touching the outline don't hide it; red/blue labels and dimensions are ignored by colour). Vector
  lines come straight from pdf.js's operator list (`strokedLinesFromOps`, tracking the page's
  scale/shift and stroke colour; only black strokes count, and the ruled frame is dropped by length);
  `shapeFromLines` snaps the ends into corners, splits lines where they cross or meet, and keeps only
  what is on a closed loop. Either way a corner search drops every stretch that runs past a corner,
  and what is left is redrawn as a transparent,
  label-free PNG, stored beside the file in R2 (`<document>-shape.png`, flagged by `extracted.hasShape`). It is served as
  data URLs by `GET /api/members-me/land-shapes` and `GET /api/members-admin/land-shapes`.
  Documents uploaded before outlines existed, or whose outline an older reader made (or gave up
  on), are caught up lazily: those two endpoints first run `lib/land-shape-backfill.ts` on up to three
  single-survey PDFs whose stored reading doesn't carry the current `SHAPE_VERSION`
  (`scripts/lib/land-shape.mjs`: `hasShape` + `shapeVersion` when an outline was stored,
  `shapeChecked` = the version when none was found). Raising `SHAPE_VERSION` when the reader improves
  redoes everything once, so the first load of a household's page after deploy fills them in, with no
  script or credentials.
  **Stand-alone FMB sketch** (no migration): e-Services' "Survey Number" download can also be had as the
  sketch page alone. It has no text to read (not even the survey number), so the member picks the survey
  number on the card ("Add an FMB sketch", `sketchFor` on `POST /api/members-me/land-documents`,
  `handleSketchUpload`). It is checked (the survey number is on that card's register, it isn't a patta, an
  outline can be drawn from it with `readLandShape(bytes, { standalone: true })`), stored in R2 with its outline, and
  kept as a `member_land_documents` row with `status: 'applied'`, no items and `extracted = { kind:
  'fmb_sketch', surveyNo, hasShape, shapeVersion }`; audit action `member.land.sketch`; a newer sketch for the
  same survey number replaces it. It creates and verifies no record. Its outline is returned by the shapes
  endpoints under `survey:<normalised survey no>` as well as its document id, and both the member
  portal and the admin register show a record's outline with `shapeForRecord` (the record's own patta
  first, else a sketch for its survey number). `SHAPE_VERSION` 4 = this vector reader, so single-survey
  pattas whose outline the bitmap reader missed are redone on the next page load.

- **Unit stories (`members-me.mts`, migrations 0049 and 0050; live since 2026-10-21).** Stories moved
  from one record per person to one per unit, because bio and family describe the unit. `member_unit_stories`
  (one row per household, same draft / submitted / approved copies, RLS on, anon revoked) holds the shared text, up to two
  photos and the public switch; each person's own quote and profile link sit under their id inside the copy. Rules are in
  `scripts/lib/member-unit-story.mjs` (tested). Two owners edit one shared draft: a save sends the version it started from
  and only the fields it changed, and conflicts only if the other owner changed one of the same fields (`draft_version` +
  `draft_changed`; the write is guarded on the version so a race loses cleanly). Endpoints, all behind the same
  signed-in-and-acknowledged gate as the rest of the portal: `GET`/`POST /api/members-me/unit-story` (view; save a draft),
  `POST /api/members-me/unit-story-submit` (audit-first as `member.unit_story.submit`, never with the text; a second
  owner's submit replaces one in review), `POST /api/members-me/unit-story-photo` and `unit-story-photo-remove` (at most two
  photos, checked before any file is stored), and `GET /api/members-me/unit-photo` (the unit's people see any copy; other
  members only an approved photo of a listed member). The writing check still goes through `POST /api/members-me/story-review`.
  **Admin queue** (`members-admin.mts`): `GET /api/members-admin/unit-stories` (needs `edit`) lists units in review, oldest first,
  with whose submission it is, the submitted and live copies (each quote and link under the person who wrote it) and exactly what
  changed against the live copy; the edits `unitstory.approve`, `unitstory.reject` (needs a note the members see) and
  `unitstory.unpublish` (all `manage`, audit-first, the note never in the audit entry) apply to the exact submission the
  reviewer saw, so a resubmission can't be approved unseen; approving deletes the live photos it replaced (stored under their
  uploader's id). The reviewer's photo view (`/api/members-admin/story-photo`) also serves unit photos. The queue's screen is
  the panel on `/internal/members` ("Unit stories waiting for review"; hidden while empty): each unit is a
  card showing what changed first (chips, then the changed parts with a "Currently approved" fold, the unchanged parts folded into one
  line), with Approve and Send back (a note is required). **Risk assessment** for a unit's story (migration 0050,
  `member_unit_story_assessments`, one row per submission): `POST unit-story-submit` calls `assessUnitSubmission` in `lib/story-risk.ts`,
  which shows the existing risk rules the unit's copies through `unitRiskRow` / `riskCopy`, records the assessment, and, in live mode and
  not paused, approves a low-risk story at once (the same change an admin's approval makes, replaced photos deleted) or holds a high-risk one
  and emails the core team ("Unit stories waiting for review"). With no usable model answer a public story is held without an email, as for
  a person's story. The queue card shows the assessment, an admin's decision is written onto it, and the auto-publish panel's shadow stats and
  "published automatically, hide" list count units too (a unit entry hides through `unitstory.unpublish`). The **public export**
  (`members-public.mts`, `GET /api/members-published` and `members-published-photo`): `buildPublishedUnits` turns each unit's approved, public copy into the cards (the 2017
  card name, each person's quote and link by position, all of the unit's photos, shown stacked) and serves a public photo from the uploader's
  files only if the uploader is still a listed owner of the unit. The publish counters (`handlePublishStatus`,
  `waitingPublicStories` for the daily build) count public units. The **directory** (`GET /api/members-me/directory`): `buildUnitDirectory` hands `buildDirectory` one story per owner built from the unit's approved copy (the shared bio and family,
  that person's quote and link), so a couple is one section because it is one story and one owner's edit can never split it. The unit's
  photos (at most two, not tied to a person) are dealt to its owners in order, the viewer first, and fetched from `GET /api/members-me/unit-photo`; a card or popup header shows only the people who have a photo when anyone does (`facesToShow`), so one photo uploaded is one face. The cutover that moved the portal over (a `member_settings` switch, a backfill from the per-person tables, 40 units, 2026-10-21) is done and its scripts are deleted (see git history). The portal's
  "Your story" page edits the unit's shared story. Bio, family and up to two photos are shared; the person's
  own "why TVC" line is theirs, and the housemates' lines are shown read-only. A unit's story needs **at least one** "why TVC" line from anyone in the unit before it can be submitted (`validateUnitSubmit`), because a couple's story often carries one joint quote that one of them wrote; it is not asked of each person or of whoever submits. There is no separate profile-link field: to link a name, select it in the text and press Link, and a profile link a person already has is written into the shared text on their first name when they open the editor (`foldProfileLink` in `scripts/lib/member-markdown.mjs`, saved with their next change and read by the core team with the story; if their name is not in the text it stays as a small line with a Remove button). A save sends only what changed since the last
  save (`saveChanges`) plus the version it started from, so two owners editing at once only collide on the same field; if they do, the
  server refuses the save (409, naming the field), the page shows the other owner's version of just that field, keeps the rest of
  the person's edits and sends them again (`conflictedDraftKeys`). **Privacy notice v9** (`scripts/lib/member-privacy.mjs`) describes the unit model: the story is shared by everyone in the unit who can sign in, drafts are visible to them and the core team, any of them can submit it (a later submission replaces one in review) and switch it public, each person's own "why TVC" line is theirs but readable by the unit, links on names are part of the shared text and so editable by anyone in the unit, the safety check sees everyone's lines, and turning a listing off hides only that person's own line while the shared story, links included, stays for the others (v8 had said each person's profile link was theirs alone; v9 corrects that now that links live in the text); raising the version re-prompts every member at their next sign-in.

- **Member stories (`members-me.mts`, migration 0044).** A member writes a short public-facing
  story about themselves (what they do, family, one-line "why TVC") on the portal's
  "Your story" page, which replaces the "TVC Members: Your Story" Google Form. The original per-person tables (`member_stories`, `member_story_assessments`; migrations 0044 and 0046) were dropped by migration 0051 once the unit model had been live; the rules below now apply to `member_unit_stories`, which has the same draft / submitted / approved copies, so an edit never disturbs approved text. `show_on_public_site` defaults to off.
  The bio and family text may carry a small Markdown subset (`**bold**`, `*italic*`, `[words](https://address)` links, blank line = paragraph; no HTML, images or headings): the editor's Bold/Italic/Link buttons write it, and one parser (`scripts/lib/member-markdown.mjs`) is shared by the editor preview, the directory popup, the admin queue (which lists each link's address), the public export and `MembersView`, so a link is only ever an explicit http(s) address. The writing check may fix words but a suggestion that would change an address is dropped. The old single "profile link" is still read (it links the first name) until the member opens their story, when it is written into the text as a normal link. `POST /api/members-me/story-review` returns
  suggestions on spelling, grammar, tone and house style (third person) from the Anthropic API
  (`lib/anthropic.ts`, model `STORY_REVIEW_MODEL`, default `claude-sonnet-5`; 10 checks per member and
  300 for the portal per day, counted in `usage-meter`), plus fixed checks that need no model (children
  named in the family line). The model's output is kept only where it quotes the member's own text
  (`scripts/lib/member-story.mjs`), the page shows each suggestion and the member accepts or dismisses
  it, and nothing is applied without that. The story text and the member's first name are sent to
  Anthropic for the check, so privacy notice v3 says so. **Approval queue**: see the unit stories entry above.
  **Member directory** (`GET /api/members-me/directory`, `scripts/lib/member-directory.mjs`): the portal's
  Directory lists the other members as households (farm plot, house number, cluster) with each person's **approved**
  story, for any signed-in member who has acknowledged the privacy notice. It is the one place a member
  reads about other members, so it is narrow by construction: the function selects only
  the columns shown (never email, mobile, land records or documents), only people who are active and
  listed (`directory_visible`, opt-out; an opted-out person's story is hidden too), and reads the
  `approved` copy only, whether or not it is also on tvc.farm. Profile links go to the page only if
  they are http(s), and open with `noopener noreferrer nofollow`. Privacy notice v4 describes it.
  **Seeding**: the public cards in `src/data/members.ts` were loaded once as approved, published stories (generated SQL, scripts since deleted); `member_cards` records which household each 2017 card is. The directory merges identical bio and family into one section (`groups`).
  **Photos** (`scripts/lib/member-photo.mjs`, `lib/member-photo-storage.ts`, `scripts/lib/photo-prepare.mjs`):
  a story's photo is a string inside its draft / submitted / approved copy, like the text, so a new photo
  is reviewed with the story and the live photo never changes until approval. It is a uuid (an upload,
  kept in the same private R2 bucket as the land documents under `member-photos/<person>/<photo>[-full].jpg`)
  or a path under `/images/members/` (a photo already on the public site, set by the seeding). In the
  member's browser a canvas re-encode makes a 400px square and an uncropped copy up to 1600px (before it is uploaded the member positions the photo in a circle: drag to centre, zoom 1x to 4x by slider, wheel or pinch, with the arrow keys and +/- as well; `scripts/lib/photo-crop.mjs` gives the exact square the circle shows, `photo-prepare.mjs` cuts it, and the click-to-enlarge copy stays uncropped), which also
  strips the camera's metadata including GPS; the server (`POST /api/members-me/unit-story-photo`) re-checks
  that both are real JPEGs, the sizes and the square, then REMOVES every metadata block itself (`stripJpegMetadata`: EXIF, XMP, IPTC, comments, multi-picture offsets; the JFIF header and ICC colour profile stay) and stores the cleaned bytes, never the uploaded ones, with
  a cap of 10 uploads a member a day. Photos are never public: `GET /api/members-me/unit-photo` serves one only
  to the unit's people (any copy) or, for the APPROVED photo of a listed member, to any signed-in member, and the
  page fetches it with the member's sign-in and shows it from a blob URL, and only once the picture is near the
  screen (`photoImg` waits on an IntersectionObserver, so a long directory doesn't request every photo at once). The
  response is `private, max-age=604800, immutable`: a photo's id never changes (a replaced photo is a new id), so the
  browser keeps it for a week and a repeat visit doesn't refetch; the story row is read in parallel with the
  viewer check. `members-admin.mts` serves a
  submitted or approved photo to admins with `edit`. Replacing a photo, removing it, resubmitting or
  approving deletes the files nothing refers to any more.Privacy
  notice v5 describes photos.
  **Public export** (`netlify/functions/members-public.mts`, `scripts/export-member-stories.mjs`,
  `scripts/lib/member-publish.mjs`, migration 0045 `member_cards`): the public Members page is the 2017 cards
  (`legacyMembers` in `src/data/members.ts`) merged with `src/data/members-published.json`, which `npm run
  build` writes by calling the live `GET /api/members-published` function. The build has no database or R2
  credentials (those secrets are Functions-only on purpose), so it asks a function that returns only what the
  public site shows anyway: the APPROVED copy of a primary member's story whose "Show on tvc.farm" switch is on,
  for people who are active and still listed; drafts, stories in review, private stories, family members and
  opted-out people are never in it. `member_cards` (filled once by the seeding SQL) says which household each
  2017 card is, in the order of the names, so a card keeps its name and its quotes and links keep pairing with
  the names by position; a new household is named from its primary members. A published card replaces its
  2017 card in place (keeping a hand-written `summary` or full-size photo while the text or photo is unchanged);
  a household that switched itself off, or whose members are all unlisted, is reduced to its name; a new member
  is added. Uploaded photos are downloaded from `GET /api/members-published-photo` (approved + public +
  primary + listed only) into `public/images/members/up-*.jpg` (git-ignored build output) and get the usual
  AVIF/WebP variants. If the endpoint does not exist yet the export is skipped; any other failure FAILS a
  production build, so the live site keeps its current stories instead of quietly reverting to the 2017
  text. Batched publishing: approvals do nothing to the site until the admin "Publish to the website" button
  (`site.publish`, `manage`) POSTs to a Netlify build hook (`NETLIFY_BUILD_HOOK_URL`), audit-first and at most
  once per 10 minutes (a build takes about half an hour and costs credits); the panel shows how many approved
  public stories are waiting. The old member-update email workflow still triggers on `members.ts` but now
  finds no changed cards, since portal changes never touch that file.
  **Risk-based publishing** (`netlify/functions/lib/story-risk.ts`, `scripts/lib/member-risk.mjs`,
  `member-autopublish.mjs`, `members-daily-publish.mts`, migration 0046): when a member submits a story that is
  switched on for tvc.farm it is assessed: fixed rules the model can never overrule (a first public story,
  children or ages, a phone number or email, any new or changed link or an unusual one, a photo change, most of
  the text rewritten; only what is NEW is scanned once a story is already public) plus the Anthropic model's
  judgement (`STORY_RISK_MODEL`, default the story-check model; 200 a day, counted in `usage-meter`), which can
  only raise the level. The result, low or high with reasons, is stored in `member_unit_story_assessments` (never the
  story text) and the person's later approve/reject is written beside it. A story not for the public site is
  always low. A setting `story_autopublish` in `member_settings` (`{ mode: shadow | live, paused }`, changed by
  admin `site.autopublish`, `manage`, audited) decides what happens: in SHADOW mode (the default) a person still
  approves everything, the review queue shows what the assessment would have done, and the admin panel compares
  it with the team's decisions; in LIVE mode a low-risk story is approved at once by the system, a high-risk one
  stays in review and `sendStaffAlert` emails core-team with why and what changed (no email when the only reason
  is that the model was unavailable), and the scheduled function `members-daily-publish` (07:00 IST) starts one
  build if approved public stories are waiting. Paused keeps live mode but makes everything wait for a person.
  Admins can take a published story off the site (`unitstory.unpublish`, `manage`, which also starts a build). Photos
  are never sent to the model: any public photo change is a rule-based hold. Privacy notice v6 discloses the check.
  **Register cards and Google picture** (migration 0047, `scripts/lib/member-google-picture.mjs`): the admin
  member register's household cards name the owners by first name ("Asha & Ravi"), or by full name when a card
  has one person, and show each one's Google profile picture (or their initial). The picture comes from the
  `picture` claim of the Google sign-in token, which `verifyStaffToken` passes on only if it is an https address
  on Google's image hosts; `requireMember` writes it to `member_people.google_picture_url` (audited first as
  `member.google_picture`, best effort, never blocking sign-in) only for a member who has accepted privacy notice
  v7, which says so, refreshes it at each sign-in and clears it if they removed it from Google. `members-admin.mts`
  sends it only to roles that may see names (not `read_only`). Since privacy notice v10 `GET /api/members-me/home`
  also returns it, but only for the people in the member's own unit, shown next to their names (a picture
  there also tells the unit who has signed in); no other member endpoint returns it, so other units never see it.

## Current Production Status

**tvc.farm is live on this codebase**, verified directly against the production site:

| Feature | Status |
|---|---|
| Static pages (Home, About, Visit, Events, Ecosystem, Our Journey, etc.) | ✅ Live |
| Corrected link-preview images (WhatsApp/iMessage OG fix) | ✅ Live |
| Member list fix (Shataparna & Deb removed) | ✅ Live |
| Year-by-year interactive timeline (`/our-journey/timeline`) | ✅ Live |
| Chat widget UI | ✅ Live |
| Chat widget's actual AI responses | ✅ Live — `ANTHROPIC_API_KEY` set 2026-07-18; verified with real requests against `tvc.farm/api/chat` returning grounded answers |
| Friends of TVC WhatsApp group (direct invite link) | ✅ Live — `/contact` links straight to the group, no form or manual step |
| Membership + general enquiry forms (Netlify Forms + `/api/enquiry`) | ✅ Live — Sheet ids set and shared with the service account, verified with real `POST`s against production for both form types; email goes to `core-team@tvc.farm` via the site-wide Netlify Forms notification rule (moved from `contact@tvc.farm` on 2026-08-19) |
| Host an Event inquiry form (Netlify Forms) | 🟢 Deployed and registered — confirmed directly via Netlify's Forms API (`host-event-inquiry`, correct field schema: name/organization/email/phone/event-type/group-size/dates/message/honeypot); **0 submissions to date**, so the full round-trip hasn't actually been exercised yet |
| Visit inquiry form + WhatsApp CTA (Netlify Forms) | ✅ Live and verified — confirmed via Netlify's Forms API (`visit-inquiry`), **1 real submission recorded** (2026-08-04); replaces the "Book via Linger" redirect on `/visit/camping`, `/visit/day-visit`, `/visit/trekking-trails` |
| Event interest widget + counter (Netlify Function, Blobs, Forms) | ✅ Live — "Want this to happen again?" on past event pages (`/events/<slug>`), public count via `/api/event-interest` + Netlify Blobs, optional-email entries via Netlify Forms; verified `/api/event-interest` responds live in production |
| Google Analytics (GA4) | ✅ Live — `G-795FTPB47P`, loaded site-wide from `BaseLayout.astro`, skipped on localhost, consent-gated via `CookieConsent.astro` and `/privacy`. Was silently broken 2026-08-21 to 2026-09-19: CSP allowlisted the wrong collect domain, then (2026-09-17) a wildcard that didn't cover the bare apex domain the real hit lands on - fixed and verified for real this time (triggered a `securitypolicyviolation` DOM event against production to confirm zero remaining blocks) |
| Microsoft Clarity | ✅ Live — deployed, tag firing (script tag, bundle, and collect beacon confirmed unblocked under the `*.clarity.ms` CSP wildcard), same consent gate as GA. Project id `xttq21yf39`, reusing the one Bing Webmaster Tools had already auto-provisioned. The `contact@tvc.farm` dashboard sign-in issue (see below) is resolved as of 2026-09-21 — sign-in confirmed working |
| Live weather widget (`/ecosystem/geography`) | ✅ Live — Open-Meteo, no API key, 15-minute `localStorage` cache |
| Live rainfall chart/table/monsoon stat (`/ecosystem/weather`, `/api/rainfall`) | ✅ Live — reads the community's rainfall-log Sheet live, `RAINFALL_SHEET_ID` set on Netlify (all deploy contexts); multi-year line chart with year-filter checkboxes; verified against `tvc.farm/ecosystem/weather` and `tvc.farm/api/rainfall` directly |
| Site search (nav icon / `/` key), AI-only via `/api/search-ai` | ✅ Live — deployed 2026-09-21, verified directly against `tvc.farm/api/search-ai` returning a real, grounded answer with source links from the Gemini free tier. Submit-triggered UI behavior (Enter, mobile keyboard action, tap) confirmed in a real browser pre-deploy. Pagefind (the prior client-side keyword index) was removed the same day in favor of this AI-only search |
| Photo Pool dashboard (`/internal/photo-pool`, `/api/photo-pool`) | ✅ Live — Drive folders, service account, Google Sign-In OAuth client, admin roles (Supabase `staff_module_roles`, formerly a curator Sheet), all Netlify env vars configured; verified against production directly (`/internal/photo-pool` returns 200, `/api/photo-pool` returns 401 unauthenticated as expected for the Google Sign-In-gated function) |
| WhatsApp webhook (`/api/whatsapp-webhook`) | ✅ Live — verified end-to-end with a real WhatsApp message to `+91 80 4110 9754` on 2026-08-19. Two real bugs found and fixed along the way: the number wasn't actually registered for Cloud API messaging (blocked by a stuck migration from the old AiSensy WABA, which still held the number), and the WABA was never subscribed to the app's webhook (`POST /{waba-id}/subscribed_apps` — a separate step from the App Dashboard's webhook config). Persists every inbound message to Supabase (2026-08-20); no longer emails per-message (see the stale-alert row below). See `WHATSAPP.md` |
| WhatsApp reply dashboard (`/internal/whatsapp`, `/api/whatsapp-admin`) | ✅ Live — verified end-to-end with real WhatsApp messages and real replies sent from production. Unread indicators, real pagination, message previews, per-reply responder names, WhatsApp/iMessage-style avatars, and a full visual pass added 2026-08-20 after real usage surfaced gaps |
| WhatsApp event reminders (`whatsapp-event-reminders.mts`, scheduled) | 🟡 Deployed 2026-10-10 with migration `0033` applied; both templates approved; sends only to opted-in guests |
| WhatsApp unread digest (`whatsapp-stale-alert.mts`, scheduled) | ✅ Live — cron every 15 minutes, emails `core-team@tvc.farm` one digest of conversations unread 60+ minutes, re-sent hourly per conversation until read. Replaces the old per-message email (2026-08-20) |
| Accommodation Allocation dashboard (`/internal/accommodation-calendar`, `/api/accommodation-admin`) | ✅ Live — merged to `main` and deployed 2026-08-30 (PR #116); verified directly against production (`/internal/accommodation-calendar` returns 200, `/api/accommodation-admin/bookings` returns 401 unauthenticated as expected for the Google Sign-In gate, `accommodation-admin` listed among the deploy's live functions). The public availability view (`/visit/availability`) built alongside it was **not** included in this launch — dropped 2026-08-30, pending a rethink; confirmed 404 on production |
| Partner calendar API, phase 1 (`/api/partner/v1/*`, read-only, for Linger) | 🔴 Built 2026-10-24, **not deployed**: migration `0060` is applied to TVC ERP (2026-10-24); still needs the PR merged, a pool and grants set with `scripts/partner-key.mjs`, and a key issued to Linger. Unit-tested and exercised against a scratch Postgres and a fake PostgREST; not yet run against the real project |
| Event payment tracking (`EventBookingForm`, `/api/event-booking`, `/api/razorpay-webhook`, `/api/cancel-booking`) | ✅ Live as of 2026-09-24 — real live-mode Razorpay keys and webhook configured; a real Payment Link creation verified directly against the live API. One event uses it so far (Foraging Day, 10 Oct 2026); reusable for any event with no code change — see `RAZORPAY.md`. Full webhook→Supabase→receipt chain confirmed in Test mode with two real test payments; Live mode confirmed only through Payment Link creation (an unpaid dry run), not yet through an actual completed live payment |
| Event Payments dashboard + refund trigger (`/internal/event-payments`, `/api/event-payments-admin`) | 🟠 Deployed to production 2026-09-24 (merged to `main`, migrations `0020`-`0024` applied to the live "TVC ERP" project) — registrations/cancellations/money-collected read against real `event_payments` rows, and test-mode/live-mode filtering plus the refund-initiated/refund-processed/refund-failed status split (see `RAZORPAY.md`) are all live. 2026-09-25: refund-tier date fix, duplicate-payment guard, bulk event-wide cancellation, and payment-method capture shipped; fee reconciliation (`fee_amount`) is written but the nightly script that populates it isn't running yet — needs repo secrets added (see `RAZORPAY.md`). Still **not yet exercised**: no real refund has actually been triggered end-to-end against a live payment (`createRefund` → live Razorpay API → `refund.processed` webhook → `refunded_at` set) — do that once before fully trusting the refund flow for a real cancellation |

The membership/general enquiry forms are fully live — Sheets logging verified with real
production `POST`s, and email routes to `core-team@tvc.farm` via the site-wide Netlify Forms
notification rule. Every feature in the table above except the one noted below has been checked
directly against production (page/API responses, or Netlify's own Forms API). The Host an Event
form is registered correctly with Netlify, but has zero real submissions to date, so its full
round-trip hasn't actually been exercised.
The Netlify project itself is owned by the `contact@tvc.farm` account (moved there from a
personal account on 2026-07-18).
