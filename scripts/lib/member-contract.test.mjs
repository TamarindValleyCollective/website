// Run with: node --test scripts/lib/member-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile, validateShare, validateRecord, enableProblem, contractForMember, contractForAdmin, documentKey, DOCUMENT_KEY, MAX_FILE_BYTES } from './member-contract.mjs';

const pdf = { mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 test').toString('base64') };
const offer = { status: 'interested', shape: 'whole', type_id: '2bhk', delegate_to_tvc: false };

test('a file must be a PDF, JPG or PNG within 4 MB and valid base64', () => {
  assert.equal(checkFile(pdf).ext, 'pdf');
  assert.equal(checkFile({ mime: 'image/png', base64: 'AAAA' }).ext, 'png');
  assert.match(checkFile({ mime: 'text/html', base64: 'AAAA' }).error, /PDF, JPG or PNG/);
  assert.match(checkFile({ mime: 'application/pdf', base64: 'not base64!' }).error, /could not be read/);
  assert.match(checkFile({ mime: 'application/pdf', base64: 'A'.repeat(Math.ceil(((MAX_FILE_BYTES + 10) * 4) / 3)) }).error, /4 MB/);
  assert.match(checkFile(null).error, /Choose a file/);
});

test('sharing: the split is all three shares adding to 100, or none yet', () => {
  const ok = validateShare({ termsVersion: '2026-1', memberPct: 50, tvcPct: 20, lingerPct: 30, file: pdf }, offer);
  assert.deepEqual([ok.row.member_pct, ok.row.tvc_pct, ok.row.linger_pct], [50, 20, 30]);
  assert.equal(validateShare({ termsVersion: '2026-1', file: pdf }, offer).row.member_pct, null);
  assert.match(validateShare({ termsVersion: '2026-1', memberPct: 50, file: pdf }, offer).error, /all three shares/);
  assert.match(validateShare({ termsVersion: '2026-1', memberPct: 50, tvcPct: 20, lingerPct: 20, file: pdf }, offer).error, /add up to 100/);
  assert.match(validateShare({ termsVersion: '2026-1', memberPct: 150, tvcPct: 0, lingerPct: 0, file: pdf }, offer).error, /0 to 100/);
});

test('sharing copies the offer: the manager is TVC only for a delegated whole unit, and a closed offer is refused', () => {
  assert.equal(validateShare({ termsVersion: 'v1', file: pdf }, offer).row.manager, 'member');
  assert.equal(validateShare({ termsVersion: 'v1', file: pdf }, { ...offer, delegate_to_tvc: true }).row.manager, 'tvc');
  assert.equal(validateShare({ termsVersion: 'v1', file: pdf }, { ...offer, shape: 'room', type_id: '1br', delegate_to_tvc: true }).row.manager, 'member');
  assert.match(validateShare({ termsVersion: 'v1', file: pdf }, { ...offer, status: 'enabled' }).error, /already been dealt with/);
  assert.match(validateShare({ termsVersion: '', file: pdf }, offer).error, /version of the terms/);
  assert.match(validateShare({ termsVersion: 'v1', memberPayout: 'cash', file: pdf }, offer).error, /maintenance/);
  assert.equal(validateShare({ termsVersion: 'v1', memberPayout: 'maintenance_adjustment', file: pdf }, offer).row.member_payout, 'maintenance_adjustment');
});

test('recording: dates, notice and references; blank clears; nothing to change is an error', () => {
  assert.deepEqual(validateRecord({ signedOn: '2026-11-01', effectiveFrom: '2026-11-15', noticeDays: '30', lingerPropertyRef: 'P-102' }).patch, { signed_on: '2026-11-01', effective_from: '2026-11-15', notice_days: 30, linger_property_ref: 'P-102' });
  assert.deepEqual(validateRecord({ endsOn: '' }).patch, { ends_on: null });
  assert.match(validateRecord({ signedOn: '2026-02-30' }).error, /Dates are written/);
  assert.match(validateRecord({ effectiveFrom: '2026-12-01', endsOn: '2026-11-01' }).error, /cannot end before/);
  assert.match(validateRecord({ lingerRoomRef: '<script>' }).error, /letters, numbers/);
  assert.match(validateRecord({ noticeDays: 400 }).error, /0 to 365/);
  assert.match(validateRecord({}).error, /Nothing to change/);
});

test('a unit is enabled only on a signed contract with an effective date', () => {
  assert.match(enableProblem(null), /Share the contract/);
  assert.match(enableProblem({ status: 'shared', signed_doc: null }), /not uploaded the signed/);
  assert.match(enableProblem({ status: 'signed', signed_doc: 'k', effective_from: null }), /takes effect/);
  assert.equal(enableProblem({ status: 'signed', signed_doc: 'k', effective_from: '2026-11-01' }), null);
  assert.match(enableProblem({ status: 'active', signed_doc: 'k', effective_from: '2026-11-01' }), /not waiting/);
});

test('the member sees the stage, never the split or Linger references', () => {
  const c = { status: 'shared', terms_version: 'v1', shared_at: 'x', signed_doc: null, member_pct: 50, tvc_pct: 20, linger_pct: 30, linger_property_ref: 'P-1' };
  const seen = contractForMember(c);
  assert.deepEqual([seen.stage, seen.canUpload, seen.hasSigned], ['sign', true, false]);
  assert.ok(!JSON.stringify(seen).includes('P-1') && !('split' in seen));
  assert.equal(contractForMember({ ...c, status: 'active' }).canUpload, false);
  assert.equal(contractForMember(null), null);
  assert.equal(contractForAdmin(c).split.linger, 30);
});

test('object keys are fixed in shape', () => {
  const k = documentKey('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'signed', 'pdf');
  assert.ok(DOCUMENT_KEY.test(k));
  assert.ok(!DOCUMENT_KEY.test('../x/y-signed.pdf'));
});
