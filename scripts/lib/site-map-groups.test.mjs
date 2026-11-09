// Run with: node --test scripts/lib/site-map-groups.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectGroups, groupKey, savedFor, sharesWall } from './site-map-groups.mjs';

const layout = JSON.parse(readFileSync(new URL('../../docs/site-map/layout-frozen-2026-10-29.json', import.meta.url), 'utf8'));
const PAGE = { H1A: 'H1-A', H1B: 'H1-B', H2: 'H2' };
const units = Object.entries(layout.homes).map(([houseNo, h]) => ({ houseNo, cluster: PAGE[h.cluster], shape: h.type, x: h.x, y: h.y, rotation: h.rotation, mirrorX: h.mirrorX, mirrorY: h.mirrorY }));
const baseSizes = Object.fromEntries(Object.entries(layout.baseSize).map(([k, v]) => [PAGE[k], v]));
const short = (groups) => groups.map((g) => `${g.cluster} ${g.houses.map((h) => h.slice(2)).join(' ')}`);

test('the homes that share walls on the frozen layout fall into the groups Sharath confirmed', () => {
  const groups = short(detectGroups(units, baseSizes));
  for (const expected of ['H1-A 16 17 18 19 20 21', 'H1-A 27 28 29 30 31', 'H1-A 23 24 25 26', 'H1-A 22', 'H1-A 32',
    'H1-B 33 34 35 36 37', 'H1-B 38 39 40 41 42', 'H1-B 44 45', 'H1-B 46 47', 'H1-B 48 49', 'H1-B 51 52', 'H1-B 43', 'H1-B 50',
    'H2 11 12 13 14 15', 'H2 06 07 08 09', 'H2 03 04 05', 'H2 01 02', 'H2 10']) assert.ok(groups.includes(expected), expected);
  assert.equal(groups.length, 18);
});

test('every home is in exactly one group and groups never cross a plan page', () => {
  const groups = detectGroups(units, baseSizes);
  const all = groups.flatMap((g) => g.houses);
  assert.equal(all.length, units.length);
  assert.equal(new Set(all).size, units.length);
  for (const g of groups) assert.ok(g.houses.every((h) => units.find((u) => u.houseNo === h).cluster === g.cluster));
});

test('a group is keyed by its page and lowest house number', () => {
  assert.equal(groupKey('H1-B', ['H-37', 'H-33', 'H-35']), 'H1-B:H-33');
  assert.ok(detectGroups(units, baseSizes).some((g) => g.key === 'H1-B:H-33'));
});

test('sharesWall wants parallel walls on one line with a real overlap', () => {
  const sq = (x, y, s = 20) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  assert.ok(sharesWall(sq(0, 0), sq(20, 0))); // side by side, touching
  assert.ok(sharesWall(sq(0, 0), sq(22, 5))); // a small gap, partly alongside
  assert.ok(!sharesWall(sq(0, 0), sq(40, 0))); // a gap too wide
  assert.ok(!sharesWall(sq(0, 0), sq(20, 19.5, 20).map(([x, y]) => [x, y + 0]))); // only corners meet: overlap under 6
});

test('a saved alignment follows its group when the lowest house number changes, but not a different group', () => {
  const rows = [{ key: 'H1-B:H-33', houses: ['H-33', 'H-34', 'H-35', 'H-36', 'H-37'] }, { key: 'H1-B:H-50', houses: ['H-50'] }];
  assert.equal(savedFor({ houses: ['H-34', 'H-35', 'H-36', 'H-37'] }, rows)?.key, 'H1-B:H-33');
  assert.equal(savedFor({ houses: ['H-50'] }, rows)?.key, 'H1-B:H-50');
  assert.equal(savedFor({ houses: ['H-38', 'H-39'] }, rows), null);
  assert.equal(savedFor({ houses: ['H-33', 'H-70', 'H-71', 'H-72', 'H-73'] }, rows), null); // a different group that borrowed one home
});
