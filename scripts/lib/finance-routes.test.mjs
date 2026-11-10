// Run with: node --test scripts/lib/finance-routes.test.mjs
// Netlify only sends a function the paths listed in its `config.path`. The handler tests call the function directly and so skip that
// list: a route that is handled but not declared answers 404 in production (found when the dashboard route was first tried locally).
// This keeps the two in step: every literal route the dispatcher handles must be covered by an exact path or a `/*` prefix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('netlify/functions/finance-admin.mts', 'utf8');
const declared = [...source.slice(source.indexOf('export const config')).matchAll(/'(\/api\/finance-admin[^']*)'/g)].map((m) => m[1]);
const handled = [...new Set([...source.matchAll(/route === '(\/[a-z0-9\-/]+)'/g)].map((m) => `/api/finance-admin${m[1]}`))];
const covered = (path) => declared.some((d) => d === path || (d.endsWith('/*') && path.startsWith(d.slice(0, -1))));

test('the config lists paths at all, and the dispatcher handles routes', () => {
  assert.ok(declared.length > 10);
  assert.ok(handled.length > 10);
});

test('every literal route the dispatcher handles is declared in config.path', () => {
  const missing = handled.filter((p) => !covered(p));
  assert.deepEqual(missing, [], `handled but not declared: ${missing.join(', ')}`);
});

test('the dashboard route is declared', () => {
  assert.ok(covered('/api/finance-admin/dashboard'));
});
