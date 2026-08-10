# Tamarind Valley Collective — website

The website for [Tamarind Valley Collective](https://tvc.farm) (TVC), a 100-acre permaculture farm collectively owned by 53 families, regenerating degraded land near Kanakapura since 2017.

This is an Astro rebuild of the original site (previously a [Publii](https://getpublii.com/) static export — that export is kept alongside this project as source material for content and images still being migrated over).

## What's here

- **Static site, a few small serverless exceptions.** Every page is prerendered at build time; content lives in Markdown, not a CMS or database. The exceptions are the chat widget's backend, the event-interest counter, the internal photo-pool dashboard's backend, and the `/contact` enquiry forms' Sheets logging (all below), each a single Netlify Function — the rest of the site has no server at all.
- **Live Biodiversity/Ecosystem explorer** (`/ecosystem`) — fetches sightings client-side from the farm's [iNaturalist project](https://www.inaturalist.org/) on every page load, with filters, a gallery view, and a map view.
- **Site-wide chat widget** (bottom-right on every page, `src/components/ChatWidget.astro` + `netlify/functions/chat.mts`) — answers questions using *only* the website's own content, never general knowledge. `scripts/build-chat-context.mjs` runs after every `astro build`, strips nav/footer boilerplate from the prerendered HTML in `dist/`, and writes the remaining page text to `netlify/functions/site-content.json` (gitignored, regenerated every build). The Function stuffs that whole corpus into the system prompt for each request to the Anthropic API — simple and reliable at this site's size, though it means every request re-sends the full corpus rather than doing retrieval/embeddings, worth revisiting if the site's content grows much larger. Requires an `ANTHROPIC_API_KEY` — see Development below.
- **Site search** (magnifying-glass icon in the nav, or press `/`, `src/components/SiteSearch.astro`) — a client-side full-text search with no backend at all, backed by [Pagefind](https://pagefind.app). `pagefind --site dist` runs as the last step of `npm run build`, indexing every non-`noindex` page's full body content (scoped via `data-pagefind-body` on `BaseLayout.astro`'s `<main>`) into a static, chunked index at `dist/pagefind/`. The search box dynamically imports `/pagefind/pagefind.js` once and searches/excerpts entirely in the browser. Keyboard-navigable (↑/↓/Enter, Escape to close).
- **Year-by-year timeline** (`/our-journey/timeline`, `src/components/JourneyTimelineStandalone.astro`) — nested under Our Journey rather than a top-level nav item: a horizontal "wire" of years that opens a modal with that year's story and a month-by-month photo carousel. Data is grouped into **eras** (currently just one, "Founding," 2017–2026) rather than one flat, ever-lengthening row of years — with a single era the picker never renders and that era's timeline shows directly, but the moment a second era gets real content the era-picker appears automatically and each era becomes its own selectable chapter. Icons are hand-drawn monoline SVGs, not emoji — different emoji glyphs render at inconsistent visual sizes even at the same font-size, which used to throw the row out of alignment.
- **"Friends of TVC" WhatsApp group** (`/contact`) — a direct invite link to the group; no form, no manual step.
- **Membership enquiry form** (bottom of `/join`) and **general enquiry form** (`/contact`, `netlify/functions/enquiry.mts`) — two plain HTML forms (name, email, optional phone, message), each submitted via [Netlify Forms](https://docs.netlify.com/manage/forms/setup/) (`data-netlify="true"` plus a honeypot field) for email — no custom notification rule needed, since Netlify emails the account owner by default on every submission and that owner already is `contact@tvc.farm`. Each form's `<script>` also fires `navigator.sendBeacon` to `/api/enquiry` alongside the native submission, appending a row to that form's own Google Sheet (`MEMBERSHIP_ENQUIRY_SHEET_ID` / `GENERAL_ENQUIRY_SHEET_ID`, shared Editor-access with the same service account photo-pool uses). The general enquiry form also offers a `wa.me` link straight to Madhavan. Both redirect to `/contact/thanks` on success.
- **"Host an Event" inquiry** (`/visit/host-an-event`) — same Netlify Forms pattern as the Friends of TVC signup, for outside groups/organizers pitching their own retreat, workshop, or camp at the farm. Redirects to `/visit/host-an-event/thanks` on success.
- **Visit inquiry** (`/visit/camping`, `/visit/day-visit`, `/visit/trekking-trails`, `src/components/BookingInquiry.astro`) — replaces the old external "Book via Linger" redirect: pricing/inclusions now live on TVC's own pages, and visitors either submit a webform or message a WhatsApp link to express interest. All three pages share one Netlify Form (`visit-inquiry`, with a hidden `type` field noting which page it came from) redirecting to `/visit/thanks`. Dual email notifications (`stay@linger.in` and `contact@tvc.farm`) are set up in the Netlify dashboard under Site configuration → Notifications — that section is separate from Forms (which only has detection settings and submitted entries), and notifications aren't configurable from committed files.
- **"Want this to happen again?" event interest** (past event pages, `src/pages/events/[slug].astro` + `netlify/functions/event-interest.mts`) — a one-click, optional-email widget on every past event that shows a live public count of interest ("N people want this again") and, if an email is given, also submits into Netlify Forms so the farm team gets an actionable, contactable entry. See "Event interest" below.
- **Content collections** for the things that change over time: `events`, `partners`, `community-outreach`, `photos` (see `src/content.config.ts` for schemas).
- **Google Maps / My Maps embeds** for directions and the farm layout, and a YouTube embed for the aerial drone flyover.
- **In Pictures** (`/in-pictures`, `src/components/photos/PhotoGallery.astro`) — the curated photo archive: date and camera-model filter chips (independently combinable), a Grid/Map view toggle (the map reuses the Leaflet + OpenStreetMap setup from the biodiversity explorer, adapted for photo-thumbnail pins — see `src/components/photos/photo-map.ts`), and a lightbox with a Flickr-style EXIF panel (camera, aperture, shutter speed, ISO, focal length) plus a per-photo location map. EXIF/GPS render when present and degrade gracefully when not, since older photos (WhatsApp-forwarded, etc.) typically have none. Images are hosted on Cloudflare R2 (`media.tvc.farm`) rather than committed to the repo — see "Curating new photos" below.

## Adding an upcoming event

Copy `src/content/events/_template.md`, rename it to something like `2026-03-15-your-event-name.md` (the filename becomes the URL), fill in the fields, and delete the `draft: true` line. It'll show up on `/events` on the next build — no code changes needed. Any other new `.md` file in that folder works the same way.

## Curating new photos

Photo selection happens offline (pick the good ones yourself, however you like) — `scripts/curate-photos.mjs` handles the rest:

```sh
node scripts/curate-photos.mjs ./path/to/selected-photos --dry-run   # preview first
node scripts/curate-photos.mjs ./path/to/selected-photos             # extracts EXIF/GPS, uploads to R2, writes content entries
```

Requires R2 credentials in a local `.env` (see `.env.example`) — never committed, and never needed as a Netlify environment variable, since curation runs locally and the site only ever embeds the public `media.tvc.farm` URLs the script produces. Accepts JPEG, PNG, and HEIC/HEIF (iPhone's default format — decoded via `heic-convert`, since `sharp`'s bundled libheif rejects most real iPhone photos outright). Captions come out as a placeholder derived from the filename — review and rewrite them before committing the generated `src/content/photos/*.md` files.

Photos don't have to be hand-picked into a local folder first — staff/partners/volunteers can instead drop them into a shared Google Drive folder and a curator reviews/approves them through a web dashboard (with EXIF/GPS, uploader, and an editable caption) before they ever reach this step. See **[PHOTO-CURATION.md](./PHOTO-CURATION.md)** for that workflow.

## Project structure

```text
/
├── public/                  static assets (images, fonts, PDFs) served as-is
├── src/
│   ├── components/          Nav, Footer, Breadcrumbs, PageHero, JsonLd, ChatWidget, and the biodiversity explorer
│   ├── content/              markdown content collections (events, partners, community-outreach)
│   ├── content.config.ts     collection schemas
│   ├── layouts/               BaseLayout wraps every page (Nav + Breadcrumbs + Footer + ChatWidget + JsonLd + <head>)
│   ├── pages/                 file-based routes
│   └── styles/global.css      design tokens (colors, type, spacing) and shared base styles
├── netlify/functions/         the serverless pieces — chat.mts, event-interest.mts, photo-pool.mts, enquiry.mts
├── scripts/build-chat-context.mjs  post-build step that feeds the chat widget its content
├── (site search's index is built by the `pagefind` CLI itself, run as part of `npm run build`)
├── netlify.toml              Netlify build/functions/dev config
└── astro.config.mjs          includes the /biodiversity -> /ecosystem redirect
```

## Development

```sh
npm install
npm run dev          # starts a dev server at localhost:4321 (add --background to run detached)
npm run build         # builds the static site to ./dist
npm run preview       # serves the build locally to sanity-check before deploying
```

Managing a background dev server: `npm run astro -- dev stop`, `npm run astro -- dev status`, `npm run astro -- dev logs`.

### Chat widget (Netlify Functions + Anthropic API)

The chat widget needs an `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com)):

- **Production:** set it in Netlify's dashboard under Site settings → Environment variables. Never commit a real key.
- **Local testing:** copy `.env.example` to `.env` and fill in the key, then use the [Netlify CLI](https://developers.netlify.com/cli/get-started/) (`npm install -g netlify-cli`) instead of the plain Astro dev server, since `astro dev` alone doesn't run Netlify Functions:
  ```sh
  astro dev --background   # start Astro's own dev server first
  netlify dev               # proxies it and serves the Function alongside it
  ```
  `netlify.toml`'s `[dev]` block points Netlify Dev at the already-running Astro server (`targetPort = 4321`) instead of trying to launch its own, since this project's `astro dev` always daemonizes rather than staying in the foreground.

Without a key set, the widget still works — it just replies with a friendly "chat isn't configured yet" message instead of erroring.

### Event interest (Netlify Functions + Netlify Blobs)

The "Want this to happen again?" widget on past event pages needs no API key or environment
variable — its storage (Netlify Blobs) is auto-provisioned per-site. Same local-testing setup
as the chat widget above (`astro dev --background` then `netlify dev` — plain `astro dev`
won't run either Function); the Netlify CLI emulates Blobs locally automatically.

To reset a specific event's public count and interested-emails list — e.g. once it's actually
been re-run and the demand has been acted on — no code or redeploy needed:

```sh
netlify blobs:delete event-interest <event-id>   # e.g. 2022-12-16-the-lambda-retreat
```

That silently zeroes the count, though — pair it with setting `interestNote` (and optionally
`interestNoteHref`) on that event's frontmatter in `src/content/events/`, which replaces the
widget with a static message instead of continuing to solicit clicks (see the comment on that
field in `src/content.config.ts`).

## Design system

Self-hosted variable fonts: **Fraunces** for display/headings, **Inter** for body/UI text, and **Quicksand** kept only for the nav wordmark next to the logo mark. Brand colors (green, orange, cream) are sampled from the logo and defined as CSS custom properties in `src/styles/global.css`.
