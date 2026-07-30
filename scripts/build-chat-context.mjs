// Runs after `astro build`. Walks every prerendered page in dist/, strips
// nav/footer/script/style boilerplate that repeats on every page, and
// extracts the remaining visible text into one JSON corpus that the chat
// Netlify Function stuffs into its system prompt. This is what makes the
// chatbot only able to answer from the site's own content — it doesn't
// have any information beyond what's in this file.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'netlify', 'functions');
const outFile = path.join(outDir, 'site-content.json');

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

function extractPage(html, urlPath) {
  const $ = cheerio.load(html);
  $('script, style, nav.nav, footer.footer, noscript, svg').remove();

  const title = $('title').first().text().trim();
  const main = $('main').first();
  const text = (main.length ? main : $('body'))
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  return { url: urlPath, title, text };
}

async function main() {
  if (!existsSync(distDir)) {
    console.error('[chat-context] dist/ not found — run `astro build` first.');
    process.exit(1);
  }

  const files = await findHtmlFiles(distDir);
  const pages = [];

  // Kannada/Tamil pages (see src/i18n) live under /kn/ and /ta/ and hold the
  // same content as their English original, just translated - the chat
  // system prompt already tells the model to answer in whatever language the
  // visitor wants regardless of the corpus's own language, so indexing all
  // three locale copies would only triple the corpus (and the per-request
  // token bill) for zero extra grounding. Only the default-locale (English,
  // unprefixed) pages are needed here.
  const NON_DEFAULT_LOCALE_PREFIXES = ['/kn', '/ta'];
  const isNonDefaultLocalePage = (urlPath) =>
    NON_DEFAULT_LOCALE_PREFIXES.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`));

  for (const file of files) {
    const html = await readFile(file, 'utf-8');
    const urlPath = '/' + path.relative(distDir, file).replace(/index\.html$/, '').replace(/\\/g, '/');
    const normalizedPath = urlPath === '/' ? '/' : `/${urlPath.replace(/^\/|\/$/g, '')}`;
    if (isNonDefaultLocalePage(normalizedPath)) continue;
    const page = extractPage(html, normalizedPath);
    if (page.text) pages.push(page);
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 0));

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  console.log(`[chat-context] wrote ${pages.length} pages (${totalChars.toLocaleString()} chars) to ${path.relative(root, outFile)}`);
}

main();
