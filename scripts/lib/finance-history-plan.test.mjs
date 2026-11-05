// Run with: node --test scripts/lib/finance-history-plan.test.mjs
// Turning the matched tracker into allocations (docs/finance/sessions/06-history-load.md): the label mapping, the maintenance year, and the plan.
// Every name, narration and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlans, mapLabels, planAllocations } from './finance-history.mjs';

test('the sheet\'s labels map to categories', () => {
  const cat = (details, type = '') => mapLabels(details, type).categoryName;
  assert.equal(cat('Salary', 'Opex'), 'Salaries');
  assert.equal(cat('Groceries'), 'Groceries');
  assert.equal(cat('Bank Charges'), 'Bank charges');
  assert.equal(cat('Petty Cash'), 'Petty cash');
  assert.equal(cat('Telecom Charges'), 'Utility bills');
  assert.equal(cat('Power'), 'Utility bills');
  assert.equal(cat('Online Services'), 'Software and subscriptions');
  assert.equal(cat('Visit/Camp Revenue', 'Linger'), 'Hospitality receipts');
  assert.equal(cat('Event Revenue'), 'Event receipts');
  assert.equal(cat('Farm Expenses', 'Opex'), 'Operational and miscellaneous');
  assert.equal(cat('Miscelleaneous'), 'Operational and miscellaneous');
  assert.equal(cat('Parking Charges'), 'Operational and miscellaneous');
  assert.equal(cat('Taxes'), 'Land and local taxes');
  assert.equal(cat('Land Tax'), 'Land and local taxes');
  assert.equal(cat('Interest Earned'), 'Interest income');
  assert.equal(cat('FD Investment'), 'Sinking fund deposits');
  assert.equal(cat('CS Charges'), 'Professional fees');
  assert.equal(cat('CA/CS Charges'), 'Professional fees');
  assert.equal(cat('Insurance'), 'Insurance');
  assert.equal(cat('Donations'), 'Other income');
});

test('CBDT tax is a direct tax: Income tax', () => {
  assert.equal(mapLabels('CBDT Tax', '').categoryName, 'Income tax');
  assert.equal(mapLabels('Tax Refund', '').categoryName, 'Income tax');
});

test('labels are matched without regard to case or spacing', () => {
  assert.equal(mapLabels('  farm   EXPENSES ', '').categoryName, 'Operational and miscellaneous');
});

test('maintenance keeps its year, which can be an earlier year than the one it was paid in', () => {
  const m = mapLabels('Maintenance (24-25)', 'Member Contribution');
  assert.equal(m.categoryName, 'Member maintenance');
  assert.equal(m.maintenanceYear, '2024-25');
  assert.equal(mapLabels('Maintenance (25-26)', '').maintenanceYear, '2025-26');
  assert.equal(mapLabels('maintenance (99-00)', '').maintenanceYear, '1999-00');
  // A label whose years do not follow each other is not guessed at.
  assert.equal(mapLabels('Maintenance (24-26)', '').status, 'unmapped');
});

test('Farm Project goes to the Project bucket (a project, under a capital category); a Project type with no label does too', () => {
  const m = mapLabels('Farm Project', 'Project');
  assert.equal(m.project, true);
  assert.equal(m.categoryName, 'Structures and infrastructure');
  assert.equal(mapLabels('', 'Project').project, true);
});

test('Farm Capex needs a decision of its own: it defaults to Structures and infrastructure and says so', () => {
  const m = mapLabels('Farm Capex', 'Capex');
  assert.equal(m.categoryName, 'Structures and infrastructure');
  assert.equal(m.defaulted, true);
});

test('blank and unknown labels are left unallocated and told apart', () => {
  assert.equal(mapLabels('', '').status, 'blank');
  assert.equal(mapLabels('', 'Opex').status, 'blank');
  assert.equal(mapLabels('Something New', 'Opex').status, 'unmapped');
});

// ---- the plan
const categories = ['Salaries', 'Member maintenance', 'Operational and miscellaneous', 'Structures and infrastructure', 'Bank charges'].map((name, i) => ({ id: `c${i}`, name, active: true }));
const parties = [{ id: 'p-asha', name: 'Asha Rao', kind: 'member' }, { id: 'p-bob', name: 'Bob Kumar', kind: 'employee' }, { id: 'p-cara', name: 'Cara Singh', kind: 'employee' }];
// Member names, each linked to a household (one row per person and household).
const people = [{ id: 'pe-1', name: 'Asha Rao', household_id: 'h-asha' }, { id: 'pe-2', name: 'Dev Menon', household_id: 'h-dev' }, { id: 'pe-3', name: 'Dev Menon', household_id: 'h-dev2' }, { id: 'pe-4', name: 'Esha Pillai', household_id: 'h-esha' }, { id: 'pe-4', name: 'Esha Pillai', household_id: 'h-esha' }];
const row = (n, extra = {}) => ({ sheetRow: n, date: '2026-06-10', direction: 'debit', amountPaise: 10000, particulars: 'x', period: '2026-06-01', details: 'Farm Expenses', type: 'Opex', remarks: '', toName: '', fromName: '', financialYear: '2026-2027', ...extra });
const line = (id, paise = 10000) => ({ id, tran_date: '2026-06-10', direction: 'debit', amount_paise: paise });
const match = (pairs = [], groups = []) => ({ pairs, groups });

test('a one-to-one match becomes one allocation for the whole line, with the party named in the sheet and the sheet\'s month as its period', () => {
  const r = row(2, { toName: 'Bob Kumar', details: 'Salary', remarks: 'May', period: '2026-05-01' });
  const plan = planAllocations(match([{ row: r, line: line('L1'), how: 'exact' }]), { categories, parties, people });
  assert.equal(plan.plans.length, 1);
  const [a] = plan.plans[0].rows;
  assert.deepEqual([a.category_id, a.party_id, a.amount_paise, a.period, a.nature, a.source], ['c0', 'p-bob', 10000, '2026-05-01', 'May', 'import']);
  assert.equal(a.review_state, 'ok');
});

test('the wording is the remark, or else the label', () => {
  const [a] = planAllocations(match([{ row: row(2, { remarks: '' }), line: line('L1'), how: 'exact' }]), { categories, parties, people }).plans[0].rows;
  assert.equal(a.nature, 'Farm Expenses');
});

test('a credit takes its party from the From column', () => {
  const r = row(2, { direction: 'credit', fromName: 'Asha Rao', details: 'Maintenance (24-25)', type: 'Member Contribution' });
  const [a] = planAllocations(match([{ row: r, line: { ...line('L1'), direction: 'credit' }, how: 'exact' }]), { categories, parties, people }).plans[0].rows;
  assert.equal(a.party_id, 'p-asha');
});

test('a maintenance payment carries its maintenance year and the household of the member who paid, even when paid in a later year', () => {
  const r = row(2, { direction: 'credit', fromName: 'Asha Rao', details: 'Maintenance (24-25)', type: 'Member Contribution', period: '2026-06-01' });
  const out = planAllocations(match([{ row: r, line: { ...line('L1'), direction: 'credit' }, how: 'exact' }]), { categories, parties, people });
  const [a] = out.plans[0].rows;
  assert.equal(a.maintenance_year, '2024-25');
  assert.equal(a.household_id, 'h-asha');
  assert.equal(a.period, '2026-06-01', 'the period is when it was paid; the year says what it was for');
  assert.equal(out.counts.maintenanceArrears, 1, 'paid in 2026-27 for 2024-25');
});

test('a household comes from the member\'s name, matching the way a bank shortens it, and never from a name two households share', () => {
  const asHousehold = (fromName) => {
    const r = row(2, { direction: 'credit', fromName, details: 'Maintenance (25-26)', type: 'Member Contribution' });
    return planAllocations(match([{ row: r, line: { ...line('L1'), direction: 'credit' }, how: 'exact' }]), { categories, parties, people }).plans[0].rows[0].household_id;
  };
  assert.equal(asHousehold('ASHA RAO'), 'h-asha');
  assert.equal(asHousehold('Esha Pill'), 'h-esha', 'a shortened name');
  assert.equal(asHousehold('Dev Menon'), null, 'two different households have a Dev Menon');
  assert.equal(asHousehold('Nobody Known'), null);
});

test('a couple written as "First & First" finds the one household that has both of them, and ambiguity finds none', () => {
  const folks = [
    { id: 'a1', name: 'Rahul Verma', household_id: 'h-verma' }, { id: 'a2', name: 'Priya Verma', household_id: 'h-verma' },
    { id: 'b1', name: 'Rahul Singh', household_id: 'h-singh' }, { id: 'b2', name: 'Kavya Singh', household_id: 'h-singh' },
    { id: 'c1', name: 'Meera Das', household_id: 'h-das' },
  ];
  const asHousehold = (fromName) => {
    const r = row(2, { direction: 'credit', fromName, details: 'Maintenance (25-26)', type: 'Member Contribution' });
    return planAllocations(match([{ row: r, line: { ...line('L1'), direction: 'credit' }, how: 'exact' }]), { categories, parties, people: folks }).plans[0].rows[0].household_id;
  };
  assert.equal(asHousehold('Rahul & Priya'), 'h-verma');
  assert.equal(asHousehold('Rahul & Kavya'), 'h-singh');
  assert.equal(asHousehold('PRIYA & RAHUL'), 'h-verma', 'either order, any case');
  assert.equal(asHousehold('Rahul & Meera'), null, 'no household has both');
  assert.equal(asHousehold('Rahul & Sunita'), null);
  assert.equal(asHousehold('Rahul Verma & Priya Verma'), 'h-verma', 'full names work too');
  assert.equal(asHousehold('Rahul'), null, 'one first name alone is not enough');
  assert.equal(asHousehold('Meera Das'), 'h-das');
});

test('maintenance from someone who is not a known member is still loaded, with the household left for a person and counted', () => {
  const r = row(2, { direction: 'credit', fromName: 'Stranger Name', details: 'Maintenance (25-26)', type: 'Member Contribution' });
  const out = planAllocations(match([{ row: r, line: { ...line('L1'), direction: 'credit' }, how: 'exact' }]), { categories, parties, people });
  assert.equal(out.plans[0].rows[0].household_id, null);
  assert.equal(out.plans[0].rows[0].maintenance_year, '2025-26');
  assert.equal(out.counts.maintenanceWithoutHousehold, 1);
  assert.deepEqual(out.householdWanted, [{ sheetRow: 2, name: 'Stranger Name', date: '2026-06-10', direction: 'credit', amountPaise: 10000, remarks: '', maintenanceYear: '2025-26' }], 'listed with who and how much, so a person can attribute it');
});

test('a Farm Project row names the placeholder project for its financial year', () => {
  const out = planAllocations(match([{ row: row(2, { details: 'Farm Project', type: 'Project', financialYear: '2025-2026' }), line: line('L1'), how: 'exact' }]), { categories, parties, people });
  assert.equal(out.plans[0].rows[0].projectFy, 2025);
  assert.equal(out.plans[0].rows[0].category_id, 'c3');
});

test('a salary batch becomes one allocation per person on the one line, and the amounts add up to the line', () => {
  const rows = [row(2, { toName: 'Bob Kumar', details: 'Salary', amountPaise: 6000 }), row(3, { toName: 'Cara Singh', details: 'Salary', amountPaise: 4000 })];
  const out = planAllocations(match([], [{ rows, line: line('S', 10000) }]), { categories, parties, people });
  assert.equal(out.plans.length, 1);
  assert.deepEqual(out.plans[0].rows.map((a) => [a.party_id, a.amount_paise]), [['p-bob', 6000], ['p-cara', 4000]]);
});

test('a group with any row that cannot be labelled is left whole for a person: allocations must add up to the line', () => {
  const rows = [row(2, { details: 'Salary', amountPaise: 6000 }), row(3, { details: '', type: '', amountPaise: 4000 })];
  const out = planAllocations(match([], [{ rows, line: line('S', 10000) }]), { categories, parties, people });
  assert.equal(out.plans.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['Part of a group with a row that has no label.']);
});

test('rows with no label, an unknown label or a missing category are skipped with their reason and sheet row', () => {
  const out = planAllocations(
    match([
      { row: row(2, { details: '', type: '' }), line: line('A'), how: 'exact' },
      { row: row(3, { details: 'Something New' }), line: line('B'), how: 'exact' },
      { row: row(4, { details: 'Insurance' }), line: line('C'), how: 'exact' }, // no Insurance category in the fixture
    ]),
    { categories, parties },
  );
  assert.equal(out.plans.length, 0);
  assert.deepEqual(out.skipped.map((s) => [s.sheetRow, s.kind]), [[2, 'blank'], [3, 'unmapped'], [4, 'no category']]);
});

test('an approximate match is posted but sent to review, because the date or the line was a judgement', () => {
  const out = planAllocations(match([{ row: row(2), line: line('L1'), how: 'near date' }, { row: row(3, { details: 'Bank Charges' }), line: line('L2'), how: 'reference' }, { row: row(4), line: line('L3'), how: 'exact' }]), { categories, parties, people });
  assert.deepEqual(out.plans.map((p) => p.rows[0].review_state), ['needs_review', 'needs_review', 'ok']);
  assert.equal(out.plans[0].rows[0].review_reason, 'import_approximate');
});

test('the counts say how many allocations and by which category', () => {
  const out = planAllocations(match([{ row: row(2), line: line('A'), how: 'exact' }, { row: row(3, { details: 'Bank Charges' }), line: line('B'), how: 'exact' }, { row: row(4), line: line('C'), how: 'exact' }]), { categories, parties, people });
  assert.equal(out.counts.allocations, 3);
  assert.deepEqual(out.counts.byCategory, { 'Operational and miscellaneous': 2, 'Bank charges': 1 });
});

// ---- applying
function fakeStore({ already = [], failOn = [] } = {}) {
  const saved = [];
  return {
    saved,
    projects: [],
    async allocatedLineIds() { return new Set(already); },
    async projectFor(fy) { const id = `proj-${fy}`; if (!this.projects.includes(id)) this.projects.push(id); return id; },
    async save(lineId, rows) {
      if (failOn.includes(lineId)) throw new Error('boom');
      saved.push({ lineId, rows });
    },
  };
}
const plansOf = (...ids) => ids.map((id) => ({ lineId: id, rows: [{ category_id: 'c0', amount_paise: 1, projectFy: id === 'P' ? 2025 : undefined }] }));

test('applying saves each planned line once, skips lines that already have allocations, and a failure does not stop the rest', async () => {
  const store = fakeStore({ already: ['B'], failOn: ['C'] });
  const result = await applyPlans(plansOf('A', 'B', 'C', 'D'), store);
  assert.deepEqual(store.saved.map((s) => s.lineId), ['A', 'D']);
  assert.equal(result.saved, 2);
  assert.equal(result.skippedExisting, 1);
  assert.deepEqual(result.failed.map((f) => f.lineId), ['C']);
});

test('applying resolves a placeholder project once per financial year and sends its id, not the year', async () => {
  const store = fakeStore();
  await applyPlans(plansOf('P', 'Q'), store);
  const withProject = store.saved.find((s) => s.lineId === 'P');
  assert.equal(withProject.rows[0].project_id, 'proj-2025');
  assert.equal('projectFy' in withProject.rows[0], false);
  assert.deepEqual(store.projects, ['proj-2025']);
});

test('re-running changes nothing: the second run finds every line already allocated', async () => {
  const first = fakeStore();
  await applyPlans(plansOf('A', 'B'), first);
  const second = fakeStore({ already: ['A', 'B'] });
  const result = await applyPlans(plansOf('A', 'B'), second);
  assert.equal(result.saved, 0);
  assert.equal(result.skippedExisting, 2);
  assert.equal(second.saved.length, 0);
});
