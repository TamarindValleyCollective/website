// Run with: node --test scripts/lib/data-table.test.mjs
// The shared admin table's logic. Every row here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, chipCounts, compareBy, filterRows, passesWords, readFavorites, sortRows, withFavorite } from './data-table.mjs';

const rows = [
  { id: 1, name: 'Green Valley Nursery', kind: 'Vendor', files: 2, paid: 1825000, last: '2026-11-09' },
  { id: 2, name: 'Test Traders', kind: 'Other', files: 0, paid: 0, last: '' },
  { id: 3, name: 'Ravi T', kind: 'Employee', files: 1, paid: 780000, last: '2026-11-01' },
  { id: 4, name: 'Test Traders Pvt', kind: 'Vendor', files: 1, paid: 412000, last: '2026-10-28' },
];
const columns = [
  { id: 'name', value: (r) => r.name },
  { id: 'kind', value: (r) => r.kind },
  { id: 'files', type: 'count', value: (r) => r.files },
  { id: 'paid', type: 'amount', value: (r) => r.paid },
  { id: 'last', type: 'date', value: (r) => r.last },
];
const ids = (r) => r.rows.map((x) => x.id);

test('search words all have to appear, ignoring case and punctuation', () => {
  assert.ok(passesWords('Green Valley Nursery', ['valley', 'GREEN']));
  assert.ok(!passesWords('Green Valley Nursery', ['valley', 'tractor']));
  assert.ok(passesWords('MOHAN, ELECTRICALS', ['mohan electricals']));
});

test('column filters use the ledger syntax for text, counts, amounts and dates', () => {
  const f = (cols) => ids(filterRows(rows, { columns, cols }));
  assert.deepEqual(f({ name: 'test' }), [2, 4]);
  assert.deepEqual(f({ name: '=test traders' }), [2]);
  assert.deepEqual(f({ name: '^green' }), [1]);
  assert.deepEqual(f({ name: '!test' }), [1, 3]);
  assert.deepEqual(f({ files: '>=1' }), [1, 3, 4]);
  assert.deepEqual(f({ files: '0' }), [2]);
  assert.deepEqual(f({ paid: '>5000' }), [1, 3]);
  assert.deepEqual(f({ paid: '4000..8000' }), [3, 4]);
  assert.deepEqual(f({ last: '2026-11' }), [1, 3]);
  assert.deepEqual(f({ last: '<2026-11-01' }), [4]);
  assert.deepEqual(f({ name: 'test', kind: 'vendor' }), [4], 'conditions combine');
});

test('a condition that cannot be read is reported and does not hide every row', () => {
  const r = filterRows(rows, { columns, cols: { paid: 'lots' } });
  assert.ok(r.errors.paid);
  assert.equal(r.rows.length, 4);
});

test('chips all have to pass, and counts say how many each gives', () => {
  const filters = [{ id: 'other', test: (r) => r.kind === 'Other' }, { id: 'nofiles', test: (r) => !r.files }, { id: 'vendor', test: (r) => r.kind === 'Vendor' }];
  assert.deepEqual(ids(filterRows(rows, { filters, chips: ['other', 'nofiles'] })), [2]);
  assert.deepEqual(ids(filterRows(rows, { filters, chips: ['other', 'vendor'] })), []);
  assert.deepEqual(chipCounts(rows, filters), { other: 1, nofiles: 1, vendor: 2 });
});

test('chips of one group are alternatives, chips of different groups all have to pass', () => {
  const filters = [
    { id: 'vendor', group: 'kind', test: (r) => r.kind === 'Vendor' },
    { id: 'other', group: 'kind', test: (r) => r.kind === 'Other' },
    { id: 'nofiles', test: (r) => !r.files },
  ];
  assert.deepEqual(ids(filterRows(rows, { filters, chips: ['vendor', 'other'] })), [1, 2, 4]);
  assert.deepEqual(ids(filterRows(rows, { filters, chips: ['vendor', 'other', 'nofiles'] })), [2]);
});

test('sorting puts empty cells last either way, and equal rows keep their order', () => {
  const by = (id, dir) => sortRows(rows, columns.find((c) => c.id === id), dir).map((r) => r.id);
  assert.deepEqual(by('last', 1), [4, 3, 1, 2]);
  assert.deepEqual(by('last', -1), [1, 3, 4, 2]);
  assert.deepEqual(by('paid', -1), [1, 3, 4, 2]);
  assert.deepEqual(by('name', 1), [1, 3, 2, 4]);
  const same = [{ n: 'a', i: 1 }, { n: 'a', i: 2 }, { n: 'a', i: 3 }];
  assert.deepEqual(sortRows(same, { value: (r) => r.n }, -1).map((r) => r.i), [1, 2, 3]);
  assert.equal(typeof compareBy(columns[0]), 'function');
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
