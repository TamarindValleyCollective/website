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

test('publishing the site takes no fields, needs `manage`, and the audit entry has nothing in it', () => {
  assert.deepEqual(good({ action: 'site.publish' }), { action: 'site.publish' });
  assert.equal(ACTION_CAPABILITY['site.publish'], 'manage');
  assert.deepEqual(auditDetail(good({ action: 'site.publish' })), { ids: {}, fields: [] });
});

test('the automatic-publishing switch takes a mode and/or a pause, and both are logged', () => {
  assert.deepEqual(good({ action: 'site.autopublish', mode: 'live' }), { action: 'site.autopublish', mode: 'live' });
  assert.deepEqual(good({ action: 'site.autopublish', paused: true }), { action: 'site.autopublish', paused: true });
  assert.equal(ACTION_CAPABILITY['site.autopublish'], 'manage');
  assert.deepEqual(auditDetail(good({ action: 'site.autopublish', mode: 'shadow', paused: false })), { ids: {}, fields: ['mode', 'paused'], values: { mode: 'shadow', paused: false } });
  for (const bad of [{ action: 'site.autopublish' }, { action: 'site.autopublish', mode: 'auto' }, { action: 'site.autopublish', paused: 'yes' }]) assert.equal(validateEdit(bad).ok, false);
});

test('deciding a UNIT story names the unit and the submission seen, needs `manage`, and sending it back needs a note', () => {
  assert.deepEqual(good({ action: 'unitstory.approve', householdId: A, submittedAt: AT }), { action: 'unitstory.approve', householdId: A, submittedAt: AT });
  assert.equal(ACTION_CAPABILITY['unitstory.approve'], 'manage');
  assert.equal(ACTION_CAPABILITY['unitstory.reject'], 'manage');
  assert.equal(ACTION_CAPABILITY['unitstory.unpublish'], 'manage');
  assert.match(bad({ action: 'unitstory.approve', householdId: A }), /submittedAt/);
  assert.match(bad({ action: 'unitstory.approve', householdId: 'x', submittedAt: AT }), /householdId/);
  assert.match(bad({ action: 'unitstory.reject', householdId: A, submittedAt: AT }), /note/i);
  assert.match(bad({ action: 'unitstory.reject', householdId: A, submittedAt: AT, note: 'x'.repeat(501) }), /too long/);
  assert.equal(good({ action: 'unitstory.reject', householdId: A, submittedAt: AT, note: '  Remove the phone number.  ' }).note, 'Remove the phone number.');
  assert.deepEqual(good({ action: 'unitstory.unpublish', householdId: A }), { action: 'unitstory.unpublish', householdId: A });
  assert.equal(validateEdit({ action: 'unitstory.unpublish' }).ok, false);
  // the audit entry names the unit and the fields, never the note
  const d = auditDetail(good({ action: 'unitstory.reject', householdId: A, submittedAt: AT, note: 'Remove the child’s age.' }));
  assert.deepEqual(d.ids, { householdId: A });
  assert.ok(!JSON.stringify(d).includes('child'));
});

test('deciding a family member request names the request and needs `manage`', () => {
  assert.deepEqual(good({ action: 'familyrequest.approve', requestId: A }), { action: 'familyrequest.approve', requestId: A });
  assert.deepEqual(good({ action: 'familyrequest.reject', requestId: A }), { action: 'familyrequest.reject', requestId: A });
  assert.equal(ACTION_CAPABILITY['familyrequest.approve'], 'manage');
  assert.equal(ACTION_CAPABILITY['familyrequest.reject'], 'manage');
  assert.match(bad({ action: 'familyrequest.approve', requestId: 'x' }), /requestId/);
  assert.equal(validateEdit({ action: 'familyrequest.approve' }).ok, false);
});

test('dismissing a notice names it and needs only `edit`', () => {
  assert.deepEqual(good({ action: 'notice.dismiss', noticeId: A }), { action: 'notice.dismiss', noticeId: A });
  assert.equal(ACTION_CAPABILITY['notice.dismiss'], 'edit');
  assert.match(bad({ action: 'notice.dismiss', noticeId: 'x' }), /noticeId/);
});
