// Run with: node --test scripts/lib/finance-badge-logos.test.mjs
// Every logo the badge migrations point at must exist under public/, be a small image, and (for an SVG) carry no script or
// outside reference: these files are served from our own origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const migrations = readdirSync('supabase/migrations').filter((f) => /finance_(source_badges|badge_logos)\.sql$/.test(f));
const paths = [...new Set(migrations.flatMap((f) => [...readFileSync(join('supabase/migrations', f), 'utf8').matchAll(/logo_url\s*=\s*'([^']+)'/g)].map((m) => m[1])))];

test('the badge migrations point at at least one logo', () => {
  assert.ok(paths.length >= 4);
});

test('every logo path exists under public/finance-badges and is a small file', () => {
  for (const p of paths) {
    assert.match(p, /^\/finance-badges\/[a-z0-9_-]+\.(svg|png)$/, p);
    const file = join('public', p);
    assert.ok(existsSync(file), `${p} is missing`);
    assert.ok(statSync(file).size < 50_000, `${p} is larger than 50 KB`);
  }
});

test('an SVG logo has no script, event handler or outside reference', () => {
  for (const p of paths.filter((x) => x.endsWith('.svg'))) {
    const svg = readFileSync(join('public', p), 'utf8');
    assert.ok(!/<script|<foreignObject|<image|\son[a-z]+\s*=|(href|src)\s*=\s*["']https?:/i.test(svg), `${p} has active or external content`);
  }
});
