// Run with: node --test scripts/lib/stay-capacity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOffered, capacityOn, nightIndex, levelOf, capacityRows, monthCells, findSpace } from './stay-capacity.mjs';

const unit = (id, type, extra = {}) => ({ id, type, status: 'rentable', manager: 'tvc', ...extra });
const units = [unit('A', 'tent'), unit('B', 'tent'), unit('C', 'tent'), unit('D', 'tent'), unit('H', 'hut'), unit('P', '2bhk', { manager: 'member', requestMode: 'reject' })];
const types = [{ id: 'tent', label: 'Tents' }, { id: 'hut', label: 'Bamboo huts' }, { id: '2bhk', label: '2 BHK' }];
const stay = (id, startDate, nights, tentIds, type = 'casual-stay') => ({ id, type, startDate, nights, tents: tentIds.map((tentId) => ({ tentId, guests: [] })) });

test('a unit turning requests away or paused is not on offer', () => {
  assert.equal(isOffered(units[0]), true);
  assert.equal(isOffered(units[5]), false);
  assert.equal(isOffered(unit('X', 'tent', { status: 'paused' })), false);
});

test('free counts drop on the nights a stay holds a tent, not on the check-out day', () => {
  const index = nightIndex([stay('1', '2026-11-05', 2, ['A', 'B'])]);
  assert.deepEqual(capacityOn(units, index, '2026-11-04', ['tent']), { free: 4, total: 4 });
  assert.deepEqual(capacityOn(units, index, '2026-11-05', ['tent']), { free: 2, total: 4 });
  assert.deepEqual(capacityOn(units, index, '2026-11-06', ['tent']), { free: 2, total: 4 });
  assert.deepEqual(capacityOn(units, index, '2026-11-07', ['tent']), { free: 4, total: 4 });
});

test('a tent closure holds its tent like a stay', () => {
  const index = nightIndex([stay('c', '2026-11-05', 1, ['C'], 'unit-closure')]);
  assert.equal(capacityOn(units, index, '2026-11-05', ['tent']).free, 3);
});

test('a farm closure shuts every unit that does not ignore it', () => {
  const open = [...units, unit('K', 'tent', { ignoresFarmClosure: true })];
  const index = nightIndex([{ id: 'f', type: 'farm-closure', startDate: '2026-11-05', nights: 1, tents: [] }]);
  assert.deepEqual(capacityOn(open, index, '2026-11-05', ['tent']), { free: 1, total: 5 });
});

test('all types together, and levels', () => {
  const index = nightIndex([stay('1', '2026-11-05', 1, ['A', 'B', 'C'])]);
  const all = capacityOn(units, index, '2026-11-05');
  assert.deepEqual(all, { free: 2, total: 5 });
  assert.equal(levelOf({ free: 4, total: 4 }), 'open');
  assert.equal(levelOf({ free: 1, total: 4 }), 'tight');
  assert.equal(levelOf({ free: 0, total: 4 }), 'full');
  assert.equal(levelOf({ free: 0, total: 0 }), 'none');
});

test('rows skip a type with nothing on offer', () => {
  const rows = capacityRows({ units, types, bookings: [], dates: ['2026-11-05', '2026-11-06'] });
  assert.deepEqual(rows.map((r) => r.type.id), ['tent', 'hut']);
  assert.deepEqual(rows[0].cells.map((c) => c.free), [4, 4]);
});

test('the month starts on the right weekday, Monday first', () => {
  const { lead, cells } = monthCells({ units, bookings: [], dates: ['2026-11-01', '2026-11-02'], typeIds: [] });
  assert.equal(lead, 6); // 1 Nov 2026 is a Sunday
  assert.equal(cells[0].total, 5);
  assert.equal(monthCells({ units, bookings: [], dates: ['2026-11-01'], typeIds: ['hut'] }).cells[0].total, 1);
});

test('finding space: fits, or names the short night and the next start that fits', () => {
  const bookings = [stay('1', '2026-11-06', 2, ['A', 'B', 'C', 'D'])];
  assert.deepEqual(findSpace({ units, bookings, typeId: 'tent', qty: 2, from: '2026-11-03', nights: 2 }), { ok: true, fewest: 4 });
  const no = findSpace({ units, bookings, typeId: 'tent', qty: 1, from: '2026-11-05', nights: 3 });
  assert.equal(no.ok, false);
  assert.equal(no.shortOn, '2026-11-06');
  assert.equal(no.free, 0);
  assert.equal(no.next, '2026-11-08');
});

test('nothing fits within the look-ahead', () => {
  const none = findSpace({ units, bookings: [], typeId: '2bhk', qty: 1, from: '2026-11-05', nights: 1, lookahead: 5 });
  assert.deepEqual(none, { ok: false, shortOn: '2026-11-05', free: 0, next: null });
});
