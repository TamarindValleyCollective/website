// Run with: node --test scripts/lib/member-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdReview, reviewTotals } from './member-review.mjs';

const base = () => ({
  households: [{ id: 'h1', farm_unit: 'F-27', house_no: 'H-17', cluster: 'H1-A', unit_type: 'DG1' }],
  people: [
    { id: 'p1', full_name: 'Asha Rao', email: 'secret@example.com', phone: null },
    { id: 'p2', full_name: 'Ravi Rao', email: null, phone: null },
  ],
  memberships: [
    { household_id: 'h1', person_id: 'p1', role: 'owner', can_login: false },
    { household_id: 'h1', person_id: 'p2', role: 'owner', can_login: false },
  ],
  plots: [{ household_id: 'h1', patta_no: '1971', reference_no: '31/12/081/01971/80138', survey_no: '469/2A', area_hectares: '0.4050', area_acres: '1.00', settlement: null }],
  housePattas: [{ household_id: 'h1', patta_no: '1971', reference_no: null, survey_no: null, area_sq_ft: '1200', settlement: null }],
  notes: [],
});

test('never exposes email or phone values, only whether they exist', () => {
  const [h] = buildHouseholdReview(base());
  assert.deepEqual(h.people.map((p) => p.hasEmail), [true, false]);
  assert.ok(!JSON.stringify(h).includes('secret@example.com'));
});

test('a complete household has only the info-level missing-email flag', () => {
  const [h] = buildHouseholdReview(base());
  assert.deepEqual(h.flags.map((f) => f.kind), ['missing_email']);
  assert.equal(reviewTotals([h]).householdsNeedingAttention, 0);
});

test('flags gaps, a third person, a mismatched patta and a patta issue, most severe first', () => {
  const data = base();
  data.people.push({ id: 'p3', full_name: 'Third Person', email: null, phone: null });
  data.memberships.push({ household_id: 'h1', person_id: 'p3', role: 'owner', can_login: false });
  data.plots[0].patta_no = '2417';
  data.housePattas = [];
  data.notes = [{ household_id: 'h1', kind: 'patta_issue' }];
  const [h] = buildHouseholdReview(data);
  const kinds = h.flags.map((f) => f.kind);
  for (const k of ['over_two_people', 'patta_number_mismatch', 'patta_issue', 'no_house_patta', 'missing_email']) assert.ok(kinds.includes(k), k);
  assert.equal(h.flags[0].severity, 'warn');
  assert.equal(h.flags.at(-1).severity, 'info');
  assert.equal(reviewTotals([h]).householdsNeedingAttention, 1);
});

test('a household without a house is informational, without patta is a warning', () => {
  const data = base();
  data.households[0].house_no = null;
  data.plots = [];
  const [h] = buildHouseholdReview(data);
  assert.equal(h.flags.find((f) => f.kind === 'no_house').severity, 'info');
  assert.equal(h.flags.find((f) => f.kind === 'no_farm_patta').severity, 'warn');
  assert.ok(!h.flags.some((f) => f.kind === 'no_house_patta'));
});

test('sums farm acres, hectares and house sq ft per household and overall, and reports rows with no area', () => {
  const data = base();
  data.plots.push({ household_id: 'h1', patta_no: '2013', reference_no: null, survey_no: '437/2', area_hectares: '0.4700', area_acres: '1.16', settlement: null });
  data.plots.push({ household_id: 'h1', patta_no: '1960', reference_no: null, survey_no: null, area_hectares: null, area_acres: null, settlement: null });
  data.housePattas.push({ household_id: 'h1', patta_no: '2744', reference_no: null, survey_no: null, area_sq_ft: '800.5', settlement: null });
  const reviewed = buildHouseholdReview(data);
  assert.equal(reviewed[0].farmAcres, 2.16);
  assert.equal(reviewed[0].farmHectares, 0.875);
  assert.equal(reviewed[0].houseSqFt, 2000.5);
  assert.equal(reviewed[0].plotsMissingArea, 1);
  const totals = reviewTotals(reviewed);
  assert.equal(totals.farmAcres, 2.16);
  assert.equal(totals.houseSqFt, 2000.5);
});
