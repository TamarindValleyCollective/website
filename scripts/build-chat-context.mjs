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

  for (const file of files) {
    const html = await readFile(file, 'utf-8');
    const urlPath = '/' + path.relative(distDir, file).replace(/index\.html$/, '').replace(/\\/g, '/');
    const page = extractPage(html, urlPath === '/' ? '/' : `/${urlPath.replace(/^\/|\/$/g, '')}`);
    if (page.text) pages.push(page);
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 0));

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  console.log(`[chat-context] wrote ${pages.length} pages (${totalChars.toLocaleString()} chars) to ${path.relative(root, outFile)}`);
}

main();
