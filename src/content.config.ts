import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const events = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/events' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
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

const products = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/products' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
  }),
});

const partners = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partners' }),
  schema: z.object({
    title: z.string(),
    url: z.string().url().optional(),
    excerpt: z.string(),
    coverImage: z.string().optional(),
  }),
});

export const collections = { events, communityOutreach, products, partners };
