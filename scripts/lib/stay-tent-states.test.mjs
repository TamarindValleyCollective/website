// Run with: node --test scripts/lib/stay-tent-states.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { unitStates, tentSummary } from './stay-tent-states.mjs';

const u = (id, extra = {}) => ({ id, label: `${id} full`, shortLabel: id, group: 'G', capacity: 2, manager: 'tvc', status: 'rentable', ...extra });
const units = [u('A'), u('B'), u('C'), u('D'), u('K', { ignoresFarmClosure: true, capacity: 0 }), u('M', { manager: 'member', capacity: 4 }), u('X', { status: 'offboarded' })];
const bk = (id, type, startDate, nights, tentIds, extra = {}) => ({ id, type, startDate, nights, tents: tentIds.map((tentId) => ({ tentId, guests: [] })), ...extra });
const kinds = (states) => Object.fromEntries(states.map((s) => [s.unit.id, s.k]));

test('arriving, staying, leaving and free on one day', () => {
  const bookings = [bk('a', 'casual-stay', '2026-11-06', 2, ['A']), bk('b', 'casual-stay', '2026-11-04', 4, ['B']), bk('c', 'casual-stay', '2026-11-04', 2, ['C'])]; // C ends 6th
  assert.deepEqual(kinds(unitStates(units, bookings, '2026-11-06')), { A: 'arriving', B: 'staying', C: 'leaving', D: 'free', K: 'free', M: 'member' });
});

test('the check-out day is not a night: a stay ending today leaves the tent free tonight', () => {
  const bookings = [bk('a', 'casual-stay', '2026-11-04', 2, ['A'])];
  assert.equal(kinds(unitStates(units, bookings, '2026-11-06')).A, 'leaving');
  assert.equal(kinds(unitStates(units, bookings, '2026-11-07')).A, 'free');
  assert.equal(kinds(unitStates(units, bookings, '2026-11-05')).A, 'staying');
});

test('one stay ending and another starting the same day is a turnover, and both are kept', () => {
  const bookings = [bk('out', 'casual-stay', '2026-11-04', 4, ['A']), bk('in', 'casual-stay', '2026-11-08', 2, ['A'])];
  const a = unitStates(units, bookings, '2026-11-08').find((s) => s.unit.id === 'A');
  assert.equal(a.k, 'turnover');
  assert.equal(a.booking.id, 'in');
  assert.equal(a.leaving.id, 'out');
});

test('a tent closure shows as closed with its reason, and ends cleanly (no "leaving")', () => {
  const bookings = [bk('c', 'unit-closure', '2026-11-05', 3, ['A'], { label: 'Roof repair' })];
  const closed = unitStates(units, bookings, '2026-11-06').find((s) => s.unit.id === 'A');
  assert.equal(closed.k, 'closed');
  assert.equal(closed.why, 'Roof repair');
  assert.equal(closed.booking.id, 'c');
  assert.equal(kinds(unitStates(units, bookings, '2026-11-08')).A, 'free'); // not "leaving": nothing to clean
});

test('a whole-farm closure shuts every unit except the ones set to stay open', () => {
  const bookings = [bk('f', 'farm-closure', '2026-11-10', 2, [], { note: 'Farm on Vacation' })];
  const k = kinds(unitStates(units, bookings, '2026-11-11'));
  assert.deepEqual([k.A, k.B, k.C, k.D, k.K], ['closed', 'closed', 'closed', 'closed', 'free']);
  assert.equal(unitStates(units, bookings, '2026-11-11').find((s) => s.unit.id === 'A').why, 'Farm on Vacation');
  assert.equal(kinds(unitStates(units, bookings, '2026-11-12')).A, 'free');
});

test('a member-run unit is "member" when empty and shows its booking when not; offboarded units are left out', () => {
  assert.equal(unitStates(units, [], '2026-11-06').some((s) => s.unit.id === 'X'), false);
  const bookings = [bk('m', 'member-stay', '2026-11-06', 1, ['M'])];
  assert.equal(kinds(unitStates(units, bookings, '2026-11-06')).M, 'arriving');
});

test('a stay spanning a month boundary is still "staying"', () => {
  const bookings = [bk('a', 'casual-stay', '2026-10-30', 4, ['A'])];
  assert.equal(kinds(unitStates(units, bookings, '2026-11-01')).A, 'staying');
  assert.equal(kinds(unitStates(units, bookings, '2026-11-03')).A, 'leaving');
});

test('the summary counts the farm\'s own open tents, and the beds still free', () => {
  const bookings = [bk('a', 'casual-stay', '2026-11-06', 2, ['A']), bk('b', 'casual-stay', '2026-11-04', 4, ['B']), bk('c', 'casual-stay', '2026-11-04', 2, ['C']), bk('z', 'unit-closure', '2026-11-05', 3, ['D'], { label: 'Repair' })];
  const s = tentSummary(unitStates(units, bookings, '2026-11-06'));
  // open = A, B, C, K (D is closed, M is member-run): in use = A, B. Free tonight = C (leaving) and K.
  assert.deepEqual(s, { total: 4, inUse: 2, free: ['C', 'K'], freeBeds: 2 });
});
