// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  redirects: {
    // Ecosystem and Biodiversity were separate nav items covering the same
    // ground - merged into one page at /ecosystem with the live explorer
    // folded in as its flagship section.
    '/biodiversity': '/ecosystem',
  },
});
