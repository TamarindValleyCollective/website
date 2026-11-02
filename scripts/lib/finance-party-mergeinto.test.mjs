// Run with: node --test scripts/lib/finance-party-mergeinto.test.mjs
// Merging two parties that are really one payee. Account rows are immutable and keep their original party, so a merge
// marks the duplicate as "merged into" the main party; the main party then shows (and is checked over) both sets of
// accounts. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMerge, foldMerged, sharedAccountFlags, partyForResponse } from './finance-parties.mjs';

const party = (id, over = {}) => ({ id, name: `Party ${id}`, kind: 'vendor', active: true, household_id: null, merged_into: null, ...over });
const acct = (id, partyId, over = {}) => ({ id, party_id: partyId, method: 'bank', status: 'verified', fingerprint: `f-${id}`, last4: '0001', created_at: '2026-01-01T00:00:00Z', retired_on: null, valid_from: null, has_ifsc: true, ...over });

test('a party can be merged into a different, unmerged party', () => {
  assert.deepEqual(validateMerge(party('a'), party('b'), {}), { ok: true });
});

test('merging is refused: into itself, a party already merged, into a merged party, or one that others were merged into', () => {
  assert.ok(validateMerge(party('a'), party('a'), {}).error);
  assert.ok(validateMerge(party('a', { merged_into: 'z' }), party('b'), {}).error);
  assert.ok(validateMerge(party('a'), party('b', { merged_into: 'z' }), {}).error);
  assert.ok(validateMerge(party('a'), party('b'), { sourceHasMergedIn: true }).error);
});

test('a member linked to a household cannot be merged away', () => {
  assert.ok(validateMerge(party('a', { kind: 'member', household_id: 'h1' }), party('b'), {}).error);
});

test('folding hides merged parties and gives the main party the accounts of both', () => {
  const parties = [party('a'), party('b', { merged_into: 'a' }), party('c')];
  const accounts = [acct('1', 'a'), acct('2', 'b'), acct('3', 'c')];
  const { visible, accountsOf, mergedCount } = foldMerged(parties, accounts);
  assert.deepEqual(visible.map((p) => p.id), ['a', 'c']);
  assert.deepEqual(accountsOf('a').map((x) => x.id), ['1', '2']);
  assert.deepEqual(accountsOf('c').map((x) => x.id), ['3']);
  assert.equal(mergedCount('a'), 1);
  assert.equal(mergedCount('c'), 0);
});

test('the same account held by a party and the party merged into it is not a "shared account"', () => {
  const accounts = [acct('1', 'a', { fingerprint: 'same' }), acct('2', 'b', { fingerprint: 'same' })];
  assert.equal(sharedAccountFlags(accounts).size, 2); // before merging: flagged on both
  assert.equal(sharedAccountFlags(accounts, new Map([['b', 'a']])).size, 0); // after: one payee
});

test('a genuinely different party holding the same account is still flagged after other merges', () => {
  const accounts = [acct('1', 'a', { fingerprint: 'same' }), acct('2', 'b', { fingerprint: 'same' }), acct('3', 'c', { fingerprint: 'same' })];
  const flags = sharedAccountFlags(accounts, new Map([['b', 'a']]));
  assert.deepEqual([...flags.keys()].sort(), ['1', '2', '3']);
});

test('after a merge the old and new bank accounts of one payee are flagged for review together', () => {
  const parties = [party('a'), party('b', { merged_into: 'a' })];
  const accounts = [acct('1', 'a', { created_at: '2026-03-01T00:00:00Z' }), acct('2', 'b', { created_at: '2026-01-01T00:00:00Z' })];
  const { visible, accountsOf, mergedCount } = foldMerged(parties, accounts);
  const out = partyForResponse(visible[0], accountsOf('a'), new Map(), '2026-06-15', mergedCount('a'));
  assert.equal(out.accounts.length, 2);
  assert.equal(out.needsReview, true);
  assert.equal(out.mergedCount, 1);
});
