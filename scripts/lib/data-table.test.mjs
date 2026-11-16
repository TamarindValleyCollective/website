// Run with: node --test scripts/lib/data-table.test.mjs
// The shared admin table's pure pieces (the engine's filtering and sorting are in data-table-engine.test.mjs). Every row here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, cellFilterText, chipCounts, cleanLayout, columnGroup, moveColumn, parseColumnFilter, matchColumn, passesWords, readFavorites, withFavorite } from './data-table.mjs';

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

test('a saved column layout is made safe for the columns the table has today', () => {
  const ids = ['name', 'kind', 'files', 'paid', 'act'];
  assert.deepEqual(cleanLayout(null, ids, ['act']), { order: ids, hidden: [] }, 'nothing saved is the default');
  assert.deepEqual(cleanLayout({ order: ['paid', 'name'], hidden: ['kind'] }, ids, ['act']), { order: ['paid', 'name', 'kind', 'files', 'act'], hidden: ['kind'] }, 'columns not mentioned follow in their default order');
  assert.deepEqual(cleanLayout({ order: ['gone', 'files', 'files', 'name'], hidden: ['gone'] }, ids, ['act']), { order: ['files', 'name', 'kind', 'paid', 'act'], hidden: [] }, 'unknown and repeated ids are dropped');
  assert.deepEqual(cleanLayout({ order: ['act', 'name'], hidden: ['act'] }, ids, ['act']), { order: ['name', 'kind', 'files', 'paid', 'act'], hidden: [] }, 'a fixed column stays put and stays shown');
  assert.deepEqual(cleanLayout({ hidden: ids }, ids, []).hidden, [], 'hiding every column is not allowed');
  assert.deepEqual(cleanLayout('junk', ids, []), { order: ids, hidden: [] });
});

test('a column moves one place among the movable ones, and a fixed column keeps its place', () => {
  const ids = ['a', 'b', 'c', 'act'];
  const start = { order: ids, hidden: ['c'] };
  assert.deepEqual(moveColumn(start, 'b', -1, ids, ['act']), { order: ['b', 'a', 'c', 'act'], hidden: ['c'] });
  assert.deepEqual(moveColumn(start, 'a', -1, ids, ['act']), start, 'already first');
  assert.deepEqual(moveColumn(start, 'c', 1, ids, ['act']), start, 'cannot pass the fixed column');
  assert.deepEqual(moveColumn(start, 'act', -1, ids, ['act']), start, 'a fixed column does not move');
  assert.deepEqual(moveColumn({ order: ['act', 'a', 'b', 'c'], hidden: [] }, 'a', 1, ['act', 'a', 'b', 'c'], ['act']).order, ['act', 'b', 'a', 'c'], 'a fixed column at the start stays at the start');
});

test('"filter to this value" and "filter out this value" give text the column can read, and it picks the right rows', () => {
  const pass = (type, text, value) => matchColumn(type, parseColumnFilter(type, text), value);
  for (const [type, cellValue, other] of [['text', 'Green Valley', 'Ravi T'], ['text', '=odd', 'x'], ['text', '!bang', 'x'], ['amount', 1825000, 780000], ['amount', 250050, 0], ['count', 2, 1], ['date', '2026-11-09', '2026-11-01']]) {
    const to = cellFilterText(type, cellValue);
    assert.ok(!parseColumnFilter(type, to)?.error, `${type} ${cellValue}: ${to} can be read`);
    assert.ok(pass(type, to, cellValue), `${type} ${cellValue}: filter to keeps it`);
    assert.ok(!pass(type, to, other), `${type} ${cellValue}: filter to drops ${other}`);
    const out = cellFilterText(type, cellValue, true);
    if (type === 'date') assert.equal(out, null, 'dates cannot say "not this date"');
    else {
      assert.ok(!pass(type, out, cellValue), `${type} ${cellValue}: filter out drops it`);
      assert.ok(pass(type, out, other), `${type} ${cellValue}: filter out keeps ${other}`);
    }
  }
  assert.equal(cellFilterText('amount', 250050), '=2500.5', 'paise become rupees, without trailing zeros');
  assert.equal(cellFilterText('text', 'Green Valley', true), '!=Green Valley');
  assert.equal(cellFilterText('text', ''), '=', 'an empty text cell filters to the empty ones');
  assert.equal(cellFilterText('text', null, true), '!=', 'and out to the filled ones');
  assert.equal(cellFilterText('amount', null), null, 'an empty amount or date has nothing to filter on');
  assert.equal(cellFilterText('date', ''), null);
});

test('group by a column: rows with no value fall in a "No ..." group that comes last', () => {
  const g = columnGroup({ id: 'kind', label: 'Kind', value: (r) => r.kind });
  assert.equal(g.id, 'col:kind');
  assert.equal(g.label, 'Kind');
  assert.deepEqual([{ kind: 'Vendor' }, { kind: '' }, { kind: null }, { kind: ' Employee ' }].map(g.key), ['Vendor', 'No kind', 'No kind', 'Employee']);
  const items = buildItems([{ kind: '' }, { kind: 'Vendor' }, { kind: 'Employee' }, { kind: 'Vendor' }], g).items.filter((i) => i.kind === 'group');
  assert.deepEqual(items.map((i) => [i.label, i.count]), [['Employee', 1], ['Vendor', 2], ['No kind', 1]]);
  assert.equal(columnGroup({ id: 'x', value: (r) => r.x, groupValue: (r) => r.y }).key({ x: 'a', y: 'b' }), 'b', 'a column can group on a different value than it shows');
});

test('a column that is required stays shown but can still move, and some columns start hidden', () => {
  const ids = ['sel', 'date', 'cat', 'party', 'word', 'narr'];
  const opts = { fixed: ['sel'], required: ['cat', 'party'], defaultHidden: ['word', 'narr'] };
  const clean = (raw) => cleanLayout(raw, ids, opts.fixed, opts.required, opts.defaultHidden);
  assert.deepEqual(clean(null), { order: ids, hidden: ['word', 'narr'] }, 'nothing saved: the defaults');
  assert.deepEqual(clean({ order: ids, hidden: [] }).hidden, [], 'a saved layout that shows everything is not overridden by the defaults');
  assert.deepEqual(clean({ order: ['sel', 'party', 'cat', 'date', 'word', 'narr'], hidden: ['cat', 'date'] }), { order: ['sel', 'party', 'cat', 'date', 'word', 'narr'], hidden: ['date'] }, 'a required column cannot be hidden, but it keeps its place');
  assert.deepEqual(clean({ order: ['sel', 'date', 'cat', 'party', 'word'], hidden: [] }).hidden, ['narr'], 'a column added since the layout was saved starts as the default says');
  assert.deepEqual(clean({ order: ['sel', 'date', 'cat', 'party', 'word'], hidden: [] }).order, ids, 'and goes at its default place');
  assert.deepEqual(clean('junk'), { order: ids, hidden: ['word', 'narr'] });
  assert.deepEqual(cleanLayout(null, ['a', 'b'], [], [], ['a', 'b']).hidden, [], 'hiding every column is still not allowed, even by default');
  assert.deepEqual(moveColumn({ order: ids, hidden: ['word'] }, 'party', -1, ids, ['sel']), { order: ['sel', 'date', 'party', 'cat', 'word', 'narr'], hidden: ['word'] });
});
