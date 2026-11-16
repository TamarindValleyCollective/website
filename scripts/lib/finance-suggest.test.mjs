// Run with: node --test scripts/lib/finance-suggest.test.mjs
// Suggesting a category, party and "what it was for" from the bank's narration, the UPI remark and what has been posted
// before (docs/finance/FINANCE.md, "Suggestions"). Narration shapes follow the real statement; every name, number and
// amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, matchParty, normaliseName, parseNarration, candidateParties, payeeOf, proposeMissingParty, suggest } from './finance-suggest.mjs';

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

test('a line that names only a UPI ID is suggested under the name Razorpay gave for it, once looked up', () => {
  const l = line('UPI/P2A/123456789012/q000111222@ybl on PhonePe/Okbank/x');
  const base = { line: l, upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) };
  assert.equal(suggest(base).newParty.name, 'q000111222@ybl on PhonePe', 'without a lookup it is the bare ID, as before');
  const after = suggest({ ...base, vpaNames: { 'q000111222@ybl': 'TEST VENDOR WORKS' } });
  assert.equal(after.newParty.name, 'Test Vendor Works', 'a shouting bank name is made readable');
  assert.equal(after.newParty.kind, 'vendor');
  assert.ok(after.reasons.some((r) => r.includes('registered to "Test Vendor Works"')));
});

test('the name from a UPI lookup is matched to the register before a new party is offered', () => {
  const l = line('UPI/P2A/123456789012/q000111222@ybl on PhonePe/Okbank/x');
  const s = suggest({ line: l, upi: null, rules: [], parties: [{ id: 'P1', name: 'Test Vendor Works', kind: 'vendor' }], categories: [], history: buildHistory([]), vpaNames: { 'q000111222@ybl': 'TEST VENDOR WORKS' } });
  assert.equal(s.partyId, 'P1');
  assert.equal(s.newParty, null);
  assert.ok(s.reasons.some((r) => r.includes('registered to "TEST VENDOR WORKS"') && r.includes('Test Vendor Works')));
});

test('a payment gateway’s registered name is never suggested: the line stays as it was and a person names the payee', () => {
  const l = line('UPI/P2A/123456789012/q000111222@ybl on PhonePe/Okbank/x');
  const base = { line: l, upi: null, rules: [], parties: [{ id: 'P1', name: 'Razorpay Software', kind: 'vendor' }], categories: [], history: buildHistory([]) };
  const s = suggest({ ...base, vpaNames: { 'q000111222@ybl': 'RAZORPAY SOFTWARE PRIVATE LIMITED' } });
  assert.equal(s.partyId, null, 'not matched to a party of that name either');
  assert.equal(s.newParty.name, 'q000111222@ybl on PhonePe', 'as before the lookup');
  assert.equal(s.newParty.vpa, undefined, 'and no UPI ID carried to attach');
  const byId = suggest({ ...base, line: line('UPI/P2A/123456789012/razorpay.shop@icici on PhonePe/Okbank/x'), vpaNames: { 'razorpay.shop@icici': 'Some Merchant Name' } });
  assert.equal(byId.newParty.name, 'razorpay.shop@icici on PhonePe', 'an ID that starts with a gateway name is not trusted for a name either');
});

test('a lookup with no answer changes nothing, and a line without a UPI ID ignores the lookups', () => {
  const base = { rules: [], parties: [], categories: [], history: buildHistory([]), upi: null };
  assert.equal(suggest({ ...base, line: line('UPI/P2A/123456789012/q000111222@ybl on PhonePe/Okbank/x'), vpaNames: {} }).newParty.name, 'q000111222@ybl on PhonePe');
  assert.equal(suggest({ ...base, line: line('UPI/P2A/123456789012/Green Nursery/Okbank/x'), vpaNames: { 'q000111222@ybl': 'Someone Else' } }).newParty.name, 'Green Nursery');
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

test('the UPI app\'s own remark is the wording even when it has a bank-like word; the bank narration\'s segment keeps its stricter filter', () => {
  const none = { parties: [], categories: [], history: buildHistory([]), rules: [] };
  // The payer's own words are kept whole, whatever they contain.
  const kept = suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x'), upi: { counterparty: 'Test Traders', remarks: 'Bank transfer for the tent' }, ...none });
  assert.equal(kept.nature, 'Bank transfer for the tent');
  // A generic or letterless UPI remark is not a wording; the bank narration's own remark segment is the fallback.
  assert.equal(suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/Tent poles'), upi: { counterparty: 'Test Traders', remarks: 'NA' }, ...none }).nature, 'Tent poles');
  assert.equal(suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/x'), upi: { counterparty: 'Test Traders', remarks: '1234' }, ...none }).nature, '');
  // With no UPI record, a bank-name segment is still not taken as a wording.
  assert.equal(suggest({ line: line('UPI/P2A/123456789012/Test Traders/Okbank/State Bank'), upi: null, ...none }).nature, '');
});

test('what a matched Approval says is the suggested wording, ahead of the UPI remark and the bank narration; a rule\'s own template still wins', () => {
  const none = { parties: [], categories: [], history: buildHistory([]), rules: [] };
  const l = line('UPI/P2A/123456789012/Test Traders/Okbank/Tent poles');
  const upi = { counterparty: 'Test Traders', remarks: 'Poles' };
  const withApproval = suggest({ line: l, upi, ...none, purpose: 'Tent poles for the November workshop' });
  assert.equal(withApproval.nature, 'Tent poles for the November workshop');
  assert.ok(withApproval.reasons.some((r) => r.startsWith('The approved request says')));
  // No Approval matched, or an empty purpose: the UPI remark, as before.
  assert.equal(suggest({ line: l, upi, ...none, purpose: null }).nature, 'Poles');
  assert.equal(suggest({ line: l, upi, ...none, purpose: '  ' }).nature, 'Poles');
  // With no UPI record at all, the Approval still gives the wording.
  assert.equal(suggest({ line: line('NEFT/123456/123456789012/Test Traders'), upi: null, ...none, purpose: 'Fence repair' }).nature, 'Fence repair');
  // A rule that has its own wording template keeps it.
  const rules = [{ id: 'r1', priority: 1, active: true, matcher: { narrationContains: 'Test Traders' }, category_id: 'c1', party_id: null, nature_template: 'Monthly supplies', needs_review: false }];
  const cats = [{ id: 'c1', name: 'Supplies', type: 'opex', active: true }];
  assert.equal(suggest({ line: l, upi, parties: [], categories: cats, history: buildHistory([]), rules, purpose: 'Something else' }).nature, 'Monthly supplies');
});

test('nothing in a suggestion can be a name that is not in the narration, the register or the history', () => {
  const s = suggest({ line: line('Something unfamiliar'), upi: null, rules: [], parties: [], categories: [], history: buildHistory([]) });
  assert.equal(s.partyId, null);
  assert.equal(s.newParty, null);
  assert.equal(s.nature, '');
  assert.equal(s.confidence, 'none');
});

test('a posted line with no party gets the party its narration or UPI name matches, and only when that is certain', () => {
  const parties = [{ id: 'p1', name: 'Asha Rao' }, { id: 'p2', name: 'Asha Menon' }, { id: 'p3', name: 'Bright Hardware Pvt Ltd' }];
  const upiLine = (name) => ({ narration: `UPI/123456789012/12:00:00/${name}/payer@bank/maintenance`, direction: 'credit' });
  assert.deepEqual(proposeMissingParty({ line: upiLine('Asha Rao'), parties }), { partyId: 'p1', how: 'exact', from: 'Asha Rao' });
  assert.equal(proposeMissingParty({ line: upiLine('Asha'), parties }), null); // two Ashas: not certain
  assert.equal(proposeMissingParty({ line: upiLine('Stranger Person'), parties }), null);
  assert.equal(proposeMissingParty({ line: { narration: 'CASH DEP', direction: 'credit' }, parties }), null);
  // the Paytm report names someone the narration does not
  assert.equal(proposeMissingParty({ line: { narration: 'IMPS/x', direction: 'credit' }, upi: { counterparty: 'Bright Hardware' }, parties })?.partyId, 'p3');
  // narration and UPI disagree: left to a person
  assert.equal(proposeMissingParty({ line: upiLine('Asha Rao'), upi: { counterparty: 'Bright Hardware' }, parties }), null);
});

test('a payee is the same however the bank spells it, and candidates list every party the name could be', () => {
  const upiLine = (name) => ({ narration: `UPI/P2A/123456789012/${name}/Okbank/x`, direction: 'debit' });
  assert.equal(payeeOf({ line: upiLine('RAVI SHANKAR T') })?.key, payeeOf({ line: upiLine('Ravi Shankar T.') })?.key);
  assert.equal(payeeOf({ line: { narration: 'CASH DEP', direction: 'credit' } }), null);
  assert.equal(payeeOf({ line: { narration: 'CASH DEP', direction: 'credit' }, upi: { counterparty: 'Asha Rao' } })?.name, 'Asha Rao');
  const parties = [{ id: 'p1', name: 'Asha Rao' }, { id: 'p2', name: 'Asha Menon' }, { id: 'p3', name: 'Bright Hardware' }];
  assert.deepEqual(candidateParties('Asha', parties), []); // one short word: not enough to list anybody
  assert.deepEqual(candidateParties('ASHA RAO', parties).map((x) => x.id), ['p1']);
  assert.deepEqual(candidateParties('Asha R', parties).map((x) => x.id), ['p1']);
  assert.deepEqual(candidateParties('Ashwini Menon', parties), []);
  const two = [{ id: 'a', name: 'Rohan Kumar Singh' }, { id: 'b', name: 'Rohan Kumar Shah' }];
  assert.deepEqual(candidateParties('Rohan Kumar', two).map((x) => x.id), ['a', 'b']); // several fit: both offered
  assert.equal(proposeMissingParty({ line: upiLine('Rohan Kumar'), parties: two }), null); // but none is certain
});

test('a bank name with extra trailing words still finds the party whose name it starts with', () => {
  const parties = [{ id: 'p1', name: 'Green Traders' }, { id: 'p2', name: 'Ravi' }];
  assert.deepEqual(matchParty('Green Traders AND CO', parties), { partyId: 'p1', how: 'extended' });
  assert.equal(matchParty('Ravi Kumar Stores', parties), null, 'a one-word short name never claims a longer one');
  assert.deepEqual(candidateParties('Green Traders AND CO', parties).map((x) => x.id), ['p1']);
  const s = suggest({ line: line('NEFT/AXOIN123456789/GREEN TRADERS AND CO/UTIB/rent'), upi: null, rules: [], parties, categories: [], history: buildHistory([]) });
  assert.equal(s.partyId, 'p1');
  assert.equal(s.newParty, null);
});
