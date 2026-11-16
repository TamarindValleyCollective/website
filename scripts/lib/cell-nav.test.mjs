// Run with: node --test scripts/lib/cell-nav.test.mjs
// Where the arrow keys take the cell cursor of an admin table. Invented shapes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMenuKey, moveCursor, PAGE } from './cell-nav.mjs';

const shape = { rows: 30, cols: ['date', 'amount', 'party', 'status'] };
const go = (pos, key, ctrl = false, s = shape) => moveCursor(pos, key, { ctrl }, s);

test('the arrow keys move one cell and stop at the edges', () => {
  assert.deepEqual(go({ row: 3, col: 'amount' }, 'ArrowRight'), { row: 3, col: 'party' });
  assert.deepEqual(go({ row: 3, col: 'amount' }, 'ArrowLeft'), { row: 3, col: 'date' });
  assert.deepEqual(go({ row: 3, col: 'amount' }, 'ArrowDown'), { row: 4, col: 'amount' });
  assert.deepEqual(go({ row: 3, col: 'amount' }, 'ArrowUp'), { row: 2, col: 'amount' });
  assert.deepEqual(go({ row: 0, col: 'date' }, 'ArrowUp'), { row: 0, col: 'date' }, 'the top stays the top');
  assert.deepEqual(go({ row: 0, col: 'date' }, 'ArrowLeft'), { row: 0, col: 'date' });
  assert.deepEqual(go({ row: 29, col: 'status' }, 'ArrowDown'), { row: 29, col: 'status' });
  assert.deepEqual(go({ row: 29, col: 'status' }, 'ArrowRight'), { row: 29, col: 'status' });
});

test('Home and End go to the ends of the row, with Ctrl to the ends of the table', () => {
  assert.deepEqual(go({ row: 7, col: 'party' }, 'Home'), { row: 7, col: 'date' });
  assert.deepEqual(go({ row: 7, col: 'party' }, 'End'), { row: 7, col: 'status' });
  assert.deepEqual(go({ row: 7, col: 'party' }, 'Home', true), { row: 0, col: 'date' });
  assert.deepEqual(go({ row: 7, col: 'party' }, 'End', true), { row: 29, col: 'status' });
});

test('Page Up and Page Down move a page of rows and stop at the ends', () => {
  assert.equal(PAGE, 10);
  assert.deepEqual(go({ row: 12, col: 'party' }, 'PageDown'), { row: 22, col: 'party' });
  assert.deepEqual(go({ row: 12, col: 'party' }, 'PageUp'), { row: 2, col: 'party' });
  assert.deepEqual(go({ row: 25, col: 'party' }, 'PageDown'), { row: 29, col: 'party' });
  assert.deepEqual(go({ row: 4, col: 'party' }, 'PageUp'), { row: 0, col: 'party' });
});

test('any other key does not move the cursor', () => {
  for (const key of ['a', 'Enter', ' ', 'Tab', 'Escape', 'F10']) assert.equal(go({ row: 1, col: 'date' }, key), null, key);
});

test('a column that is no longer shown, or a row past the end, is brought back into the table', () => {
  assert.deepEqual(go({ row: 3, col: 'gone' }, 'ArrowRight'), { row: 3, col: 'amount' }, 'an unknown column counts as the first');
  assert.deepEqual(go({ row: 99, col: 'date' }, 'ArrowUp'), { row: 28, col: 'date' }, 'a row past the end counts as the last');
  assert.deepEqual(go({ row: 2, col: 'amount' }, 'ArrowDown', false, { rows: 3, cols: ['amount'] }), { row: 2, col: 'amount' });
});

test('an empty table has nowhere to go', () => {
  assert.equal(go({ row: 0, col: 'date' }, 'ArrowDown', false, { rows: 0, cols: ['date'] }), null);
  assert.equal(go({ row: 0, col: 'date' }, 'ArrowDown', false, { rows: 5, cols: [] }), null);
});

test('the Menu key and Shift+F10 open the cell menu; F10 alone does not', () => {
  assert.equal(isMenuKey({ key: 'ContextMenu', shiftKey: false }), true);
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true }), true);
  assert.equal(isMenuKey({ key: 'F10', shiftKey: false }), false);
  assert.equal(isMenuKey({ key: 'Enter', shiftKey: true }), false);
});
