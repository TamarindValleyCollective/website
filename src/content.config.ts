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
    organizer: z.string().optional(),
    tags: z.array(z.string()).default([]),
    // Lets a placeholder/template event file sit in this folder without
    // showing up on the site - flip to false (or delete the line) once the
    // real details are filled in. See _template.md in this collection.
    draft: z.boolean().default(false),
  }),
});

const communityOutreach = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/community-outreach' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
  }),
});

const partners = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partners' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
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
