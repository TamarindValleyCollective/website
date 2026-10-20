import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotOf, diffNotices, hasPendingChanges, checkOutDate, isNotifiableType } from './stay-notice.mjs';

const booking = (tents, over = {}) => ({ startDate: '2026-11-01', nights: 2, tents, ...over });
const g = (personId) => ({ personId, name: personId });

test('only member stays are notifiable for now', () => {
  assert.equal(isNotifiableType('member-stay'), true);
  for (const t of ['public-event', 'private-event', 'casual-stay', 'unit-closure', 'farm-closure']) assert.equal(isNotifiableType(t), false);
});

test('first finalize confirms everyone', () => {
  const cur = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a'), g('b')] }]));
  assert.deepEqual(diffNotices(null, cur), [
    { personId: 'a', kind: 'confirmed' },
    { personId: 'b', kind: 'confirmed' },
  ]);
});

test('unchanged booking has nothing to send', () => {
  const s = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a')] }]));
  assert.deepEqual(diffNotices(s, s), []);
  assert.equal(hasPendingChanges(s, s), false);
});

test('moving a guest to another tent updates only that guest', () => {
  const prev = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a')] }, { tentId: 'Tent02', guests: [g('b')] }]));
  const cur = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a')] }, { tentId: 'Tent04', guests: [g('b')] }]));
  assert.deepEqual(diffNotices(prev, cur), [{ personId: 'b', kind: 'updated' }]);
  assert.equal(hasPendingChanges(prev, cur), true);
});

test('changing dates updates everyone', () => {
  const tents = [{ tentId: 'Tent01', guests: [g('a'), g('b')] }];
  const prev = snapshotOf(booking(tents));
  const cur = snapshotOf(booking(tents, { nights: 3 }));
  assert.deepEqual(diffNotices(prev, cur).map((d) => d.kind), ['updated', 'updated']);
});

test('added guest is confirmed, removed guest is cancelled', () => {
  const prev = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a'), g('b')] }]));
  const cur = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a'), g('c')] }]));
  assert.deepEqual(diffNotices(prev, cur), [
    { personId: 'c', kind: 'confirmed' },
    { personId: 'b', kind: 'cancelled' },
  ]);
});

test('swapping which guest sits in which tent counts as updated for both', () => {
  const prev = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('a')] }, { tentId: 'Tent02', guests: [g('b')] }]));
  const cur = snapshotOf(booking([{ tentId: 'Tent01', guests: [g('b')] }, { tentId: 'Tent02', guests: [g('a')] }]));
  assert.deepEqual(diffNotices(prev, cur).map((d) => d.kind), ['updated', 'updated']);
});

test('checkOutDate rolls over month ends', () => {
  assert.equal(checkOutDate('2026-10-30', 3), '2026-11-02');
});
