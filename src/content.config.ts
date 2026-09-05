import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const events = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/events' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    // Multi-day events only - the event runs from `date` through `endDate`
    // inclusive. Omit for single-day events.
    endDate: z.coerce.date().optional(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
    // Describes what's actually in the photo/poster, for the <img> alt
    // attribute - falls back to the event title (see EventsIndexView /
    // EventDetailView) when not set, same as before this field existed.
    coverImageAlt: z.string().optional(),
    organizer: z.string().optional(),
    tags: z.array(z.string()).default([]),
    // Groups editions of the same recurring event under one visual identity
    // (see EventDetailView / EventsIndexView / PageHero) - a slug like
    // "3bs1h", not a display name. Omit for one-off events; unrelated to
    // `tags`, which is for topical filtering, not series grouping.
    series: z.string().optional(),
    // The authoritative edition number for a `series` entry - not inferred
    // from title text, which drifts (existing 3bs1h files disagree on
    // whether/how they state their own edition number). Also used to build
    // that series' versioned URL, e.g. /events/3bs1h/5 (see
    // src/pages/events/3bs1h/[edition].astro). Omit for one-off events.
    edition: z.number().int().positive().optional(),
    // Lets a placeholder/template event file sit in this folder without
    // showing up on the site - flip to false (or delete the line) once the
    // real details are filled in. See _template.md in this collection.
    draft: z.boolean().default(false),
    // Closes the loop on a past event's "Want this to happen again?" widget
    // (see [slug].astro) once the demand it captured has actually been
    // acted on - set this and the widget is replaced by this note instead
    // of continuing to solicit clicks for a need that's already been met.
    // Plain text (not markdown) - pair with interestNoteHref to make it a
    // link, e.g. pointing at the new event. The interest count itself
    // lives in Netlify Blobs, not here - resetting it is a separate step
    // (see netlify/functions/event-interest.mts).
    interestNote: z.string().optional(),
    interestNoteHref: z.string().optional(),
  }),
});

const communityOutreach = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/community-outreach' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
    coverImageAlt: z.string().optional(),
    // For entries with no real copy yet (see issue #12) - excluded from the
    // index listing and given no route, rather than shipping the
    // placeholder body text as if it were real content.
    draft: z.boolean().optional(),
  }),
});

const partners = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partners' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
    // The markdown body is each partner's general write-up (who they are,
    // what they do in the world), rendered on /people/partners (see
    // PartnersView.astro) - /people itself just teases the section with a
    // link. A dedicated per-partner page was tried and dropped once already
    // for being more scaffolding than 88-130 words of content warranted
    // (see astro.config.mjs's /ecosystem/partners redirect comment); this
    // is a single listing page with real write-ups, not a return to that
    // per-partner structure. Ananas is the one deliberate exception - see
    // src/pages/people/partners/ananas.astro - a hand-authored page (not a
    // collection entry) added because that partner's actual project archive
    // turned out to be worth a lot more than 88-130 words; it isn't a
    // reopening of this collection's per-partner pattern.
    url: z.string().url(),
    // The one-line "what they actually do with TVC" fact, kept separate
    // from the general body above and rendered as its own callout on
    // /people/partners - burying it as the last sentence of a paragraph
    // made it easy to miss. May contain simple inline HTML (e.g. a link),
    // rendered with set:html like AboutView's inline prose links.
    tvcConnection: z.string(),
    // Kannada/Tamil translations (AI-drafted, pending native-speaker review
    // - see TRANSLATIONS_REVIEW.md). Optional so a partner card renders
    // fine on the English fallback until these are filled in.
    title_kn: z.string().optional(),
    excerpt_kn: z.string().optional(),
    tvcConnection_kn: z.string().optional(),
    title_ta: z.string().optional(),
    excerpt_ta: z.string().optional(),
    tvcConnection_ta: z.string().optional(),
  }),
});

// Curated offline: scripts/curate-photos.mjs reads a folder of selected
// originals, extracts EXIF/GPS, uploads display + thumbnail sizes to R2, and
// writes one entry per photo here. Photos with no EXIF (stripped by
// WhatsApp forwarding, older imports, etc.) simply omit camera/exif/gps -
// the page is expected to degrade gracefully rather than require them.
const photos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/photos' }),
  schema: z.object({
    src: z.string(),
    thumbSrc: z.string().optional(),
    caption: z.string(),
    // Kannada/Tamil translations (AI-drafted, pending native-speaker review
    // - see TRANSLATIONS_REVIEW.md). Optional so a caption falls back to
    // English until these are filled in.
    caption_kn: z.string().optional(),
    caption_ta: z.string().optional(),
    takenAt: z.coerce.date(),
    width: z.number().optional(),
    height: z.number().optional(),
    gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
    camera: z.object({ make: z.string(), model: z.string(), lens: z.string().optional() }).optional(),
    exif: z.object({
      aperture: z.string().optional(),
      shutterSpeed: z.string().optional(),
      iso: z.string().optional(),
      focalLength: z.string().optional(),
    }).optional(),
  }),
});

export const collections = { events, communityOutreach, partners, photos };
