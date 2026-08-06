# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: prospective visitors deciding whether to camp, day-visit, trek, or attend an event at
the farm — their core job is finding pricing/inclusions and submitting a booking/enquiry, or
messaging via WhatsApp. Secondary audiences the site also serves: prospective members
considering joining the 53-family collective, event attendees looking up upcoming/past events,
outside groups pitching a retreat/workshop ("Host an Event"), and the general public/researchers
interested in the farm's ecosystem, biodiversity, and permaculture story.

## Product Purpose

The website for Tamarind Valley Collective (TVC), a 100-acre permaculture farm collectively
owned by 53 families, regenerating degraded land near Kanakapura since 2017. It informs
visitors and prospective members about the farm, and converts visit/event/membership interest
into bookings and enquiries.

## Positioning

A working, collectively-owned regenerative farm (not a resort or a single-owner retreat) that
opens its land to camping, day visits, treks, and events, and documents its own ecosystem
(iNaturalist-backed biodiversity data) as evidence of the regeneration it claims.

## Operating Context

Static Astro site, prerendered at build time; content lives in Markdown content collections
(`events`, `partners`, `community-outreach`, `photos`), not a CMS or database. A few narrow
serverless exceptions (Netlify Functions): the chat widget, the event-interest counter, the
internal photo-pool dashboard, and the `/contact` and visit-inquiry forms' Sheets logging.
Visit/camping/day-visit/trekking/host-an-event/membership/general enquiries all submit through
plain Netlify Forms (name, email, optional phone, message) with email notification to
`contact@tvc.farm`, redirecting to a `/…/thanks` page — this is the durable pattern for any new
enquiry surface, not a custom booking system. A "Friends of TVC" WhatsApp group is offered as a
no-form alternative on `/contact`. i18n: pages exist under `/kn` and `/ta` alongside the
default-locale pages (legal pages — Privacy/Terms/Refund/404 — are intentionally excluded from
localization).

## Capabilities and Constraints

- No online payment/checkout on the site; Razorpay is used only for payment links, tracked in
  `RAZORPAY.md`.
- Photos are hosted on Cloudflare R2 (`media.tvc.farm`), never committed to the repo; captions
  and EXIF/GPS come from an offline curation script or a web-based photo-pool dashboard.
- The chat widget answers only from the site's own prerendered content (no general knowledge),
  fed by a post-build corpus dump — not retrieval/embeddings.
- Site search is fully client-side (no backend), built from prerendered `<title>`/meta tags.
- The `/ecosystem` explorer fetches live sightings client-side from the farm's iNaturalist
  project on every page load; it is not editorial content maintained in the repo.

## Brand Commitments

Name: Tamarind Valley Collective (TVC), also referenced by its domain, tvc.farm. Self-hosted
variable fonts: Fraunces (display/headings), Inter (body/UI text), Quicksand (nav wordmark only,
next to the logo mark). Brand colors (green, orange, cream) are sampled from the logo and
defined as CSS custom properties in `src/styles/global.css`.

## Evidence on Hand

Real content already in the repo: event listings (`src/content/events`), partner listings
(`src/content/partners`), community-outreach entries, and a curated photo archive
(`src/content/photos`) with real EXIF/GPS where available. Live biodiversity/sightings data comes
from the farm's actual iNaturalist project, not fabricated. No testimonials, press, or
third-party case studies currently exist on the site — future work must not invent them.

## Product Principles

- The farm's own operating reality (collective ownership, regeneration since 2017, an actual
  ecosystem visitors can verify via live iNaturalist data) is the site's core credibility asset —
  don't dilute it with generic retreat/resort framing.
- Every enquiry surface converges on the same lightweight pattern: a plain Netlify Form plus an
  optional WhatsApp link, never a custom multi-step booking flow.
- Content changes (events, partners, photos) should stay editable via Markdown files, not require
  code changes.
- Localization (kn/ta) covers visitor-facing informational and enquiry pages; legal pages stay
  English-only by design.
