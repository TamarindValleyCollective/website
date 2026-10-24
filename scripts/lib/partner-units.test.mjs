import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCOMMODATION_UNITS } from './accommodation.mjs';

// Until phase 2 moves the admin calendar onto accommodation_units, the farm's
// inventory lives in two places: ACCOMMODATION_UNITS (what the admin tool and
// its tent_id CHECK use) and the seed in migration 0060 (what the partner API
// reads). This keeps them from drifting apart unnoticed.
const sql = readFileSync(new URL('../../supabase/migrations/0060_partner_api_foundation.sql', import.meta.url), 'utf8');
const seed = [...sql.matchAll(/^\s*\('([^']+)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', (\d+), (\d+)\)[,;]/gm)].map((m) => ({
  id: m[1],
  name: m[2],
  shortName: m[3],
  group: m[4],
  kind: m[5],
  capacity: Number(m[6]),
  sortOrder: Number(m[7]),
}));

test('the migration seeds every unit the admin calendar knows, and no others', () => {
  assert.deepEqual(
    seed.map((s) => s.id),
    ACCOMMODATION_UNITS.map((u) => u.id),
  );
});

test('seeded names, capacity, kind and group match the admin inventory', () => {
  for (const u of ACCOMMODATION_UNITS) {
    const s = seed.find((x) => x.id === u.id);
    assert.ok(s, `${u.id} missing from the seed`);
    assert.equal(s.name, u.label, `${u.id} name`);
    assert.equal(s.shortName, u.shortLabel, `${u.id} short name`);
    assert.equal(s.group, u.group, `${u.id} group`);
    assert.equal(s.kind, u.kind, `${u.id} kind`);
    assert.equal(s.capacity, u.capacity, `${u.id} capacity`);
  }
});

test('seeded sort order follows the inventory order', () => {
  assert.deepEqual(
    seed.map((s) => s.sortOrder),
    ACCOMMODATION_UNITS.map((_, i) => i + 1),
  );
});
