// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import rehypeExternalLinks from 'rehype-external-links';

// https://astro.build/config
export default defineConfig({
  // DEPLOY_PRIME_URL is set by Netlify at build time - the production
  // domain on a production build, but the deploy-preview/branch-deploy
  // subdomain on those builds. Without this, canonical URLs and og:image
  // always pointed at production even on a preview deploy, so a freshly
  // added image (not live on production yet) 404'd when WhatsApp's crawler
  // tried to fetch it there - iMessage's link-preview generator tolerates
  // that failure by falling back to scraping the actual page, but WhatsApp
  // just gives up and shows the site's apple-touch-icon instead. Falls back
  // to the real domain for local dev, where this env var doesn't exist.
  site: process.env.DEPLOY_PRIME_URL || 'https://tvc.farm',
  // Every external link across the site's markdown content (event recaps,
  // outreach pages, etc.) should open in a new tab rather than navigating
  // away from tvc.farm - applied here once at the markdown-rendering level
  // instead of per-link, since dozens of existing pages already have plain
  // `[text](url)` links with no way to set target/rel individually.
  markdown: {
    rehypePlugins: [[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]],
  },
  vite: {
    plugins: [
      // /pagefind/pagefind.js only exists after `pagefind --site dist` runs
      // post-build (see package.json and SiteSearch.astro's loadPagefind) -
      // in `astro dev` there's nothing at that URL, and Vite's dev-server-
      // level error reporting for a failed dev request fires regardless of
      // the app's own try/catch around the dynamic import, throwing a
      // full-page HMR overlay on top of whatever page you're looking at
      // (reported 2026-08-13: made the footer "invisible" mid-review,
      // nothing to do with the footer itself). `apply: 'serve'` scopes this
      // stub to `astro dev` only - `astro build` never sees this plugin, so
      // the real generated pagefind.js is untouched in production.
      {
        name: 'stub-pagefind-in-dev',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/pagefind/pagefind.js') {
              res.setHeader('Content-Type', 'application/javascript');
              res.end('export async function search(){return {results:[]};}\nexport async function options(){}\n');
              return;
            }
            next();
          });
        },
      },
    ],
  },
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
      // the unlinked, secret-gated photo-pool review dashboard; story-guide
      // is the unlinked member-form walkthrough, reachable only by direct
      // link (see src/pages/people/members/story-guide.astro).
      filter: (page) => !page.includes('/404') && !page.includes('/thanks') && !page.includes('/internal/') && !page.includes('/story-guide'),
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en-IN', kn: 'kn-IN', ta: 'ta-IN' },
      },
    }),
  ],
  // All legacy-URL redirects (ecosystem/biodiversity split, the /people
  // reorg, pre-Astro .html URLs, etc.) live in netlify.toml, not here.
  // This project has no SSR adapter (static output), and Astro's own
  // `redirects` config in static output doesn't produce a real HTTP
  // redirect - it emits a static page with a client-side meta-refresh, a
  // `noindex` tag, and a canonical link. Google can keep surfacing that
  // 200-status stub (title: "Redirecting to: ...") in search results for
  // a long time before it honors the weak signal and drops it - which is
  // exactly the "dead link" symptom this was meant to fix in the first
  // place (see the 2026-07-29 changelog entry). A real 301 in
  // netlify.toml gets Google to consolidate onto the new URL fast.
});
