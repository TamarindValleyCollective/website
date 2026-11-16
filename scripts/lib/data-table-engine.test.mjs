// Run with: node --test scripts/lib/data-table-engine.test.mjs
// The shared admin table's engine, a TanStack table-core instance that filters and sorts with the ledger's column syntax.
// These are the cases the table's own functions were tested with before the move; every row here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableEngine } from './data-table-engine.mjs';

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
  const engine = createTableEngine({ columns, searchText: (r) => `${r.name} ${r.kind}` });
  assert.deepEqual(ids(engine.run({ rows, words: ['valley', 'GREEN'] })), [1]);
  assert.deepEqual(ids(engine.run({ rows, words: ['valley', 'tractor'] })), []);
  assert.deepEqual(ids(engine.run({ rows, words: ['test traders'] })), [2, 4]);
  assert.deepEqual(ids(engine.run({ rows, words: [] })), [1, 2, 3, 4], 'no words, no filter');
});

test('column filters use the ledger syntax for text, counts, amounts and dates', () => {
  const engine = createTableEngine({ columns });
  const f = (cols) => ids(engine.run({ rows, cols }));
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
  assert.deepEqual(f({ name: 'test' }), [2, 4], 'the same engine can be run again with other conditions');
  assert.deepEqual(f({}), [1, 2, 3, 4], 'and with none');
});

test('a column that opts out of filtering ignores what is typed under it', () => {
  const engine = createTableEngine({ columns: [{ id: 'name', value: (r) => r.name }, { id: 'act', filter: 'none', value: () => '' }] });
  assert.deepEqual(ids(engine.run({ rows, cols: { act: 'anything' } })), [1, 2, 3, 4]);
});

test('a condition that cannot be read is reported and does not hide every row', () => {
  const engine = createTableEngine({ columns });
  const r = engine.run({ rows, cols: { paid: 'lots' } });
  assert.ok(r.errors.paid);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(engine.run({ rows, cols: { paid: '>5000' } }).errors, {}, 'the report goes away with the mistake');
});

test('chips all have to pass', () => {
  const filters = [{ id: 'other', test: (r) => r.kind === 'Other' }, { id: 'nofiles', test: (r) => !r.files }, { id: 'vendor', test: (r) => r.kind === 'Vendor' }];
  const engine = createTableEngine({ columns, filters });
  assert.deepEqual(ids(engine.run({ rows, chips: ['other', 'nofiles'] })), [2]);
  assert.deepEqual(ids(engine.run({ rows, chips: ['other', 'vendor'] })), []);
  assert.deepEqual(ids(engine.run({ rows, chips: ['gone'] })), [1, 2, 3, 4], 'an unknown chip is ignored');
});

test('chips of one group are alternatives, chips of different groups all have to pass', () => {
  const filters = [
    { id: 'vendor', group: 'kind', test: (r) => r.kind === 'Vendor' },
    { id: 'other', group: 'kind', test: (r) => r.kind === 'Other' },
    { id: 'nofiles', test: (r) => !r.files },
  ];
  const engine = createTableEngine({ columns, filters });
  assert.deepEqual(ids(engine.run({ rows, chips: ['vendor', 'other'] })), [1, 2, 4]);
  assert.deepEqual(ids(engine.run({ rows, chips: ['vendor', 'other', 'nofiles'] })), [2]);
});

test('sorting puts empty cells last either way, and equal rows keep their order', () => {
  const engine = createTableEngine({ columns });
  const by = (id, dir) => engine.run({ rows, sort: [id, dir] }).rows.map((r) => r.id);
  assert.deepEqual(by('last', 1), [4, 3, 1, 2]);
  assert.deepEqual(by('last', -1), [1, 3, 4, 2]);
  assert.deepEqual(by('paid', -1), [1, 3, 4, 2]);
  assert.deepEqual(by('name', 1), [1, 3, 2, 4]);
  assert.deepEqual(by(null, 1), [1, 2, 3, 4], 'no sort column keeps the order the rows came in');
  const same = [{ n: 'a', i: 1 }, { n: 'a', i: 2 }, { n: 'a', i: 3 }];
  const flat = createTableEngine({ columns: [{ id: 'n', value: (r) => r.n }] });
  assert.deepEqual(flat.run({ rows: same, sort: ['n', -1] }).rows.map((r) => r.i), [1, 2, 3]);
});

test('a column can sort on a different value than it shows', () => {
  const engine = createTableEngine({ columns: [{ id: 'name', value: (r) => r.name.toUpperCase(), sortValue: (r) => r.files }] });
  assert.deepEqual(engine.run({ rows, sort: ['name', 1] }).rows.map((r) => r.id), [2, 3, 4, 1]);
});

test('filters and sorting work together, and the rows given are never reordered in place', () => {
  const engine = createTableEngine({ columns });
  const given = [...rows];
  assert.deepEqual(ids(engine.run({ rows: given, cols: { kind: 'vendor' }, sort: ['paid', -1] })), [1, 4]);
  assert.deepEqual(given.map((r) => r.id), [1, 2, 3, 4]);
});

test('column order and visibility live in the table state, and the rest of the table follows them', () => {
  const engine = createTableEngine({ columns: [...columns.slice(0, 4), { id: 'act', fixed: true, filter: 'none', value: () => '' }] });
  assert.deepEqual(engine.visibleColumnIds(), ['name', 'kind', 'files', 'paid', 'act']);
  engine.setLayout({ order: ['paid', 'name', 'kind', 'files', 'act'], hidden: ['kind'] });
  assert.deepEqual(engine.visibleColumnIds(), ['paid', 'name', 'files', 'act']);
  assert.deepEqual(engine.allColumnIds(), ['paid', 'name', 'kind', 'files', 'act'], 'hidden columns are still listed, for the menu');
  assert.deepEqual(engine.layout(), { order: ['paid', 'name', 'kind', 'files', 'act'], hidden: ['kind'] });
  assert.deepEqual(ids(engine.run({ rows, cols: { name: 'test' } })), [2, 4], 'filtering and sorting still run');
  engine.setLayout({ order: ['act', 'name'], hidden: ['act'] });
  assert.deepEqual(engine.visibleColumnIds().at(-1), 'act', 'a fixed column cannot be hidden or moved');
  engine.setLayout(null);
  assert.deepEqual(engine.visibleColumnIds(), ['name', 'kind', 'files', 'paid', 'act'], 'no layout is the default');
});

test('the search box finds an amount typed in rupees, with or without commas or paise', () => {
  const eng = createTableEngine({ columns, filters: [], searchText: (r) => r.name });
  const found = (w) => eng.run({ rows, words: w }).rows.map((r) => r.id);
  assert.deepEqual(found(['18250']), [1]);
  assert.deepEqual(found(['18,250']), [1]);
  assert.deepEqual(found(['4120.00']), [4]);
  assert.deepEqual(found(['9999']), []);
});

test('an amount column that shows a sign filters on it: -219 finds the debit, not the credit', () => {
  const data = [{ id: 1, paise: 21900, dir: 'debit' }, { id: 2, paise: 21900, dir: 'credit' }, { id: 3, paise: 22500, dir: 'debit' }];
  const eng = createTableEngine({ columns: [{ id: 'amount', type: 'amount', value: (r) => r.paise, signOf: (r) => (r.dir === 'credit' ? 1 : -1) }] });
  const ids = (typed) => eng.run({ rows: data, cols: { amount: typed } }).rows.map((r) => r.id);
  assert.deepEqual(ids('-219'), [1]);
  assert.deepEqual(ids('+219'), [2]);
  assert.deepEqual(ids('219'), [1, 2]);
  assert.deepEqual(ids('-'), [1, 3]);
});
