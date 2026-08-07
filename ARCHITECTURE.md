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
five Netlify Functions (the site-wide chat assistant, the event-interest counter backing past
events' "Want this to happen again?" widget, `/api/photo-pool` backing the internal, unlinked
photo review dashboard at `/internal/photo-pool`, `/api/enquiry` logging the membership
enquiry form (`/join`) and the general enquiry form (`/contact`) to Google Sheets, and
`/api/rainfall` reading the community's rainfall-log Google Sheet live for the rainfall chart/
table/monsoon stat on `/ecosystem/weather`), Netlify Blobs
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
fully configured and verified end-to-end via local dev — not yet independently re-verified
against the live production URL. `/api/enquiry` is **live and verified**: its two Google Sheets
are created, shared Editor-access with the service account, and their ids set as
`MEMBERSHIP_ENQUIRY_SHEET_ID`/`GENERAL_ENQUIRY_SHEET_ID` — a direct `POST` to
`https://tvc.farm/api/enquiry` for each form type appended a real row successfully. No custom
Netlify notification rule was needed for the email side either: this site's Netlify account is
itself owned by `contact@tvc.farm`, and Netlify emails the account owner on every form submission
by default, with no per-form rule configured — the custom "Email notification" rule setting (which
prompted a plan upgrade) is only for *additional* recipients beyond the owner, not required here.

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

    subgraph SRC["1 · Source — github.com/TamarindValleyCollective/website (main)"]
        PAGES["src/pages/*.astro<br/>File-based routes: Home, About, Visit,<br/>Events, Ecosystem, Our Journey, Contact, etc."]
        INTERNALPAGE["src/pages/internal/photo-pool.astro<br/>Unlinked, noindex — photo review dashboard shell"]
        COMPONENTS["src/components/<br/>Nav, Footer, PageHero, ChatWidget,<br/>CookieConsent, JourneyTimelineStandalone,<br/>BiodiversityExplorer, PhotoGallery"]
        CONTENT["src/content/*<br/>Markdown collections: events, partners,<br/>community-outreach, photos"]
        FUNC_SRC["netlify/functions/chat.mts<br/>Serverless function, calls Anthropic API server-side"]
        FUNC_SRC2["netlify/functions/event-interest.mts<br/>Serverless function, reads/writes Netlify Blobs"]
        FUNC_SRC3["netlify/functions/photo-pool.mts<br/>Serverless function, Google Sign-In gated —<br/>verifies ID token, checks a Sheet-backed<br/>allow-list, lists Inbox (+ uploader/EXIF/GPS/<br/>description), moves photos, saves descriptions"]
        FUNC_SRC4["netlify/functions/enquiry.mts<br/>Serverless function — appends a row to a<br/>Google Sheet per membership/general enquiry,<br/>fired via sendBeacon alongside each form's<br/>own native Netlify Forms submission"]
        FUNC_SRC5["netlify/functions/rainfall.mts<br/>Serverless function — reads the community's<br/>rainfall-log Sheet (monthly + daily tabs) on<br/>every page view, computes the monsoon<br/>to-date stat, returns JSON"]
        SCRIPT_SRC["scripts/build-chat-context.mjs<br/>Strips nav/footer from built HTML →<br/>content corpus for the chatbot"]
        SCRIPT_SRC2["scripts/build-search-index.mjs<br/>Reads every page's actual rendered<br/>title/description → dist/search-index.json<br/>for the client-side site search"]
    end

    subgraph BUILD["2 · Build — on push to main"]
        B1["npm run build<br/>→ astro build (prerenders every page)"]
        B2["→ build-chat-context.mjs<br/>writes site-content.json (gitignored)"]
        B2B["→ build-search-index.mjs<br/>writes dist/search-index.json"]
        B3["Output: dist/ (static site) + bundled function<br/>netlify.toml declares build cmd, publish dir, functions dir"]
    end

    subgraph HOST["3 · Hosting: Netlify — LIVE"]
        CDN["Static CDN<br/>Serves dist/ — everything except<br/>the exceptions to the right"]
        APIFN["Netlify Function: /api/chat<br/>Deployed and live —<br/>ANTHROPIC_API_KEY set, calls the<br/>Anthropic API for grounded answers"]
        APIFN2["Netlify Function: /api/event-interest<br/>Deployed and live —<br/>reads/writes the per-event count below"]
        APIFN3["Netlify Function: /api/photo-pool<br/>(+/thumb, +/description)<br/>Configured — Drive service account + folder IDs<br/>set as Netlify env vars for all deploy contexts"]
        APIFN4["Netlify Function: /api/enquiry<br/>Live and verified — Sheet ids set,<br/>Sheets shared Editor-access with the<br/>service account, real appends confirmed"]
        APIFN5["Netlify Function: /api/rainfall<br/>Reads the rainfall-log Sheet (view-access<br/>only, read-only path) — RAINFALL_SHEET_ID"]
        BLOBS["Netlify Blobs: 'event-interest' store<br/>One JSON record per past event id —<br/>{count, emails[]}. Reset via<br/>netlify blobs:delete event-interest &lt;id&gt;"]
        FORMS["Netlify Forms<br/>Captures /contact membership + general<br/>enquiries, /visit/host-an-event inquiries,<br/>/visit camping·day-visit·trekking inquiries,<br/>and event-interest submissions with an email"]
    end

    CF["Cloudflare<br/>DNS + CDN for tvc.farm,<br/>proxies to Netlify"]

    subgraph BROWSER["4 · Visitor's Browser"]
        CHATW["ChatWidget.astro<br/>Floating widget, site logo.<br/>Calls /api/chat"]
        SEARCH["SiteSearch.astro (in Nav)<br/>Fetches /search-index.json once,<br/>searches entirely client-side —<br/>no backend, no Function"]
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
        WEATHER["WeatherWidget (/ecosystem/geography)<br/>Fetches current conditions from<br/>Open-Meteo, no API key"]
        RAINFALL["Rainfall chart/table/monsoon stat<br/>(/ecosystem/weather)<br/>Fetches /api/rainfall client-side,<br/>1hr-cached in localStorage"]
    end

    subgraph INTERNAL5["5 · Internal tool — staff-only, not part of the public site flow"]
        POOLDASH["Photo Pool dashboard (/internal/photo-pool)<br/>Google Sign-In gated client-side shell — shows uploader,<br/>EXIF/GPS, editable description; unlinked, noindex,<br/>sitemap-excluded"]
    end

    subgraph EXTERNAL["External services (called directly by the browser)"]
        INAT["iNaturalist API"]
        GMAPS["Google Maps (iframe, directions only)"]
        YT["YouTube (iframe)"]
        ANTHROPIC["Anthropic Claude API<br/>(chat.mts server-side,<br/>and caption-photos.mjs locally)"]
        R2["Cloudflare R2<br/>media.tvc.farm — curated photo storage,<br/>served directly to the browser"]
        GTAG["Google Analytics<br/>googletagmanager.com/gtag/js"]
        METEO["Open-Meteo API<br/>Free, no key required"]
        GDRIVE["Google Drive API<br/>Shared Inbox/Approved/Rejected/Published<br/>folders — service-account auth,<br/>called server-side only (Function + local script)"]
        GSHEET["Google Sheets API<br/>Curator allow-list (read, photo-pool.mts) +<br/>membership/general enquiry logs (write,<br/>enquiry.mts) + rainfall log (read,<br/>rainfall.mts) — same service account,<br/>called server-side only"]
        GIDTOKEN["Google Identity Services / OAuth<br/>Curator sign-in (browser) +<br/>ID token verification against<br/>Google's public JWKS (photo-pool.mts)"]
        GSC["Google Search Console API<br/>urlInspection.index.inspect — read-only,<br/>same service account (added as a<br/>Restricted user on the property),<br/>called from a local script only"]
    end

    SRC --> BUILD
    BUILD --> HOST
    HOST --> CF
    CF --> BROWSER
    BIODIV -.-> INAT
    APIFN -.-> ANTHROPIC
    PHOTOS -.-> R2
    GA -.-> GTAG
    WEATHER -.-> METEO
    RAINFALL --> APIFN5
    APIFN5 -.->|"read monthly + daily tabs"| GSHEET
    SCRIPT_CURATE -.->|"S3-compatible upload"| R2
    SCRIPT_CURATE -->|"writes"| CONTENT
    SCRIPT_CAPTION -.->|"vision request per photo"| ANTHROPIC
    SCRIPT_CAPTION -->|"backfills caption:"| CONTENT
    SCRIPT_PULL -.->|"download + move files"| GDRIVE
    SCRIPT_GSC -.->|"inspect URL indexing/crawl status"| GSC
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
    INTEREST -.->|"only when an email is given"| FORMS
    CF --> INTERNAL5
    POOLDASH --> APIFN3
    APIFN3 -.->|"list Inbox, proxy thumbnails,<br/>move on approve/reject"| GDRIVE
    APIFN3 -.->|"read allow-list rows"| GSHEET
    APIFN3 -.->|"verify curator's ID token"| GIDTOKEN
    POOLDASH -.->|"Sign in with Google"| GIDTOKEN

    classDef staticStyle fill:#e8f2ea,stroke:#17723b,color:#0f5029
    classDef netlifyStyle fill:#fdead3,stroke:#f78520,color:#9a5310
    classDef externalStyle fill:#f6f1e7,stroke:#c9c2a8,color:#22291f
    classDef cfStyle fill:#fef3e0,stroke:#e8891c,color:#7a4a00
    classDef localStyle fill:#eef0f5,stroke:#6b7280,color:#374151

    class PAGES,INTERNALPAGE,COMPONENTS,CONTENT,CHATW,SEARCH,FRIENDS,MEMBERFORM,GENERALFORM,HOSTFORM,BOOKING,INTEREST,BIODIV,PHOTOS,TIMELINE,GA,WEATHER,RAINFALL,CDN,POOLDASH staticStyle
    class FUNC_SRC,FUNC_SRC2,FUNC_SRC3,FUNC_SRC4,FUNC_SRC5,SCRIPT_SRC,SCRIPT_SRC2,APIFN,APIFN2,APIFN3,APIFN4,APIFN5,BLOBS,FORMS,ANTHROPIC netlifyStyle
    class INAT,GMAPS,YT,R2,GTAG,METEO,GDRIVE,GSHEET,GIDTOKEN,GSC externalStyle
    class CF cfStyle
    class SCRIPT_CURATE,SCRIPT_CAPTION,SCRIPT_PULL,SCRIPT_GSC localStyle
```

**Legend:** 🟢 static / no server required · 🟠 depends on Netlify specifically (Functions or
Forms) · ⬜ external third-party service (includes R2, which is a Cloudflare product but plays
the role of an external media store here, not part of the Netlify hosting path) · 🟡 Cloudflare
DNS/CDN layer in front of Netlify · ⚪ runs locally on a contributor's machine, outside the
Netlify build (the offline photo curation and captioning scripts).

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
- **`src/components/`** — shared UI: Nav, Footer, PageHero, the ChatWidget, the year-by-year
  `JourneyTimelineStandalone` component, the live `BiodiversityExplorer`, and `PhotoGallery`
  (In Pictures - filters, Grid/Map toggle, lightbox; its map, `photo-map.ts`, reuses the same
  Leaflet + OpenStreetMap setup as the biodiversity map, adapted for photo-thumbnail pins).
- **`src/content/`** — Markdown content collections that change over time without touching
  code: `events`, `partners`, `community-outreach`, `photos` (the last one populated by the
  offline curation script below, not authored by hand).
- **`netlify/functions/chat.mts`** — powers the chat widget.
- **`netlify/functions/event-interest.mts`** — powers the "Want this to happen again?" widget
  (Netlify Blobs, see Hosting below).
- **`netlify/functions/photo-pool.mts`** — backs `/internal/photo-pool`. Gated by real Google
  Sign-In rather than a shared password: a curator authenticates client-side via Google Identity
  Services, and this Function verifies the resulting ID token itself
  (`scripts/lib/google-id-token.mjs`) before checking the verified email against a live
  allow-list — a one-column Google Sheet (`getAllowedEmails` in `google-drive.mjs`), not a static
  env var, so adding a curator is just adding a row, no redeploy. A real Google Group wasn't an
  option since curators are a mix of Workspace and personal Gmail accounts (group-membership APIs
  only work within a Workspace domain you administer). Once authenticated and authorized, it
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
  and the general enquiry form (`/contact`). Each form submits natively via Netlify Forms (email —
  no custom notification rule needed, since Netlify emails the account owner by default on every
  submission, and that owner already is `contact@tvc.farm`); this Function exists purely
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
  from April 1 through today's exact date rather than comparing a partial year against another
  year's full total. Reuses `scripts/lib/google-drive.mjs`'s `getSheetValues()` (a small
  generalization of the existing single-column `getAllowedEmails()` reader into a full-grid one,
  used by both now).
- **`scripts/lib/google-id-token.mjs`** — verifies a Google Identity Services ID token: fetches
  and caches Google's JWKS, hardcodes the expected `RS256` algorithm (defense against
  algorithm-confusion attacks), verifies the RSA signature via Node's built-in `crypto`, and
  exact-matches `iss`/`aud`/`email_verified`. The reverse direction of `google-drive.mjs`'s JWT
  *signing* — same hand-rolled, dependency-free approach.
- **`scripts/build-chat-context.mjs`** — post-build script that prepares the chat widget's
  knowledge base.
- **`scripts/build-search-index.mjs`** — post-build script for the client-side site search
  (`src/components/SiteSearch.astro`, rendered from `Nav.astro`). Walks `dist/` the same way
  `build-chat-context.mjs` does, but keeps only each page's actual rendered `<title>`/`<meta
  description>` (skipping anything marked `noindex`) rather than full page text, and writes the
  result to `dist/search-index.json` — a plain static asset, not a Function, so the search box
  fetches it once and matches/ranks entirely in the browser with no backend at all.
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
  Netlify Function and a plain `node`-run script can import it directly. Also exports
  `inspectUrl()` (Search Console's `urlInspection.index.inspect`, read-only scope), used only by
  `check-search-console.mjs` below — same service account, no separate credentials.
- **`scripts/check-search-console.mjs`** — run locally. Looks up Google's own crawl/index status
  (`coverageState` — e.g. "Not found (404)", "Submitted and indexed" — and `lastCrawlTime`) for
  one or more URLs, to confirm whether a `netlify.toml` redirect fix has actually been recrawled
  yet rather than eyeballing the Search Console UI by hand. The service account was added as a
  Restricted user on the `tvc.farm` Search Console property (2026-08-07) for this.

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
  itself in the (English-only) site-content corpus — no need to translate the corpus itself.

### 2. Build

On every push to `main`, Netlify runs:

1. `astro build` — prerenders every route to static HTML into `dist/`.
2. `build-chat-context.mjs` — strips repeated Nav/Footer markup out of the built HTML and
   writes the remaining page text into a single JSON corpus (`site-content.json`, regenerated
   every build, gitignored).
3. `build-search-index.mjs` — reads every page's `<title>`/`<meta description>` out of the same
   built HTML and writes `dist/search-index.json`, the client-side site search's entire "index"
   (not gitignored the way `site-content.json` is, since it needs to actually deploy as a static
   asset rather than staying server-side-only).

`netlify.toml` declares the build command, publish directory (`dist`), and functions directory
(`netlify/functions`).

### 3. Hosting — Netlify (live)

The Netlify project is owned by the `contact@tvc.farm` account (moved there from a personal
account on 2026-07-18).

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
  page view for the `/ecosystem/weather` chart/table/monsoon stat.
- **Netlify Blobs** — live. One store (`event-interest`), one JSON record
  per past event id (`{count, emails[]}`), written only by `event-interest.mts` — the site's
  only piece of server-side state that's publicly *readable*, unlike the write-only Forms
  below. Auto-provisioned per-site, no setup or environment variable needed. Reset a specific
  event's record with `netlify blobs:delete event-interest <event-id>` (see README.md).
- **Netlify Forms** — live. Detects each `data-netlify="true"` form at build time and captures
  submissions with no custom backend code required. Five things use it: the membership enquiry
  form (name, email, phone, message) at the bottom of `/join` and the general enquiry form (same
  fields, plus a WhatsApp link) at `/contact`, both redirecting to `/contact/thanks` on success —
  live, no custom notification rule needed (this site's Netlify account is itself owned by
  `contact@tvc.farm`, and Netlify emails the account owner by default on every submission), and
  each also fires `/api/enquiry` (see above) to log a Sheets row; the Host an Event inquiry
  (name, org, contact details, event type, headcount, dates, message) at `/visit/host-an-event`,
  redirecting to `/visit/host-an-event/thanks` — pushed to `main` and deployed, but not
  independently re-verified against production; the Visit inquiry form
  (`src/components/BookingInquiry.astro`), one shared `visit-inquiry` Netlify Form reused on
  `/visit/camping`, `/visit/day-visit`, and `/visit/trekking-trails` with a hidden `type`
  field noting which page it came from, redirecting to `/visit/thanks` — replaces the old
  external "Book via Linger" redirect, with pricing/inclusions now published on TVC's own
  pages and a WhatsApp link offered alongside the form; pushed to `main` and deployed, with
  both email notifications (`stay@linger.in` and `contact@tvc.farm`) now set up in the
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
- **SiteSearch** (magnifying-glass icon in the nav, opens on click or the `/` key) — client-side
  search over every non-`noindex` page's title/description, fetched once from
  `/search-index.json` and matched/ranked in the browser; no Function, no external service.
  Keyboard-navigable (↑/↓/Enter), Escape or clicking outside the panel closes it.
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

- **Photo Pool dashboard** (`/internal/photo-pool`) — staff-only, not part of the public site:
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
  above. **Fully configured, not yet deployed**: Google Cloud service account, the four-folder
  Drive tree (Inbox/Approved/Rejected/Published, `tvc-photo-pool@tvc-farm.iam.gserviceaccount.com`
  as Editor), an OAuth 2.0 Client ID (Web application, published to Production — no verification
  needed since it only requests non-sensitive `openid`/`email`/`profile` scopes), the curator
  allow-list Sheet (shared view-only with the same service account, Sheets API enabled on the
  project), and all Netlify env vars are set up; verified end-to-end via `netlify dev`, including
  a real Google Sign-In with an allow-listed account (dashboard loads, list/thumbnail/approve/
  reject/description all functional) and the same account removed from the allow-list (clean 403
  with working recovery). Awaiting a push to `main` to actually go live.

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
| Membership + general enquiry forms (Netlify Forms + `/api/enquiry`) | ✅ Live — Sheet ids set and shared with the service account, verified with real `POST`s against production for both form types; email relies on Netlify's default owner notification (the account owner already is `contact@tvc.farm`), no custom notification rule needed |
| Host an Event inquiry form (Netlify Forms) | 🟢 Deployed (pushed to `main`) — same Netlify Forms mechanism as the Visit inquiry form, at `/visit/host-an-event`; not independently re-verified against production |
| Visit inquiry form + WhatsApp CTA (Netlify Forms) | 🟢 Deployed (pushed to `main`), both email notifications configured — replaces the "Book via Linger" redirect on `/visit/camping`, `/visit/day-visit`, `/visit/trekking-trails`; not independently re-verified against production |
| Event interest widget + counter (Netlify Function, Blobs, Forms) | ✅ Live — "Want this to happen again?" on past event pages (`/events/<slug>`), public count via `/api/event-interest` + Netlify Blobs, optional-email entries via Netlify Forms; verified `/api/event-interest` responds live in production |
| Google Analytics (GA4) | ✅ Live — `G-795FTPB47P`, loaded site-wide from `BaseLayout.astro`, skipped on localhost, consent-gated via `CookieConsent.astro` and `/privacy` |
| Live weather widget (`/ecosystem/geography`) | ✅ Live — Open-Meteo, no API key, 15-minute `localStorage` cache |
| Live rainfall chart/table/monsoon stat (`/ecosystem/weather`, `/api/rainfall`) | ✅ Live — reads the community's rainfall-log Sheet live, `RAINFALL_SHEET_ID` set on Netlify (all deploy contexts); multi-year line chart with year-filter checkboxes; verified against `tvc.farm/ecosystem/weather` and `tvc.farm/api/rainfall` directly |
| Site search (nav icon / `/` key) | 🟢 Deployed (pushed to `main`), verified via `astro build` + `astro preview` locally (42 pages indexed, keyboard nav, navigation on Enter) — not yet independently re-verified against the live production URL |
| Photo Pool dashboard (`/internal/photo-pool`, `/api/photo-pool`) | 🟢 Fully configured (Drive folders, service account, Google Sign-In OAuth client, curator allow-list Sheet, all Netlify env vars) and verified end-to-end via `netlify dev`, including real sign-in and the 403 not-authorized path — not yet pushed to `main` |

One known gap remains in what's deployed: the Photo Pool dashboard, fully built, configured, and
verified locally, awaiting a push to actually deploy. The membership/general enquiry forms are
fully live — Sheets logging verified with real production `POST`s, and email needs no separate
setup since Netlify's default owner notification already reaches `contact@tvc.farm`.
Every other *deployed* feature above is either confirmed live in production or (Host an Event,
Visit inquiry) pushed to `main` without a separate direct-production check.
The Netlify project itself is owned by the `contact@tvc.farm` account (moved there from a
personal account on 2026-07-18).
