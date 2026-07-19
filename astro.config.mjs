// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://tvc.farm',
  redirects: {
    // Ecosystem and Biodiversity were separate nav items covering the same
    // ground - merged into one page at /ecosystem with the live explorer
    // folded in as its flagship section.
    '/biodiversity': '/ecosystem',
    // Timeline was a top-level nav item and homepage card despite being
    // entirely a child of Our Journey (unlike its sibling /our-journey/design,
    // it wasn't even nested in the URL) - nested it properly and de-listed it
    // as its own "section" so it's reachable only via the Journey page.
    '/timeline': '/our-journey/timeline',
    // Community Outreach was likewise a top-level nav item despite being
    // entirely a child of Our Journey (its own PageHero eyebrow already read
    // "Our Journey") - nested it under /our-journey/ alongside Timeline and
    // The Design, and de-listed it as its own top-level "section".
    '/community-outreach': '/our-journey/community-outreach',
    '/community-outreach/[slug]': '/our-journey/community-outreach/[slug]',
  },
});
