// Run with: node --test scripts/lib/finance-rules.test.mjs
// The categorisation rules engine and the review flags (docs/finance/DESIGN.md). Every name and amount is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_REASONS, applyRules, matchRule, proposeAllocation, reviewReasons, validateRule } from './finance-rules.mjs';

const line = { id: 'L1', direction: 'debit', amount_paise: 250000, narration: 'UPI/P2A/123456789012/Green Nursery/Okbank/Plants', tran_date: '2026-10-12' };
const upi = { counterparty: 'Green Nursery', remarks: 'Mango saplings', is_circle: false, upi_ref: '123456789012' };
const rule = (id, matcher, result = {}, extra = {}) => ({ id, priority: 100, active: true, matcher, party_id: null, category_id: 'c-plants', nature_template: '', needs_review: false, ...result, ...extra });

test('a rule matches when every condition it states holds', () => {
  assert.equal(matchRule(rule('r', { narrationContains: 'green nursery' }), line, upi), true);
  assert.equal(matchRule(rule('r', { narrationContains: 'green nursery', direction: 'credit' }), line, upi), false);
  assert.equal(matchRule(rule('r', { remarkKeywords: ['sapling'] }), line, upi), true);
  assert.equal(matchRule(rule('r', { remarkKeywords: ['onion', 'gas'] }), line, upi), false);
  assert.equal(matchRule(rule('r', { remarkKeywords: ['onion', 'sapling'] }), line, upi), true); // any keyword
  assert.equal(matchRule(rule('r', { minPaise: 300000 }), line, upi), false);
  assert.equal(matchRule(rule('r', { minPaise: 100000, maxPaise: 250000 }), line, upi), true);
  assert.equal(matchRule(rule('r', { payeeVpa: 'nursery@okbank' }), line, { ...upi, vpa: 'Nursery@OkBank' }), true);
});

test('a rule with no conditions never matches (it would swallow everything)', () => {
  assert.equal(matchRule(rule('r', {}), line, upi), false);
});

test('an inactive rule does not match, and a missing UPI row only fails UPI conditions', () => {
  assert.equal(matchRule(rule('r', { narrationContains: 'nursery' }, {}, { active: false }), line, upi), false);
  assert.equal(matchRule(rule('r', { narrationContains: 'nursery' }), line, null), true);
  assert.equal(matchRule(rule('r', { remarkKeywords: ['sapling'] }), line, null), false);
});

test('the lowest priority number wins, then the oldest rule', () => {
  const rules = [
    rule('b', { narrationContains: 'nursery' }, { category_id: 'c-b' }, { priority: 50 }),
    rule('a', { narrationContains: 'nursery' }, { category_id: 'c-a' }, { priority: 10 }),
    rule('c', { narrationContains: 'nursery' }, { category_id: 'c-c' }, { priority: 10 }),
  ];
  assert.equal(applyRules(rules, line, upi).rule.id, 'a');
  assert.equal(applyRules([], line, upi), null);
});

test('a proposal fills party, category and nature, and the rule decides whether it is always reviewed', () => {
  const r = rule('r1', { narrationContains: 'nursery' }, { party_id: 'p-nursery', nature_template: 'Plants from {counterparty}: {remark}', needs_review: true });
  const p = proposeAllocation(line, upi, [r]);
  assert.equal(p.source, 'rule');
  assert.equal(p.ruleId, 'r1');
  assert.equal(p.partyId, 'p-nursery');
  assert.equal(p.categoryId, 'c-plants');
  assert.equal(p.nature, 'Plants from Green Nursery: Mango saplings');
  assert.equal(p.amountPaise, 250000);
  assert.equal(p.period, '2026-10-01');
  assert.equal(p.needsReview, true);
});

test('with no template the farm manager\'s own UPI remark seeds the nature', () => {
  const p = proposeAllocation(line, upi, [rule('r1', { narrationContains: 'nursery' })]);
  assert.equal(p.nature, 'Mango saplings');
  assert.equal(proposeAllocation(line, { ...upi, remarks: '' }, [rule('r1', { narrationContains: 'nursery' })]).nature, '');
});

test('with no rule there is no proposal for a category, but the remark still seeds a nature', () => {
  const p = proposeAllocation(line, upi, []);
  assert.equal(p.source, 'upi_remark');
  assert.equal(p.categoryId, null);
  assert.equal(p.nature, 'Mango saplings');
  assert.equal(proposeAllocation(line, null, []), null);
});

test('flags: nothing explains the line', () => {
  assert.deepEqual(reviewReasons({ line, proposal: null }), ['unexplained']);
});

test('flags: a circle payment to the requester\'s own party', () => {
  const ctx = { line, upi: { ...upi, is_circle: true }, proposal: { partyId: 'p-fm', categoryId: 'c1', source: 'rule' }, requesterPartyIds: ['p-fm'] };
  assert.ok(reviewReasons(ctx).includes('circle_to_requester'));
  assert.ok(!reviewReasons({ ...ctx, requesterPartyIds: ['someone-else'] }).includes('circle_to_requester'));
  assert.ok(!reviewReasons({ ...ctx, upi: { ...upi, is_circle: false } }).includes('circle_to_requester'));
});

test('flags: a payment to a party whose live account is new, changed or unverified', () => {
  const ctx = { line, proposal: { partyId: 'p1', categoryId: 'c1', source: 'rule' }, partyAccountState: 'unverified' };
  assert.ok(reviewReasons(ctx).includes('new_payee_account'));
  assert.ok(!reviewReasons({ ...ctx, partyAccountState: 'verified' }).includes('new_payee_account'));
  // Money coming in is not a payee risk.
  assert.ok(!reviewReasons({ ...ctx, line: { ...line, direction: 'credit' } }).includes('new_payee_account'));
});

test('flags: a reimbursement with no bill', () => {
  const ctx = { line, proposal: { partyId: 'p1', categoryId: 'c-reimb', source: 'rule' }, categoryType: 'reimbursement', hasVoucher: false };
  assert.ok(reviewReasons(ctx).includes('reimbursement_without_bill'));
  assert.ok(!reviewReasons({ ...ctx, hasVoucher: true }).includes('reimbursement_without_bill'));
  assert.ok(!reviewReasons({ ...ctx, categoryType: 'opex' }).includes('reimbursement_without_bill'));
});

test('flags: a rule that must always be reviewed', () => {
  const ctx = { line, proposal: { partyId: 'p1', categoryId: 'c1', source: 'rule', needsReview: true } };
  assert.deepEqual(reviewReasons(ctx), ['rule_requires_review']);
});

test('every reason has a plain-words label', () => {
  for (const r of ['unexplained', 'circle_to_requester', 'new_payee_account', 'reimbursement_without_bill', 'rule_requires_review']) {
    assert.ok(typeof REVIEW_REASONS[r] === 'string' && REVIEW_REASONS[r].length > 5, r);
  }
});

test('a payment to the requester\'s own party is treated as a reimbursement', () => {
  const p = proposeAllocation(line, upi, [], { requesterPartyIds: ['p-fm'], partyId: 'p-fm', reimbursementCategoryId: 'c-reimb' });
  assert.equal(p.categoryId, 'c-reimb');
  assert.equal(p.partyId, 'p-fm');
  assert.equal(p.reimbursement, true);
  assert.equal(p.nature, 'Mango saplings');
});

test('rule validation: needs a condition and a category, and rejects nonsense', () => {
  assert.equal(validateRule({ matcher: { narrationContains: 'gas' }, categoryId: 'c1', priority: 10 }).ok, true);
  assert.equal(validateRule({ matcher: {}, categoryId: 'c1' }).ok, false);
  assert.equal(validateRule({ matcher: { narrationContains: 'gas' }, categoryId: '' }).ok, false);
  assert.equal(validateRule({ matcher: { narrationContains: 'ab' }, categoryId: 'c1' }).ok, false); // too short to be safe
  assert.equal(validateRule({ matcher: { minPaise: 500, maxPaise: 100 }, categoryId: 'c1' }).ok, false);
  assert.equal(validateRule({ matcher: { direction: 'sideways' }, categoryId: 'c1' }).ok, false);
});
