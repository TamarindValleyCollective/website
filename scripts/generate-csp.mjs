// Post-build step (see package.json's "build" script). Astro inlines each
// page's non-`is:inline` <script type="module">
// directly into that page's HTML rather than extracting to an external file
// (small per-page bundles aren't worth a separate chunk) - a strict CSP
// script-src can't use 'unsafe-inline' for these without giving up the whole
// point of having a script-src, so instead we hash every distinct inline
// script body actually present in dist/ and allowlist those exact hashes.
// This has to be regenerated on every build: add a page, tweak a script,
// and the hashes change.
//
// Shipped as Content-Security-Policy-Report-Only first (2026-08-21), then
// flipped to enforcing the same day. That report-only pass missed two
// client-side fetch() targets that don't show up just from clicking around:
// the biodiversity explorer's live iNaturalist API calls/photos/OSM tiles,
// and the header weather widget's Open-Meteo call (present on every page).
// Both got silently blocked under enforcing (connect-src/img-src violations
// don't throw JS errors you'd notice without checking the console or
// network tab) until fixed here on 2026-08-21. See CHANGELOG/2026-08.md.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIST = new URL('../dist/', import.meta.url).pathname;

async function findHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return findHtmlFiles(full);
      return entry.name.endsWith('.html') ? [full] : [];
    })
  );
  return files.flat();
}

// Matches <script ...> ... </script> blocks that are neither external
// (src=...) nor inert data islands (type="application/json" or
// "application/ld+json" - never executed, so CSP script-src doesn't gate
// them and hashing them would be pure noise).
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:json|ld\+json)")[^>]*>([\s\S]*?)<\/script>/g;

const htmlFiles = await findHtmlFiles(DIST);
const hashes = new Set();

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1];
    if (body.trim() === '') continue;
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.add(`'sha256-${hash}'`);
  }
}

// Microsoft Clarity fans its own load across several subdomains (confirmed
// empirically 2026-09-17, loading the real tag on a page with no CSP and
// watching what it actually requested - the docs don't spell this out):
// www.clarity.ms serves the initial tag script, which loads the real
// bundle from scripts.clarity.ms, which POSTs session data to a collection
// endpoint that isn't even fixed - observed as o.clarity.ms once and
// l.clarity.ms another time from the same code, seemingly load-balanced.
// Wildcarding *.clarity.ms instead of enumerating subdomains one at a time
// as they surface.
const scriptSrc = [
  "'self'",
  'https://accounts.google.com',
  'https://www.googletagmanager.com',
  'https://*.clarity.ms',
  ...hashes,
].join(' ');

const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  // blob: is needed for /internal/photo-pool: it fetches each Drive
  // thumbnail through the authenticated Netlify Function (Drive's
  // thumbnailLink can't be hit directly from the browser) and renders it via
  // URL.createObjectURL(blob) - without blob: here, every thumbnail on that
  // page silently fails to decode (CSP img-src violations don't throw a JS
  // error the way a blocked script would).
  "img-src 'self' data: blob: https://media.tvc.farm https://*.inaturalist.org https://inaturalist-open-data.s3.amazonaws.com https://*.tile.openstreetmap.org",
  "font-src 'self'",
  // GA4's actual runtime hit lands on analytics.google.com (a fallback to
  // stats.g.doubleclick.net too) - not www.google-analytics.com, that's a
  // Universal Analytics-era domain gtag.js doesn't send hits to anymore.
  // Confirmed empirically 2026-09-17: this CSP had allowlisted the wrong
  // domain since it was first enforced (2026-08-21), silently dropping
  // every real visitor's GA hit for almost a month - the site *looked*
  // instrumented (script loads, config fires) but nothing ever reached
  // Google. Wildcarding both, plus keeping the legacy domain, rather than
  // risk narrowing to exactly what one test run happened to hit.
  //
  // That first fix (2026-09-17) still didn't work: `*.analytics.google.com`
  // is a CSP wildcard, and CSP wildcards only match subdomains - never the
  // bare apex domain. The real hit lands on the bare `analytics.google.com`
  // itself, so it kept getting silently dropped even after the "fix".
  // Confirmed 2026-09-19 by triggering a real `securitypolicyviolation`
  // event against it in production. Listing the bare domain explicitly
  // alongside the wildcard, same lesson applied to the google-analytics.com
  // and g.doubleclick.net entries in case a future hit lands on their apex
  // too.
  "connect-src 'self' https://google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://g.doubleclick.net https://*.g.doubleclick.net https://www.googletagmanager.com https://accounts.google.com https://api.inaturalist.org https://api.open-meteo.com https://*.clarity.ms",
  'frame-src https://www.google.com https://www.youtube.com https://accounts.google.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'upgrade-insecure-requests',
].join('; ');

await writeFile(
  join(DIST, '_headers'),
  `/*\n  Content-Security-Policy: ${csp}\n`,
  'utf8'
);

console.log(`Generated dist/_headers with ${hashes.size} inline-script hashes.`);
