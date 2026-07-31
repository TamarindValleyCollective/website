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
  }),
});

const partners = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partners' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
    // Full markdown body is the expanded partner profile, rendered on the
    // shared /people/partners listing page (PartnersIndexView.astro) - one
    // page for all partners rather than a route per partner, since there
    // are only 5 of them. `excerpt` is just the short card/teaser copy used
    // on /people; `url` is the partner's own site, linked as a secondary CTA
    // rather than the card's main click target.
    url: z.string().url(),
    // Kannada/Tamil translations (AI-drafted, pending native-speaker review
    // - see TRANSLATIONS_REVIEW.md). Optional so a partner card renders
    // fine on the English fallback until these are filled in.
    title_kn: z.string().optional(),
    excerpt_kn: z.string().optional(),
    title_ta: z.string().optional(),
    excerpt_ta: z.string().optional(),
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
