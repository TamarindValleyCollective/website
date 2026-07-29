// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://tvc.farm',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'kn', 'ta'],
    // English keeps its existing unprefixed URLs (no redirects, no SEO
    // disruption) - only Kannada/Tamil get a /kn/ or /ta/ prefix.
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      // Excludes the noindex'd pages (see BaseLayout's `noindex` prop) -
      // listing a URL in the sitemap while also telling crawlers not to
      // index it is a mixed signal search engines don't need. /internal/ is
      // the unlinked, secret-gated photo-pool review dashboard.
      filter: (page) => !page.includes('/404') && !page.includes('/thanks') && !page.includes('/internal/'),
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en-IN', kn: 'kn-IN', ta: 'ta-IN' },
      },
    }),
  ],
  redirects: {
    // Ecosystem and Biodiversity were separate nav items covering the same
    // ground - merged into one page at /ecosystem with the live explorer
    // folded in as its flagship section.
    '/biodiversity': '/ecosystem',
    // Timeline was a top-level nav item and homepage card despite being
    // entirely a child of Our Journey (unlike its sibling /our-journey/design,
    // it wasn't even nested in the URL) - nested it properly and de-listed it
    // as its own "section" so it's reachable only via the Journey page. Later
    // folded directly into /our-journey itself (see the comment on
    // JourneyTimelineStandalone.astro) rather than living behind a click, so
    // both old URLs now land on the same page.
    '/timeline': '/our-journey',
    '/our-journey/timeline': '/our-journey',
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
    // Partners never got its own page in the first place: each of the 5
    // partners is only 88-130 words, so the whole listing+detail-page
    // structure (first at /ecosystem/partners, then briefly at
    // /people/partners) was more scaffolding than the content warranted -
    // folded into a single section directly on /people instead, linking
    // straight out to each partner's own site. The two per-partner
    // (/.../[slug]) redirects live in netlify.toml instead of here --
    // Astro's own redirects config requires a dynamic source to redirect
    // to a route with a matching [slug] param, which no longer exists now
    // that individual partner pages are gone; Netlify's redirect rules
    // don't have that restriction.
    '/ecosystem/partners': '/people#partners',
    '/people/partners': '/people#partners',
    // Leftover URLs from the pre-Astro site (Google still has them indexed,
    // and some migrated event content still links to them internally) -
    // point them at their current equivalents instead of 404ing.
    '/how-to-reach.html': '/visit/how-to-reach',
    '/trekking-trails-of-tvc.html': '/visit/trekking-trails',
    '/tvc-3bs-and-1h-dusk-to-dawn-biodiversity-walks-tvc-birdsbutterfliesinsects.html':
      '/events/2022-08-27-3bs-and-1h-biodiversity-walk',
  },
});
