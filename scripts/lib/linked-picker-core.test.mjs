// Run with: node --test scripts/lib/linked-picker-core.test.mjs
// The linked picker's navigation and search. Every value here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLeaf, labelsOf, levelAt, matchOptions, rowsAt, startingPath, trailOf, up } from './linked-picker-core.mjs';

const units = () => [
  { value: 'h1', label: 'F-01 · H-10', search: 'Test Person One Test Person Two' },
  { value: 'h2', label: 'F-02 · H-04', search: 'Another Member' },
];
const NODES = [
  { value: 'fuel', label: 'Fuel' },
  { value: 'maint', label: 'Maintenance', children: () => ['2025-26', '2026-27'].map((y) => ({ value: y, label: y, children: units })) },
  { value: 'plant', label: 'Plantation', selectable: true, children: [{ value: 'p1', label: 'Nursery shed' }] },
];

test('the top level is the nodes; a path goes down through children, built when asked for', () => {
  assert.deepEqual(levelAt(NODES, []).map((n) => n.value), ['fuel', 'maint', 'plant']);
  assert.deepEqual(levelAt(NODES, ['maint']).map((n) => n.value), ['2025-26', '2026-27']);
  assert.deepEqual(levelAt(NODES, ['maint', '2026-27']).map((n) => n.value), ['h1', 'h2']);
  assert.equal(levelAt(NODES, ['fuel']), null); // a leaf has no level below it
  assert.equal(levelAt(NODES, ['maint', 'nope']), null);
});

test('a function for children receives the path it is opened at', () => {
  const seen = [];
  const nodes = [{ value: 'a', label: 'A', children: (p) => (seen.push(p), [{ value: 'b', label: 'B' }]) }];
  levelAt(nodes, ['a']);
  assert.deepEqual(seen, [['a']]);
});

test('the breadcrumb and the labels follow the path and stop at a value that does not exist', () => {
  assert.deepEqual(labelsOf(NODES, ['maint', '2026-27', 'h1']), ['Maintenance', '2026-27', 'F-01 · H-10']);
  assert.deepEqual(trailOf(NODES, ['maint', '2026-27']).map((t) => t.path), [['maint'], ['maint', '2026-27']]);
  assert.deepEqual(labelsOf(NODES, ['maint', 'gone', 'h1']), ['Maintenance']);
});

test('rows: a node with children is entered; a selectable one is also a row you can pick as it is', () => {
  const rows = rowsAt(NODES, [], '');
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.node.value}`), ['pick:fuel', 'enter:maint', 'pick:plant', 'enter:plant']);
});

test('search only looks at the level being shown, in labels and in the extra search words', () => {
  assert.deepEqual(rowsAt(NODES, [], 'fuel').map((r) => r.node.value), ['fuel']);
  assert.deepEqual(rowsAt(NODES, [], 'nursery').map((r) => r.node.value), []); // a project is not found from the top: only the visible level is searched
  assert.deepEqual(rowsAt(NODES, ['maint', '2026-27'], 'person two').map((r) => r.node.value), ['h1']);
  assert.deepEqual(rowsAt(NODES, ['maint', '2026-27'], 'f-02').map((r) => r.node.value), ['h2']);
  assert.deepEqual(rowsAt(NODES, ['maint'], '2026').map((r) => r.node.value), ['2026-27']);
});

test('what makes a complete choice, and moving up', () => {
  assert.equal(isLeaf(NODES, ['fuel']), true);
  assert.equal(isLeaf(NODES, ['maint']), false);
  assert.equal(isLeaf(NODES, ['maint', '2026-27']), false);
  assert.equal(isLeaf(NODES, ['maint', '2026-27', 'h1']), true);
  assert.equal(isLeaf(NODES, []), false);
  assert.deepEqual(up(['a', 'b']), ['a']);
  assert.deepEqual(up([]), []);
});

test('opening with a value chosen starts at the level that holds it', () => {
  assert.deepEqual(startingPath(NODES, ['maint', '2026-27', 'h1']), ['maint', '2026-27']);
  assert.deepEqual(startingPath(NODES, ['fuel']), []);
  assert.deepEqual(startingPath(NODES, ['maint']), []);
  assert.deepEqual(startingPath(NODES, ['maint', 'gone', 'x']), []);
  assert.deepEqual(startingPath(NODES, []), []);
});

test('matching ranks names that start with the query first', () => {
  const opts = [{ label: 'Test Gas Services' }, { label: 'Gas Agency Muthu' }];
  assert.deepEqual(matchOptions(opts, 'gas').map((o) => o.label), ['Gas Agency Muthu', 'Test Gas Services']);
  assert.deepEqual(matchOptions(opts, 'zzz'), []);
  assert.equal(matchOptions(opts, ''), opts);
});

test('typing a group heading lists everything under it, after the names that contain the word', () => {
  const opts = [
    { value: 'a', label: 'Equipment', group: 'Capital purchases' },
    { value: 'b', label: 'Bank charges', group: 'Running costs' },
    { value: 'c', label: 'Capital gains tax', group: 'Taxes' },
    { value: 'd', label: 'Nursery', group: 'Capital purchases' },
  ];
  assert.deepEqual(matchOptions(opts, 'capital').map((o) => o.value), ['c', 'a', 'd']);
  assert.deepEqual(matchOptions(opts, 'capital nur').map((o) => o.value), ['d']);
  assert.deepEqual(matchOptions(opts, 'running').map((o) => o.value), ['b']);
});
