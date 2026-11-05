// Run with: node --test scripts/lib/finance-suggest.test.mjs
// Suggesting a category, party and "what it was for" from the bank's narration, the UPI remark and what has been posted
// before (docs/finance/FINANCE.md, "Suggestions"). Narration shapes follow the real statement; every name, number and
// amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, matchParty, normaliseName, parseNarration, suggest } from './finance-suggest.mjs';

const line = (narration, direction = 'debit', amount = 150000) => ({ id: 'L', narration, direction, amount_paise: amount, tran_date: '2026-10-12' });

test('a UPI narration gives the counterparty, the bank and the payer\'s remark', () => {
  const p = parseNarration('UPI/P2A/123456789012/Green Nursery/Okbank/Mango saplings');
  assert.equal(p.mode, 'upi');
  assert.equal(p.counterparty, 'Green Nursery');
  assert.equal(p.remark, 'Mango saplings');
});

test('a net-banking NEFT gives the payee from its fourth part, and a remark only when it is not a bank name', () => {
  const a = parseNarration('INB/NEFT/AXIC123456789012/Test Traders/Milk and curd');
  assert.equal(a.mode, 'neft');
  assert.equal(a.counterparty, 'Test Traders');
  assert.equal(a.remark, 'Milk and curd');
  const b = parseNarration('INB/NEFT/AXOIC12345678901/Test Traders/STATE BANK OF TESTLAND');
  assert.equal(b.counterparty, 'Test Traders');
  assert.equal(b.remark, null);
  const c = parseNarration('NEFT/DH/AXODH12345678901/Asha Rao/HDFC0001234/x');
  assert.equal(c.counterparty, 'Asha Rao');
  assert.equal(c.remark, null);
});

test('IMPS gives a name unless the part is only digits, and a bare NEFT has no one named', () => {
  assert.equal(parseNarration('IMPS/P2A/123456789012/Asha Rao/HDFC/x').counterparty, 'Asha Rao');
  assert.equal(parseNarration('IMPS/P2A/123456789012/123456789012345/').counterparty, null);
  assert.equal(parseNarration('NEFT/12345678901/9/').counterparty, null);
});

test('card payments give the merchant without the gateway noise', () => {
  const a = parseNarration('ECOM PUR/IND*BSNL/MUMBAI/123456/12:30/1');
  assert.equal(a.mode, 'card');
  assert.equal(a.counterparty, 'BSNL');
  assert.equal(parseNarration('POS/GOOGLE WORKSPACE/CITY/123456').counterparty, 'Google Workspace');
});

test('the bank\'s own entries are recognised: charges, tax on them, interest, cash', () => {
  assert.equal(parseNarration('Monthly Service Chrgs').mode, 'charges');
  assert.equal(parseNarration('GST @18% on Monthly Service Chrgs').mode, 'charges_tax');
  assert.equal(parseNarration('INT.PD:01-07-2026 to 30-09-2026', 'credit').mode, 'interest');
  assert.equal(parseNarration('ATM-CASH/WDL/Test branch').mode, 'cash_out');
  assert.equal(parseNarration('SAK/CASH DEP/Test branch', 'credit').mode, 'cash_in');
  assert.equal(parseNarration('Something unfamiliar').mode, 'other');
});

test('names are compared without case, punctuation or company suffixes', () => {
  assert.equal(normaliseName('GREEN  NURSERY PVT. LTD.'), 'green nursery');
  assert.equal(normaliseName('M/s Test Traders'), 'test traders');
});

test('a party matches exactly, or by the shortened name a bank prints, but never when two fit', () => {
  const parties = [{ id: 'p1', name: 'Green Nursery' }, { id: 'p2', name: 'Rudiraksha Madhavan' }, { id: 'p3', name: 'Asha Rao' }, { id: 'p4', name: 'Asha Raman' }];
  assert.deepEqual(matchParty('GREEN NURSERY', parties), { partyId: 'p1', how: 'exact' });
  assert.deepEqual(matchParty('Rudira Madha', parties), { partyId: 'p2', how: 'shortened' }); // the bank cuts long names
  assert.equal(matchParty('Asha Ra', parties), null); // fits Asha Rao and Asha Raman
  assert.equal(matchParty('Green', parties), null); // one short word is too loose
  assert.equal(matchParty('Somebody Else', parties), null);
});

test('with nothing to go on there is nothing to suggest, but a named stranger is offered as a new party', () => {
  const s = suggest({ line: line('INB/NEFT/AXIC123456789012/New Vendor Works/Milk'), upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) });
  assert.equal(s.categoryId, null);
  assert.equal(s.newParty.name, 'New Vendor Works');
  assert.equal(s.newParty.kind, 'vendor');
  assert.equal(s.nature, 'Milk');
  assert.ok(s.reasons.some((r) => /not in the register/i.test(r)));
  // Money coming in from a stranger is offered as a customer, and a bare NEFT offers no one.
  assert.equal(suggest({ line: line('IMPS/P2A/123456789012/New Payer/HDFC/x', 'credit'), upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) }).newParty.kind, 'customer');
  assert.equal(suggest({ line: line('NEFT/12345678901/9/'), upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) }).newParty, null);
});

test('a rule beats everything else and is explained', () => {
  const rules = [{ id: 'r1', priority: 10, active: true, matcher: { narrationContains: 'green nursery' }, party_id: 'p1', category_id: 'c-plants', nature_template: 'Plants from {counterparty}', needs_review: false }];
  const s = suggest({
    line: line('UPI/P2A/123456789012/Green Nursery/Okbank/x'),
    upi: { counterparty: 'Green Nursery', remarks: 'Mango' },
    rules, parties: [{ id: 'p1', name: 'Green Nursery' }], categories: [{ id: 'c-plants', name: 'Plantation and nursery', type: 'capex', active: true }], history: buildHistory([]),
  });
  assert.equal(s.source, 'rule');
  assert.equal(s.categoryId, 'c-plants');
  assert.equal(s.partyId, 'p1');
  assert.equal(s.nature, 'Plants from Green Nursery');
  assert.equal(s.confidence, 'high');
  assert.ok(s.reasons[0].startsWith('Rule'));
});

test('earlier postings teach it: the same party usually means the same category and wording', () => {
  const parties = [{ id: 'p1', name: 'Green Nursery' }];
  const past = (cat, nature) => ({ narration: 'UPI/P2A/123456789012/Green Nursery/Okbank/x', direction: 'debit', party_id: 'p1', category_id: cat, nature });
  const history = buildHistory([past('c-plants', 'Seedlings'), past('c-plants', 'Seedlings'), past('c-plants', 'Pots'), past('c-plants', 'Seedlings')]);
  const s = suggest({ line: line('INB/NEFT/AXIC123456789012/GREEN NURSERY/x'), upi: null, rules: [], parties, categories: [{ id: 'c-plants', name: 'Plantation and nursery', type: 'capex', active: true }], history });
  assert.equal(s.partyId, 'p1');
  assert.equal(s.categoryId, 'c-plants');
  assert.equal(s.nature, 'Seedlings');
  assert.equal(s.confidence, 'high');
  assert.ok(s.reasons.some((r) => /4 earlier/.test(r)));
});

test('a party that has gone to different categories gets a medium suggestion, or none when it is a coin toss', () => {
  const parties = [{ id: 'p1', name: 'Test Traders' }];
  const past = (cat) => ({ narration: 'UPI/P2A/123456789012/Test Traders/Okbank/x', direction: 'debit', party_id: 'p1', category_id: cat, nature: 'Goods' });
  const cats = [{ id: 'ca', name: 'A', type: 'opex', active: true }, { id: 'cb', name: 'B', type: 'opex', active: true }];
  const lopsided = suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x'), upi: null, rules: [], parties, categories: cats, history: buildHistory([past('ca'), past('ca'), past('ca'), past('cb')]) });
  assert.equal(lopsided.categoryId, 'ca');
  assert.equal(lopsided.confidence, 'medium');
  const tossup = suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x'), upi: null, rules: [], parties, categories: cats, history: buildHistory([past('ca'), past('cb')]) });
  assert.equal(tossup.categoryId, null);
  assert.equal(tossup.partyId, 'p1');
});

test('history is by direction: what we paid a party is not what they paid us', () => {
  const parties = [{ id: 'p1', name: 'Test Traders' }];
  const history = buildHistory([{ narration: 'UPI/P2A/123456789012/Test Traders/Okbank/x', direction: 'credit', party_id: 'p1', category_id: 'c-income', nature: 'Refund' }]);
  const s = suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x', 'debit'), upi: null, rules: [], parties, categories: [{ id: 'c-income', name: 'Other income', type: 'revenue', active: true }], history });
  assert.equal(s.categoryId, null);
});

test('history works from the name alone when the party was never recorded on the posting', () => {
  const past = { narration: 'INB/NEFT/AXIC123456789012/Milk Dairy/x', direction: 'debit', party_id: null, category_id: 'c-groc', nature: 'Milk' };
  const s = suggest({ line: line('INB/NEFT/AXIC999999999999/MILK DAIRY/y'), upi: null, rules: [], parties: [], categories: [{ id: 'c-groc', name: 'Groceries', type: 'opex', active: true }], history: buildHistory([past, past, past]) });
  assert.equal(s.categoryId, 'c-groc');
  assert.equal(s.nature, 'Milk');
});

test('the bank\'s own entries get a category by name when it exists, and are always high confidence', () => {
  const categories = [{ id: 'c-bank', name: 'Bank charges', type: 'opex', active: true }, { id: 'c-int', name: 'Interest income', type: 'interest', active: true }, { id: 'c-pc', name: 'Petty cash', type: 'opex', active: true }];
  const base = { upi: null, rules: [], parties: [], categories, history: buildHistory([]) };
  const charges = suggest({ ...base, line: line('Monthly Service Chrgs', 'debit', 29500) });
  assert.equal(charges.categoryId, 'c-bank');
  assert.equal(charges.nature, 'Bank charges');
  assert.equal(charges.confidence, 'high');
  assert.equal(suggest({ ...base, line: line('GST @18% on Monthly Service Chrgs', 'debit', 5300) }).nature, 'GST on bank charges');
  assert.equal(suggest({ ...base, line: line('INT.PD:01-07-2026 to 30-09-2026', 'credit', 90000) }).categoryId, 'c-int');
  assert.equal(suggest({ ...base, line: line('ATM-CASH/WDL/Test branch') }).categoryId, 'c-pc');
  // Without such a category there is simply no category suggestion.
  assert.equal(suggest({ ...base, categories: [], line: line('Monthly Service Chrgs') }).categoryId, null);
});

test('a retired category is never suggested', () => {
  const categories = [{ id: 'c-bank', name: 'Bank charges', type: 'opex', active: false }];
  assert.equal(suggest({ line: line('Monthly Service Chrgs'), upi: null, rules: [], parties: [], categories, history: buildHistory([]) }).categoryId, null);
  const past = { narration: 'UPI/P2A/123456789012/Test Traders/Okbank/x', direction: 'debit', party_id: 'p1', category_id: 'c-old', nature: 'Goods' };
  const s = suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x'), upi: null, rules: [], parties: [{ id: 'p1', name: 'Test Traders' }], categories: [{ id: 'c-old', name: 'Old', type: 'opex', active: false }], history: buildHistory([past, past, past]) });
  assert.equal(s.categoryId, null);
});

test('the farm manager\'s own UPI remark is the wording, and a payment to the requester is a reimbursement', () => {
  const parties = [{ id: 'p-fm', name: 'Test Manager' }];
  const categories = [{ id: 'c-reimb', name: 'Reimbursements', type: 'reimbursement', active: true }];
  const s = suggest({ line: line('UPI/P2A/123456789012/Test Manager/Okbank/Onion'), upi: { counterparty: 'Test Manager', remarks: 'Onion' }, rules: [], parties, categories, history: buildHistory([]), requesterPartyIds: ['p-fm'] });
  assert.equal(s.partyId, 'p-fm');
  assert.equal(s.categoryId, 'c-reimb');
  assert.equal(s.nature, 'Onion');
  assert.equal(s.reimbursement, true);
});

test('nothing in a suggestion can be a name that is not in the narration, the register or the history', () => {
  const s = suggest({ line: line('Something unfamiliar'), upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) });
  assert.equal(s.partyId, null);
  assert.equal(s.newParty, null);
  assert.equal(s.nature, '');
  assert.equal(s.confidence, 'none');
});
