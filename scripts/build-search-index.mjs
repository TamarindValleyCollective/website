// Runs after `astro build`, alongside build-chat-context.mjs. Walks every
// prerendered page in dist/ and writes a small {title, description, url}
// index to dist/search-index.json — a static asset the client-side site
// search (src/components/SiteSearch.astro) fetches once and searches
// entirely in the browser. No backend, no build-time content-collection
// coupling: whatever BaseLayout actually rendered as <title>/<meta
// description> for a page is what becomes searchable for it, the same way
// build-chat-context.mjs treats dist/ as the one source of truth rather
// than re-deriving from src/content or src/pages.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const outFile = path.join(distDir, 'search-index.json');

async function findHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findHtmlFiles(full)));
    } else if (entry.name === 'index.html') {
      files.push(full);
    }
  }
  return files;
}

// Same signal the sitemap integration and every page's own `noindex` prop
// already rely on (see astro.config.mjs's sitemap filter) — pages that
// tell crawlers not to index them (thanks pages, /internal/photo-pool)
// shouldn't be surfaceable through search either.
function extractPage(html, urlPath) {
  const $ = cheerio.load(html);
  if ($('meta[name="robots"][content*="noindex"]').length) return null;

  const rawTitle = $('title').first().text().trim();
  // BaseLayout renders "<page title> · Tamarind Valley Collective" — the
  // site name is implied by being on tvc.farm's own search, so only the
  // page-specific half is useful as a result label.
  const title = rawTitle.split(' · ')[0].trim();
  const description = $('meta[name="description"]').first().attr('content')?.trim() ?? '';
  if (!title) return null;

  return { title, description, url: urlPath };
}

async function main() {
  if (!existsSync(distDir)) {
    console.error('[search-index] dist/ not found — run `astro build` first.');
    process.exit(1);
  }

  const files = await findHtmlFiles(distDir);
  const pages = [];

  for (const file of files) {
    const html = await readFile(file, 'utf-8');
    const urlPath = '/' + path.relative(distDir, file).replace(/index\.html$/, '').replace(/\\/g, '/');
    const page = extractPage(html, urlPath === '/' ? '/' : `/${urlPath.replace(/^\/|\/$/g, '')}/`);
    if (page) pages.push(page);
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));
  await writeFile(outFile, JSON.stringify(pages));

  console.log(`[search-index] wrote ${pages.length} pages to ${path.relative(root, outFile)}`);
}

main();
