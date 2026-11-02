// Run with: node --test scripts/lib/stay-change-request.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, describeNew } from './stay-change-request.mjs';

const labels = new Map([['T1', 'Banyan'], ['T2', 'Neem']]);
const g = (name, extra = {}) => ({ personId: name, name, ageGroup: 'Adult', ...extra });
const stay = (extra = {}) => ({ type: 'casual-stay', label: 'Rao', note: '', startDate: '2026-10-05', nights: 3, tents: [{ tentId: 'T1', guests: [g('Asha'), g('Dev')] }], ...extra });

test('nothing visible changed gives no lines', () => {
  assert.deepEqual(describeChange(stay(), stay(), labels), []);
});

test('dates, tent and guests are each named', () => {
  const proposed = stay({ nights: 4, tents: [{ tentId: 'T2', guests: [g('Asha'), g('Kiran')] }] });
  assert.deepEqual(describeChange(stay(), proposed, labels), [
    'Dates: 2026-10-05 to 2026-10-08 (3 nights) → 2026-10-05 to 2026-10-09 (4 nights)',
    'Tent: Banyan → Neem',
    'Guests added: Kiran',
    'Guests removed: Dev',
  ]);
});

test('a returning guest is matched by id, so a rename is a rename and not a swap', () => {
  const proposed = stay({ tents: [{ tentId: 'T1', guests: [{ ...g('Asha'), name: 'Asha R' }, g('Dev')] }] });
  assert.deepEqual(describeChange(stay(), proposed, labels), ['Guest renamed: Asha → Asha R']);
});

test('food needs are only compared when both sides carry them', () => {
  const withPrefs = stay({ tents: [{ tentId: 'T1', guests: [g('Asha', { preferences: 'Nut allergy' }), g('Dev')] }] });
  assert.deepEqual(describeChange(stay(), withPrefs, labels), []); // the current side withheld them
  const changed = stay({ tents: [{ tentId: 'T1', guests: [g('Asha', { preferences: 'Vegan' }), g('Dev')] }] });
  assert.deepEqual(describeChange(withPrefs, changed, labels), ['Asha: food needs "Nut allergy" → "Vegan"']);
});

test('label and note changes show', () => {
  assert.deepEqual(describeChange(stay(), stay({ label: 'Rao family', note: 'Late' }), labels), ['Label: "Rao" → "Rao family"', 'Note: "" → "Late"']);
});

test('a backfilled stay is spelled out', () => {
  assert.deepEqual(describeNew(stay({ note: 'Paid in cash' }), labels), [
    'Dates: 2026-10-05 to 2026-10-08 (3 nights)',
    'Tent: Banyan',
    'Guests: Asha, Dev',
    'Label: "Rao"',
    'Note: "Paid in cash"',
  ]);
});
