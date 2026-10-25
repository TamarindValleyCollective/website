// A member's payout account (table member_payout_accounts, migration 0070): what they may enter in the portal, what an
// admin may record when verifying, and what each side is shown. Pure, so it is tested directly (member-payout.test.mjs);
// members-rental.mts and units-admin.mts do the encrypting, reading and writing. Full values never leave the server
// except to a super admin who reveals them behind the step-up; everyone else sees only "ending 4821".
// Plan: docs/plans/accommodation-member-units.md.

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/i;
const ACCOUNT = /^[0-9]{9,18}$/;
const NAME = /^[\p{L}][\p{L} .'-]{1,79}$/u;

const squash = (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '') : '');
const last4 = (v) => v.slice(-4);

// What a member enters. Returns what is to be stored (plain; the caller encrypts `details` and `pan`) or an error.
export function validatePayout(body) {
  const payeeName = typeof body?.payeeName === 'string' ? body.payeeName.trim().replace(/\s+/g, ' ') : '';
  if (!NAME.test(payeeName)) return { error: 'Enter the name as it appears on the account.' };
  const pan = squash(body?.pan).toUpperCase();
  if (!PAN.test(pan)) return { error: 'The PAN should look like ABCDE1234F.' };
  let details;
  let tail;
  if (body?.method === 'bank') {
    const account = squash(body.account);
    const ifsc = squash(body.ifsc).toUpperCase();
    if (!ACCOUNT.test(account)) return { error: 'The account number should be 9 to 18 digits.' };
    if (!IFSC.test(ifsc)) return { error: 'The IFSC code should look like HDFC0001234.' };
    details = { account, ifsc };
    tail = last4(account);
  } else if (body?.method === 'upi') {
    const upi = typeof body.upi === 'string' ? body.upi.trim().toLowerCase() : '';
    if (!UPI.test(upi)) return { error: 'The UPI id should look like name@bank.' };
    details = { upi };
    tail = last4(upi.split('@')[0].padStart(4, '*'));
  } else return { error: 'Choose bank transfer or UPI.' };
  return { payout: { payeeName, method: body.method, details, detailsLast4: tail, pan, panLast4: last4(pan) } };
}

// What a super admin records when verifying (after a small test transfer): whether TDS is deducted, and at what rate.
export function validateVerification(body) {
  if (typeof body?.tdsApplies !== 'boolean') return { error: 'Say whether TDS is deducted.' };
  if (!body.tdsApplies) return { verification: { tds_applies: false, tds_rate: null } };
  const rate = Number(body.tdsRate);
  if (body.tdsRate === '' || body.tdsRate === null || body.tdsRate === undefined || !Number.isFinite(rate) || rate <= 0 || rate > 100) return { error: 'Enter the TDS rate as a percentage above 0.' };
  return { verification: { tds_applies: true, tds_rate: Math.round(rate * 100) / 100 } };
}

const dots = (tail) => `ending ${tail}`;

// What the member's portal shows of their own account: never a full value.
export function payoutForMember(row) {
  if (!row) return null;
  return { payeeName: row.payee_name, method: row.method, shown: dots(row.details_last4), panShown: dots(row.pan_last4), status: row.status, updatedAt: row.updated_at };
}

// What the admin list shows: the same, plus who verified and the TDS decision. Still never a full value.
export function payoutForAdmin(row) {
  if (!row) return null;
  return { ...payoutForMember(row), householdId: row.household_id, tdsApplies: row.tds_applies, tdsRate: row.tds_rate === null || row.tds_rate === undefined ? null : Number(row.tds_rate), verifiedAt: row.verified_at };
}

// Whether the member is asked for payout details: only when their contract pays them (not against maintenance).
export function needsPayout(contract) {
  return Boolean(contract) && contract.member_payout === 'bank_transfer' && ['shared', 'signed', 'active'].includes(contract.status);
}

// A payout is made only to a verified account that has not changed since.
export function payableProblem(row) {
  if (!row) return 'The member has not entered payout details.';
  if (row.status !== 'verified') return 'The payout account is not verified yet.';
  if (row.tds_applies === null || row.tds_applies === undefined) return 'Record whether TDS is deducted.';
  return null;
}
