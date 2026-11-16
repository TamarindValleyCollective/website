// Run with: node --test scripts/lib/data-table.test.mjs
// The shared admin table's pure pieces (the engine's filtering and sorting are in data-table-engine.test.mjs). Every row here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, chipCounts, parseColumnFilter, matchColumn, passesWords, readFavorites, withFavorite } from './data-table.mjs';

const rows = [
  { id: 1, name: 'Green Valley Nursery', kind: 'Vendor', files: 2, paid: 1825000, last: '2026-11-09' },
  { id: 2, name: 'Test Traders', kind: 'Other', files: 0, paid: 0, last: '' },
  { id: 3, name: 'Ravi T', kind: 'Employee', files: 1, paid: 780000, last: '2026-11-01' },
  { id: 4, name: 'Test Traders Pvt', kind: 'Vendor', files: 1, paid: 412000, last: '2026-10-28' },
];
test('search words all have to appear, ignoring case and punctuation', () => {
  assert.ok(passesWords('Green Valley Nursery', ['valley', 'GREEN']));
  assert.ok(!passesWords('Green Valley Nursery', ['valley', 'tractor']));
  assert.ok(passesWords('MOHAN, ELECTRICALS', ['mohan electricals']));
});

test('a typed column condition is parsed once and matched per cell, by the column type', () => {
  const m = (type, typed, value) => matchColumn(type, parseColumnFilter(type, typed), value);
  assert.ok(m('text', '^green', 'Green Valley'));
  assert.ok(!m('text', '!test', 'Test Traders'));
  assert.ok(m('count', '>=1', 2));
  assert.ok(m('count', '0', 0));
  assert.ok(m('amount', '4000..8000', 780000), 'rupees typed, paise held');
  assert.ok(m('date', '2026-11', '2026-11-09'));
  assert.ok(!m('date', '2026-11', ''), 'an empty date matches no date condition');
  assert.ok(parseColumnFilter('amount', 'lots').error, 'what cannot be read is an error');
  assert.ok(matchColumn('amount', parseColumnFilter('amount', 'lots'), 5), 'and an error never hides a row');
});

test('counts say how many rows each chip filter gives on its own', () => {
  const filters = [{ id: 'other', test: (r) => r.kind === 'Other' }, { id: 'nofiles', test: (r) => !r.files }, { id: 'vendor', test: (r) => r.kind === 'Vendor' }];
  assert.deepEqual(chipCounts(rows, filters), { other: 1, nofiles: 1, vendor: 2 });
  assert.deepEqual(chipCounts(rows, filters, (r) => r.kind !== 'Vendor'), { other: 1, nofiles: 1, vendor: 0 });
});

test('grouping follows the given order, puts "No ..." last and drops the rows of a collapsed group', () => {
  const group = { id: 'kind', key: (r) => r.kind, order: ['Vendor', 'Employee'] };
  const a = buildItems(rows, group);
  assert.deepEqual(a.items.filter((i) => i.kind === 'group').map((g) => [g.label, g.count]), [['Vendor', 2], ['Employee', 1], ['Other', 1]]);
  const b = buildItems(rows, group, new Set(['kind:Vendor']));
  assert.deepEqual(b.visible.map((r) => r.id), [3, 2]);
  assert.equal(b.items[0].open, false);
  const none = buildItems(rows, { id: 'x', key: (r) => (r.files ? 'Has files' : 'No files') });
  assert.equal(none.items.at(-2).label, 'No files');
  assert.equal(buildItems(rows, null).items.length, 4);
  const months = buildItems(rows, { id: 'm', key: (r) => (r.last || 'No date').slice(0, 7), descending: true, format: (k) => `M ${k}` });
  assert.deepEqual(months.items.filter((i) => i.kind === 'group').map((g) => g.label), ['M 2026-11', 'M 2026-10', 'M No date'], 'newest first, "No ..." last, headings formatted');
});

test('favorites keep only what is known, replace by name, and survive unreadable storage', () => {
  const allowed = { chipIds: ['other'], groupIds: ['kind'] };
  const list = withFavorite([], { name: ' Needs a look ', chips: ['other', 'gone'], words: ['x', ''], group: 'nope' }, allowed);
  assert.deepEqual(list, [{ name: 'Needs a look', chips: ['other'], words: ['x'], group: '' }]);
  assert.equal(withFavorite(list, { name: 'needs a LOOK', chips: [], group: 'kind' }, allowed).length, 1);
  assert.deepEqual(readFavorites('not json'), []);
  assert.deepEqual(readFavorites(JSON.stringify(list), allowed), list);
  assert.deepEqual(withFavorite(list, { name: '' }, allowed), list);
});
