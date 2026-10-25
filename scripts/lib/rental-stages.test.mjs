// Run with: node --test scripts/lib/rental-stages.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, stageIndex } from './rental-stages.mjs';

test('the four stages are in the order an offer moves through them', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['offered', 'shared', 'signed', 'enabled']);
});

test('an offer moves from offered to enabled as the contract is shared, signed and the unit enabled', () => {
  assert.equal(stageIndex({ offerStatus: 'interested' }), 0);
  assert.equal(stageIndex({ offerStatus: 'interested', contractStatus: 'shared' }), 1);
  assert.equal(stageIndex({ offerStatus: 'interested', contractStatus: 'signed' }), 2);
  assert.equal(stageIndex({ offerStatus: 'enabled', contractStatus: 'active', unitStatus: 'rentable' }), 3);
});

test('a paused unit is still enabled; a withdrawn, declined or absent offer has nothing in progress', () => {
  assert.equal(stageIndex({ offerStatus: 'enabled', unitStatus: 'paused' }), 3);
  assert.equal(stageIndex({ offerStatus: 'withdrawn' }), -1);
  assert.equal(stageIndex({ offerStatus: 'declined', contractStatus: 'cancelled' }), -1);
  assert.equal(stageIndex({}), -1);
  assert.equal(stageIndex(), -1);
  assert.equal(stageIndex({ offerStatus: 'enabled', unitStatus: 'offboarded' }), -1);
});
