// Run with: node --test scripts/lib/member-edit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEdit, auditDetail, ACTION_CAPABILITY } from './member-edit.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const good = (body) => {
  const r = validateEdit(body);
  assert.ok(r.ok, `expected ok, got: ${r.error}`);
  return r.edit;
};
const bad = (body) => {
  const r = validateEdit(body);
  assert.equal(r.ok, false);
  return r.error;
};

test('rejects anything that is not a known action', () => {
  assert.match(bad(null), /Nothing to do/);
  assert.match(bad({}), /Nothing to do/);
  assert.match(bad({ action: 'drop.table' }), /Unknown action/);
  assert.match(bad('person.update'), /Nothing to do/);
});

test('every action maps to the edit or manage capability', () => {
  for (const cap of Object.values(ACTION_CAPABILITY)) assert.ok(['edit', 'manage'].includes(cap));
  assert.equal(ACTION_CAPABILITY['person.update'], 'edit');
  assert.equal(ACTION_CAPABILITY['household.update'], 'manage');
  assert.equal(ACTION_CAPABILITY['plot.delete'], 'manage');
});

test('ids must be real UUIDs', () => {
  assert.match(bad({ action: 'person.update', personId: 'abc', fullName: 'A' }), /personId/);
  assert.match(bad({ action: 'person.update', fullName: 'A' }), /personId/);
  assert.match(bad({ action: 'plot.delete', plotId: "1' or '1'='1" }), /plotId/);
});

test('person.update: name, email and phone, each optional, at least one required', () => {
  assert.deepEqual(good({ action: 'person.update', personId: A, fullName: '  Asha   Rao ' }), { action: 'person.update', personId: A, fullName: 'Asha Rao' });
  assert.match(bad({ action: 'person.update', personId: A }), /Nothing to change/);
  assert.match(bad({ action: 'person.update', personId: A, fullName: '   ' }), /Name is required/);
  assert.match(bad({ action: 'person.update', personId: A, fullName: 'x'.repeat(121) }), /too long/);
});

test('email: lower-cased, validated, null or empty removes it, absent leaves it', () => {
  assert.equal(good({ action: 'person.update', personId: A, email: ' Asha@Example.COM ' }).email, 'asha@example.com');
  assert.equal(good({ action: 'person.update', personId: A, email: null }).email, null);
  assert.equal(good({ action: 'person.update', personId: A, email: '' }).email, null);
  assert.ok(!('email' in good({ action: 'person.update', personId: A, fullName: 'A B' })));
  assert.match(bad({ action: 'person.update', personId: A, email: 'not-an-email' }), /email address/);
  assert.match(bad({ action: 'person.update', personId: A, email: 42 }), /Email must be text/);
});

test('phone: normalised to +91 form, invalid rejected rather than dropped, null removes it', () => {
  assert.equal(good({ action: 'person.update', personId: A, phone: '98450 12345' }).phone, '+919845012345');
  assert.equal(good({ action: 'person.update', personId: A, phone: null }).phone, null);
  assert.match(bad({ action: 'person.update', personId: A, phone: '12345' }), /valid mobile number/);
});

test('person.add: needs a household and a name; role defaults to owner', () => {
  const e = good({ action: 'person.add', householdId: A, fullName: 'Ravi Rao', email: 'ravi@example.com' });
  assert.equal(e.role, 'owner');
  assert.equal(e.email, 'ravi@example.com');
  assert.match(bad({ action: 'person.add', householdId: A }), /Name is required/);
  assert.match(bad({ action: 'person.add', householdId: A, fullName: 'R', role: 'admin' }), /Role must be/);
});

test('membership actions validate ids and roles; a move needs a different household', () => {
  assert.equal(good({ action: 'membership.update', householdId: A, personId: B, role: 'family' }).role, 'family');
  assert.match(bad({ action: 'membership.update', householdId: A, personId: B, role: 'boss' }), /Role must be/);
  assert.equal(good({ action: 'membership.move', fromHouseholdId: A, toHouseholdId: B, personId: C }).toHouseholdId, B);
  assert.match(bad({ action: 'membership.move', fromHouseholdId: A, toHouseholdId: A, personId: C }), /different household/);
  assert.deepEqual(good({ action: 'membership.remove', householdId: A, personId: B }), { action: 'membership.remove', householdId: A, personId: B });
});

test('membership.invite takes a household, a person and a true/false', () => {
  assert.deepEqual(good({ action: 'membership.invite', householdId: A, personId: B, canLogin: true }), { action: 'membership.invite', householdId: A, personId: B, canLogin: true });
  assert.equal(good({ action: 'membership.invite', householdId: A, personId: B, canLogin: false }).canLogin, false);
  assert.match(bad({ action: 'membership.invite', householdId: A, personId: B }), /whether this person can sign in/);
  assert.match(bad({ action: 'membership.invite', householdId: A, personId: B, canLogin: 'yes' }), /whether this person can sign in/);
  assert.equal(ACTION_CAPABILITY['membership.invite'], 'manage');
  assert.deepEqual(auditDetail(good({ action: 'membership.invite', householdId: A, personId: B, canLogin: true })).values, { canLogin: true });
});

test('household.update: house like H-07, cluster from the list, null clears', () => {
  assert.equal(good({ action: 'household.update', householdId: A, houseNo: 'h-07' }).houseNo, 'H-07');
  assert.equal(good({ action: 'household.update', householdId: A, houseNo: null }).houseNo, null);
  assert.match(bad({ action: 'household.update', householdId: A, houseNo: 'H7' }), /H-07/);
  assert.equal(good({ action: 'household.update', householdId: A, cluster: 'H2' }).cluster, 'H2');
  assert.match(bad({ action: 'household.update', householdId: A, cluster: 'H3' }), /Cluster must be/);
  assert.equal(good({ action: 'household.update', householdId: A, unitType: ' DF1-V2 ' }).unitType, 'DF1-V2');
  assert.match(bad({ action: 'household.update', householdId: A }), /Nothing to change/);
});

test('plot.create / plot.update: text trimmed, numbers parsed, null clears, bad numbers rejected', () => {
  const e = good({ action: 'plot.create', householdId: A, pattaNo: ' 1971 ', surveyNo: '469/2A', areaAcres: '1.2', areaHectares: 0.405 });
  assert.equal(e.pattaNo, '1971');
  assert.equal(e.areaAcres, 1.2);
  assert.equal(e.areaHectares, 0.405);
  assert.match(bad({ action: 'plot.create', householdId: A }), /at least one detail/);
  assert.match(bad({ action: 'plot.create', householdId: A, areaAcres: -1 }), /zero or more/);
  assert.match(bad({ action: 'plot.create', householdId: A, areaAcres: 'lots' }), /zero or more/);
  assert.match(bad({ action: 'plot.create', householdId: A, areaAcres: 99999 }), /larger than expected/);
  assert.equal(good({ action: 'plot.update', plotId: B, areaAcres: null }).areaAcres, null);
  assert.equal(good({ action: 'plot.update', plotId: B, householdId: C }).householdId, C); // move to another household
});

test('housepatta.create / update use square feet', () => {
  assert.equal(good({ action: 'housepatta.create', householdId: A, areaSqFt: '2,368.06' }).areaSqFt, 2368.06);
  assert.equal(good({ action: 'housepatta.update', housePattaId: B, pattaNo: '2744' }).pattaNo, '2744');
  assert.deepEqual(good({ action: 'housepatta.delete', housePattaId: B }), { action: 'housepatta.delete', housePattaId: B });
});

test('the audit detail names fields but never records a name, email, phone or land number', () => {
  const edit = good({ action: 'person.update', personId: A, fullName: 'Asha Rao', email: 'asha@example.com', phone: '9845012345' });
  const d = auditDetail(edit);
  assert.deepEqual(d.ids, { personId: A });
  assert.deepEqual(d.fields.sort(), ['email', 'fullName', 'phone']);
  assert.ok(!JSON.stringify(d).includes('Asha'));
  assert.ok(!JSON.stringify(d).includes('example.com'));
  assert.ok(!JSON.stringify(d).includes('9845'));

  const plot = auditDetail(good({ action: 'plot.update', plotId: B, pattaNo: '1971', areaAcres: 1.28 }));
  assert.ok(!JSON.stringify(plot).includes('1971'));
  assert.equal(plot.values.areaAcres, 1.28);

  const house = auditDetail(good({ action: 'household.update', householdId: A, houseNo: 'H-22', cluster: 'H1-A' }));
  assert.deepEqual(house.values, { houseNo: 'H-22', cluster: 'H1-A' });
});

const AT = '2026-10-20T10:15:30.123456+00:00';

test('approving a story names the person and the submission seen, and needs `manage`', () => {
  const edit = good({ action: 'story.approve', personId: A, submittedAt: AT });
  assert.deepEqual(edit, { action: 'story.approve', personId: A, submittedAt: AT });
  assert.equal(ACTION_CAPABILITY['story.approve'], 'manage');
  assert.equal(ACTION_CAPABILITY['story.reject'], 'manage');
  assert.match(bad({ action: 'story.approve', personId: A }), /submittedAt/);
  assert.match(bad({ action: 'story.approve', personId: A, submittedAt: 'yesterday' }), /submittedAt/);
  assert.match(bad({ action: 'story.approve', personId: 'x', submittedAt: AT }), /personId/);
});

test('rejecting a story always carries a note for the member', () => {
  assert.match(bad({ action: 'story.reject', personId: A, submittedAt: AT }), /note/i);
  assert.match(bad({ action: 'story.reject', personId: A, submittedAt: AT, note: '   ' }), /note/i);
  assert.match(bad({ action: 'story.reject', personId: A, submittedAt: AT, note: 'x'.repeat(501) }), /too long/);
  const edit = good({ action: 'story.reject', personId: A, submittedAt: AT, note: '  Please use first names only.  ' });
  assert.equal(edit.note, 'Please use first names only.');
});

test('the audit entry for a story decision names the fields, never the note', () => {
  const d = auditDetail(good({ action: 'story.reject', personId: A, submittedAt: AT, note: 'Remove the child’s age.' }));
  assert.deepEqual(d.ids, { personId: A });
  assert.deepEqual(d.fields.sort(), ['note', 'submittedAt']);
  assert.ok(!JSON.stringify(d).includes('child'));
});
