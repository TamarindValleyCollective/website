// Run with: node --test scripts/lib/admin-host-routes.test.mjs
//
// admin.tvc.farm serves only the pages and functions listed by name in netlify.toml and sends everything else to the
// admin home (see DOMAINS.md). A new admin page or function that is not listed works on the preview and on netlify dev
// and then silently lands on "Today" in production, which is how the Units screen shipped unreachable. This fails
// until each one is listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const toml = readFileSync('netlify.toml', 'utf8');
const rules = new Set([...toml.matchAll(/^\s*from = "https:\/\/admin\.tvc\.farm(\/[^"]*)"/gm)].map((m) => m[1]));

// Pages: every page under src/pages/internal/ (a .astro file, or a folder of them) except the home page.
const PAGES_DIR = 'src/pages/internal';
const pages = readdirSync(PAGES_DIR)
  .filter((f) => f !== 'index.astro')
  .map((f) => (statSync(`${PAGES_DIR}/${f}`).isDirectory() ? f : f.endsWith('.astro') ? f.replace(/\.astro$/, '') : null))
  .filter(Boolean);

// Functions: those that check a signed-in admin (they import the staff access helpers) are the admin's, whatever they are called.
const FN_DIR = 'netlify/functions';
const adminFunctions = readdirSync(FN_DIR)
  .filter((f) => /\.mts$/.test(f))
  .map((f) => ({ file: f, src: readFileSync(`${FN_DIR}/${f}`, 'utf8') }))
  .filter(({ src }) => /from '\.\/lib\/(staff-access|staff-admin-guard)'/.test(src))
  .map(({ file, src }) => ({ file, segment: src.match(/path:\s*\[?\s*'\/api\/([a-z0-9-]+)/)?.[1] }))
  .filter((f) => f.segment);

test('the page and function scans find something (so the checks below mean something)', () => {
  assert.ok(pages.length >= 8, `found only ${pages.length} pages`);
  assert.ok(adminFunctions.length >= 8, `found only ${adminFunctions.length} admin functions`);
  assert.ok(rules.size > 10);
});

for (const page of pages) {
  test(`admin page "${page}" is served on admin.tvc.farm`, () => {
    assert.ok(rules.has(`/${page}/*`), `add a rule for https://admin.tvc.farm/${page}/* in netlify.toml (and list it in DOMAINS.md)`);
  });
}

for (const { file, segment } of adminFunctions) {
  test(`admin function ${file} is reachable on admin.tvc.farm`, () => {
    assert.ok(rules.has(`/api/${segment}/*`), `add a rule for https://admin.tvc.farm/api/${segment}/* in netlify.toml (and list it in DOMAINS.md)`);
  });
}
