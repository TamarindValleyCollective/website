import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWhatsAppHealth } from './whatsapp-health-summary.mjs';

const ev = (title, severity = 'info', detail = null, created_at = '2026-10-23T10:00:00Z') => ({ title, severity, detail, created_at });

test('counts defined, approved and waiting templates when Meta has said nothing', () => {
  const s = summarizeWhatsAppHealth(['a', 'b', 'c'], ['a', 'b'], []);
  assert.deepEqual([s.total, s.approved, s.waiting, s.attention], [3, 2, 1, 0]);
  assert.equal(s.phone.state, 'quiet');
});

test('the newest notice about a template decides: a rejection counts, a later approval clears it', () => {
  const rejected = summarizeWhatsAppHealth(['a'], ['a'], [ev('Template rejected: a', 'warning', 'INVALID_FORMAT')]);
  assert.equal(rejected.attention, 1);
  assert.equal(rejected.approved, 0);
  assert.match(rejected.templates[0].note, /rejected: a \(INVALID_FORMAT\)/);

  // events are newest first: approved came after the rejection
  const cleared = summarizeWhatsAppHealth(['a'], ['a'], [ev('Template approved: a'), ev('Template rejected: a', 'warning')]);
  assert.equal(cleared.attention, 0);
  assert.equal(cleared.approved, 1);
});

test('a quality drop needs attention, green does not; notices about unknown templates are ignored', () => {
  const s = summarizeWhatsAppHealth(['a', 'b'], ['a', 'b'], [ev('Template quality red: a', 'critical'), ev('Template quality green: b'), ev('Template paused: gone', 'critical')]);
  assert.deepEqual([s.approved, s.attention], [1, 1]);
});

test('phone number: the newest notice sets its state', () => {
  assert.equal(summarizeWhatsAppHealth([], [], [ev('Phone number flagged', 'critical')]).phone.state, 'attention');
  assert.equal(summarizeWhatsAppHealth([], [], [ev('Phone number no longer flagged'), ev('Phone number flagged', 'critical')]).phone.state, 'ok');
});
