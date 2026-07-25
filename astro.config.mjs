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
    // Content reorg: split "who's part of TVC" (member families, local
    // staff, partners, community outreach) out of About TVC and Our
    // Journey into its own /people section, since neither page was really
    // about those topics - and moved The Design from Our Journey to About
    // TVC, since it's a present-tense description of the farm's layout,
    // not a historical journey milestone. Redirects point straight at the
    // final destination rather than chaining through intermediate stops
    // (e.g. /community-outreach went to /our-journey/community-outreach
    // once already - now goes directly to /people/community-outreach).
    '/community-outreach': '/people/community-outreach',
    '/community-outreach/[slug]': '/people/community-outreach/[slug]',
    '/our-journey/community-outreach': '/people/community-outreach',
    '/our-journey/community-outreach/[slug]': '/people/community-outreach/[slug]',
    '/our-journey/design': '/about/design',
    '/ecosystem/partners': '/people/partners',
    '/ecosystem/partners/[slug]': '/people/partners/[slug]',
  },
});
