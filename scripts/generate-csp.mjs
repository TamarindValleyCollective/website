// Post-build step (see package.json's "build" script, runs after Pagefind
// indexing). Astro inlines each page's non-`is:inline` <script type="module">
// directly into that page's HTML rather than extracting to an external file
// (small per-page bundles aren't worth a separate chunk) - a strict CSP
// script-src can't use 'unsafe-inline' for these without giving up the whole
// point of having a script-src, so instead we hash every distinct inline
// script body actually present in dist/ and allowlist those exact hashes.
// This has to be regenerated on every build: add a page, tweak a script,
// and the hashes change.
//
// Shipped as Content-Security-Policy-Report-Only first (2026-08-21),
// verified live with zero violations across every distinct page type -
// home, Maps/forms (/contact), YouTube (/about/design), the event-page
// interest widget, the biodiversity explorer's dynamically-rendered
// inline-style grid, and both Google Sign-In dashboards (/internal/*).
// Now enforcing. See CHANGELOG/2026-08.md.

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

const scriptSrc = ["'self'", 'https://accounts.google.com', 'https://www.googletagmanager.com', ...hashes].join(' ');

const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://media.tvc.farm",
  "font-src 'self'",
  "connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com https://accounts.google.com",
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
