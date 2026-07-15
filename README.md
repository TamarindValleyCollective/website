# Tamarind Valley Collective — website

The website for [Tamarind Valley Collective](https://tvc.farm) (TVC), a 100-acre permaculture farm collectively owned by 53 families, regenerating degraded land near Kanakapura since 2017.

This is an Astro rebuild of the original site (previously a [Publii](https://getpublii.com/) static export — that export is kept alongside this project as source material for content and images still being migrated over).

## What's here

- **Static, no backend.** Every page is prerendered at build time; content lives in Markdown, not a CMS or database.
- **Live Biodiversity/Ecosystem explorer** (`/ecosystem`) — fetches sightings client-side from the farm's [iNaturalist project](https://www.inaturalist.org/) on every page load, with filters, a gallery view, and a map view.
- **Year-by-year timeline** (`/timeline`, `src/components/JourneyTimelineStandalone.astro`) — a standalone, single-viewport page: a horizontal "wire" of years that opens a modal with that year's story and a month-by-month photo carousel. Data is grouped into **eras** (currently just one, "Founding," 2017–2026) rather than one flat, ever-lengthening row of years — with a single era the picker never renders and that era's timeline shows directly, but the moment a second era gets real content the era-picker appears automatically and each era becomes its own selectable chapter. Icons are hand-drawn monoline SVGs, not emoji — different emoji glyphs render at inconsistent visual sizes even at the same font-size, which used to throw the row out of alignment.
- **Content collections** for the things that change over time: `events`, `partners`, `products`, `community-outreach` (see `src/content.config.ts` for schemas).
- **Google Maps / My Maps embeds** for directions and the farm layout, and a YouTube embed for the aerial drone flyover.
- **In Pictures** (`/in-pictures`) — a photo archive plus a link to the community-maintained Google Photos album for anything more recent (Google Photos albums can't be iframed — they send `X-Frame-Options: SAMEORIGIN` — so that's a link-out card, not an embed).

## Adding an upcoming event

Copy `src/content/events/_template.md`, rename it to something like `2026-03-15-your-event-name.md` (the filename becomes the URL), fill in the fields, and delete the `draft: true` line. It'll show up on `/events` on the next build — no code changes needed. Any other new `.md` file in that folder works the same way.

## Project structure

```text
/
├── public/                  static assets (images, fonts, PDFs) served as-is
├── src/
│   ├── components/          Nav, Footer, PageHero, Pending, and the biodiversity explorer
│   ├── content/              markdown content collections (events, partners, products, community-outreach)
│   ├── content.config.ts     collection schemas
│   ├── layouts/               BaseLayout wraps every page (Nav + Footer + <head>)
│   ├── pages/                 file-based routes
│   └── styles/global.css      design tokens (colors, type, spacing) and shared base styles
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

## Design system

Self-hosted variable fonts: **Fraunces** for display/headings, **Inter** for body/UI text, and **Quicksand** kept only for the nav wordmark next to the logo mark. Brand colors (green, orange, cream) are sampled from the logo and defined as CSS custom properties in `src/styles/global.css`.
