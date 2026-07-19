# Tamarind Valley Collective — website

The website for [Tamarind Valley Collective](https://tvc.farm) (TVC), a 100-acre permaculture farm collectively owned by 53 families, regenerating degraded land near Kanakapura since 2017.

This is an Astro rebuild of the original site (previously a [Publii](https://getpublii.com/) static export — that export is kept alongside this project as source material for content and images still being migrated over).

## What's here

- **Static site, one small serverless exception.** Every page is prerendered at build time; content lives in Markdown, not a CMS or database. The one exception is the chat widget's backend (below), a single Netlify Function — the rest of the site has no server at all.
- **Live Biodiversity/Ecosystem explorer** (`/ecosystem`) — fetches sightings client-side from the farm's [iNaturalist project](https://www.inaturalist.org/) on every page load, with filters, a gallery view, and a map view.
- **Site-wide chat widget** (bottom-right on every page, `src/components/ChatWidget.astro` + `netlify/functions/chat.mts`) — answers questions using *only* the website's own content, never general knowledge. `scripts/build-chat-context.mjs` runs after every `astro build`, strips nav/footer boilerplate from the prerendered HTML in `dist/`, and writes the remaining page text to `netlify/functions/site-content.json` (gitignored, regenerated every build). The Function stuffs that whole corpus into the system prompt for each request to the Anthropic API — simple and reliable at this site's size, though it means every request re-sends the full corpus rather than doing retrieval/embeddings, worth revisiting if the site's content grows much larger. Requires an `ANTHROPIC_API_KEY` — see Development below.
- **Year-by-year timeline** (`/our-journey/timeline`, `src/components/JourneyTimelineStandalone.astro`) — nested under Our Journey rather than a top-level nav item: a horizontal "wire" of years that opens a modal with that year's story and a month-by-month photo carousel. Data is grouped into **eras** (currently just one, "Founding," 2017–2026) rather than one flat, ever-lengthening row of years — with a single era the picker never renders and that era's timeline shows directly, but the moment a second era gets real content the era-picker appears automatically and each era becomes its own selectable chapter. Icons are hand-drawn monoline SVGs, not emoji — different emoji glyphs render at inconsistent visual sizes even at the same font-size, which used to throw the row out of alignment.
- **"Friends of TVC" signup** (`/contact`) — a plain HTML form (name + phone number, no email/newsletter) submitted via [Netlify Forms](https://docs.netlify.com/manage/forms/setup/) (`data-netlify="true"` plus a honeypot field), so it only actually works once deployed on Netlify. Submissions get added to the "Friends of TVC" WhatsApp group by hand. Redirects to `/contact/thanks` on success.
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

Requires R2 credentials in a local `.env` (see `.env.example`) — never committed, and never needed as a Netlify environment variable, since curation runs locally and the site only ever embeds the public `media.tvc.farm` URLs the script produces. JPEG/PNG only for now (convert HEIC first). Captions come out as a placeholder derived from the filename — review and rewrite them before committing the generated `src/content/photos/*.md` files.

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
├── netlify/functions/chat.mts  the one serverless piece — see "Chat widget" below
├── scripts/build-chat-context.mjs  post-build step that feeds the chat widget its content
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

## Design system

Self-hosted variable fonts: **Fraunces** for display/headings, **Inter** for body/UI text, and **Quicksand** kept only for the nav wordmark next to the logo mark. Brand colors (green, orange, cream) are sampled from the logo and defined as CSS custom properties in `src/styles/global.css`.
