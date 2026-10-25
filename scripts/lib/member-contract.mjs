// The three-way contract (Linger, TVC, the member) behind a unit offer: what an admin may share, what a member may
// upload, what the admin may record before enabling, and what the portal and the admin screen are shown. Pure, so it is
// tested directly (member-contract.test.mjs); netlify/functions/units-admin.mts and members-rental.mts do the reading
// and writing. Table: member_unit_contracts (migration 0069). Plan: docs/plans/accommodation-member-units.md.

export const MAX_FILE_BYTES = 4 * 1024 * 1024; // a Netlify function takes 6 MB, and a file sent as base64 grows by a third
export const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const PAYOUTS = ['bank_transfer', 'maintenance_adjustment'];
export const CYCLES = ['monthly', 'per_stay'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,59}$/;

const isRealDate = (d) => typeof d === 'string' && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const blank = (v) => v === undefined || v === null || v === '';

// A file arrives as { mime, base64 }. Returns the bytes' type and size, or an error to show.
export function checkFile(file) {
  if (!file || typeof file.base64 !== 'string' || !file.base64) return { error: 'Choose a file.' };
  const ext = FILE_TYPES[file.mime];
  if (!ext) return { error: 'The file must be a PDF, JPG or PNG.' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) return { error: 'The file could not be read.' };
  const bytes = Math.floor((file.base64.length * 3) / 4) - (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0);
  if (bytes > MAX_FILE_BYTES) return { error: 'The file is larger than 4 MB.' };
  return { ext, mime: file.mime, bytes };
}

const pct = (v) => {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : NaN;
};

// What an admin sends to share the contract: which version of the terms, the split (all three or none), the member's
// payout, and the electronic copy. `offer` is the member's offer, whose type and shape the contract copies.
export function validateShare(body, offer) {
  if (!offer || offer.status !== 'interested') return { error: 'This offer has already been dealt with.' };
  const termsVersion = typeof body?.termsVersion === 'string' ? body.termsVersion.trim() : '';
  if (!REF.test(termsVersion)) return { error: 'Enter the version of the terms, for example 2026-1.' };
  const split = { member_pct: pct(body?.memberPct), tvc_pct: pct(body?.tvcPct), linger_pct: pct(body?.lingerPct) };
  const given = Object.values(split).filter((v) => v !== null);
  if (given.some(Number.isNaN)) return { error: 'Each share is a percentage from 0 to 100.' };
  if (given.length && given.length !== 3) return { error: 'Give all three shares (member, TVC, Linger), or none yet.' };
  if (given.length && Math.round(given.reduce((a, b) => a + b, 0) * 100) !== 10000) return { error: 'The three shares must add up to 100.' };
  const payout = body?.memberPayout ?? 'bank_transfer';
  if (!PAYOUTS.includes(payout)) return { error: 'Choose bank transfer or an adjustment against maintenance.' };
  const cycle = body?.settlementCycle ?? 'monthly';
  if (!CYCLES.includes(cycle)) return { error: 'Choose monthly or per stay.' };
  const file = checkFile(body?.file);
  if (file.error) return { error: file.error };
  const delegated = offer.delegate_to_tvc === true && offer.shape === 'whole';
  return {
    file,
    row: { terms_version: termsVersion, type_id: offer.type_id, shape: offer.shape, manager: delegated ? 'tvc' : 'member', member_payout: payout, settlement_cycle: cycle, ...split },
  };
}

// What the admin records before enabling: dates, notice and Linger's references. Every field optional; a field left
// blank is left as it is. Returns a database patch.
export function validateRecord(body) {
  const patch = {};
  for (const [key, col] of [['signedOn', 'signed_on'], ['effectiveFrom', 'effective_from'], ['endsOn', 'ends_on']]) {
    if (body?.[key] === undefined) continue;
    if (blank(body[key])) patch[col] = null;
    else if (!isRealDate(body[key])) return { error: 'Dates are written like 2026-11-01.' };
    else patch[col] = body[key];
  }
  for (const [key, col] of [['lingerContractRef', 'linger_contract_ref'], ['lingerPropertyRef', 'linger_property_ref'], ['lingerRoomRef', 'linger_room_ref']]) {
    if (body?.[key] === undefined) continue;
    const v = typeof body[key] === 'string' ? body[key].trim() : '';
    if (!v) patch[col] = null;
    else if (!REF.test(v)) return { error: "Linger's references are letters, numbers and - . _ / only." };
    else patch[col] = v;
  }
  if (body?.noticeDays !== undefined) {
    if (blank(body.noticeDays)) patch.notice_days = null;
    else if (!Number.isInteger(Number(body.noticeDays)) || Number(body.noticeDays) < 0 || Number(body.noticeDays) > 365) return { error: 'Notice is a number of days from 0 to 365.' };
    else patch.notice_days = Number(body.noticeDays);
  }
  if (patch.effective_from && patch.ends_on && patch.ends_on < patch.effective_from) return { error: 'The contract cannot end before it starts.' };
  if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
  return { patch };
}

// A unit may be enabled only on a contract whose signed copy is in, with its dates and Linger's property reference.
export function enableProblem(contract) {
  if (!contract) return 'Share the contract with the member first.';
  if (contract.status === 'shared' || !contract.signed_doc) return 'The member has not uploaded the signed contract yet.';
  if (contract.status !== 'signed') return 'This contract is not waiting to be enabled.';
  if (!contract.effective_from) return 'Enter the date the contract takes effect.';
  return null;
}

// What the member's portal shows: the stage, and whether each document can be opened or uploaded. Never the split or
// Linger's references.
export function contractForMember(contract) {
  if (!contract) return null;
  return {
    stage: contract.status === 'shared' ? 'sign' : contract.status === 'signed' ? 'review' : contract.status,
    termsVersion: contract.terms_version,
    sharedAt: contract.shared_at,
    canUpload: contract.status === 'shared' || contract.status === 'signed',
    hasSigned: Boolean(contract.signed_doc),
  };
}

// What the admin screen shows for an offer's contract.
export function contractForAdmin(contract) {
  if (!contract) return null;
  return {
    id: contract.id,
    status: contract.status,
    termsVersion: contract.terms_version,
    typeId: contract.type_id,
    manager: contract.manager,
    split: contract.member_pct === null ? null : { member: Number(contract.member_pct), tvc: Number(contract.tvc_pct), linger: Number(contract.linger_pct) },
    memberPayout: contract.member_payout,
    settlementCycle: contract.settlement_cycle,
    hasSigned: Boolean(contract.signed_doc),
    signedUploadedAt: contract.signed_uploaded_at,
    signedOn: contract.signed_on,
    effectiveFrom: contract.effective_from,
    endsOn: contract.ends_on,
    noticeDays: contract.notice_days,
    lingerContractRef: contract.linger_contract_ref,
    lingerPropertyRef: contract.linger_property_ref,
    lingerRoomRef: contract.linger_room_ref,
    sharedAt: contract.shared_at,
    problem: enableProblem(contract),
  };
}

// The object key of a contract document: <household uuid>/<contract uuid>-<kind>.<ext>.
export const documentKey = (householdId, contractId, kind, ext) => `${householdId}/${contractId}-${kind}.${ext}`;
export const DOCUMENT_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}-(contract|signed)\.(pdf|jpg|png)$/;
