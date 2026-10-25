import test from 'node:test';
import assert from 'node:assert/strict';
import { setBusy, withBusy } from './busy.mjs';

// Just enough of a button for the helper: attributes, children, disabled.
function fakeButton(text, disabled = false) {
  const attrs = new Map();
  return {
    disabled,
    childNodes: [text],
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    replaceChildren(...nodes) {
      this.childNodes = nodes;
    },
  };
}

test('setBusy disables, marks aria-busy, relabels, and puts everything back', () => {
  const b = fakeButton('Save');
  const done = setBusy(b, 'Saving…');
  assert.equal(b.disabled, true);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.deepEqual(b.childNodes, ['Saving…']);
  done();
  assert.equal(b.disabled, false);
  assert.equal(b.getAttribute('aria-busy'), null);
  assert.deepEqual(b.childNodes, ['Save']);
});

test('without a label the button keeps its own text', () => {
  const b = fakeButton('Load more');
  const done = setBusy(b);
  assert.deepEqual(b.childNodes, ['Load more']);
  done();
  assert.deepEqual(b.childNodes, ['Load more']);
});

test('a button that was already disabled stays disabled afterwards', () => {
  const b = fakeButton('Save', true);
  setBusy(b, 'Saving…')();
  assert.equal(b.disabled, true);
});

test('calling the restore twice is harmless', () => {
  const b = fakeButton('Save');
  const done = setBusy(b, 'Saving…');
  done();
  b.disabled = true; // something else disabled it after the work ended
  done();
  assert.equal(b.disabled, true);
});

test('withBusy restores the button when the work throws', async () => {
  const b = fakeButton('Save');
  await assert.rejects(withBusy(b, 'Saving…', async () => { throw new Error('nope'); }), /nope/);
  assert.equal(b.disabled, false);
  assert.equal(b.getAttribute('aria-busy'), null);
  assert.deepEqual(b.childNodes, ['Save']);
});
