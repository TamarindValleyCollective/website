import test from 'node:test';
import assert from 'node:assert/strict';
import { actsAutomatically, parseSettings, shadowStats } from './member-autopublish.mjs';

test('no setting means shadow mode and not paused', () => {
  assert.deepEqual(parseSettings(undefined), { mode: 'shadow', paused: false });
  assert.deepEqual(parseSettings({ value: { mode: 'live', paused: true } }), { mode: 'live', paused: true });
  assert.deepEqual(parseSettings({ value: { mode: 'bogus', paused: 'yes' } }), { mode: 'shadow', paused: false });
});

test('the system acts only when live and not paused', () => {
  assert.equal(actsAutomatically({ mode: 'shadow', paused: false }), false);
  assert.equal(actsAutomatically({ mode: 'live', paused: true }), false);
  assert.equal(actsAutomatically({ mode: 'live', paused: false }), true);
});

test('shadow stats count what was missed and what was held without need', () => {
  const rows = [
    { level: 'low', decision: 'approved' },
    { level: 'low', decision: 'rejected' },
    { level: 'high', decision: 'approved' },
    { level: 'high', decision: 'rejected' },
    { level: 'low', decision: null },
  ];
  assert.deepEqual(shadowStats(rows), { assessed: 5, low: 3, high: 2, decided: 4, missed: 1, overHeld: 1 });
});
