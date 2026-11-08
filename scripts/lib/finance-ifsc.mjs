// IFSC lookup for payee entry (docs/finance/FINANCE.md, "IFSC lookup"). Pure apart from the injected `fetchImpl`, so it is
// tested directly (finance-ifsc.test.mjs); finance-admin.mts supplies the real fetch.
//
// Razorpay publishes a free, open IFSC directory (https://ifsc.razorpay.com/<IFSC>, no key). It proves the code names a
// real branch and says which bank; it says nothing about the account number or who owns it. Only the IFSC leaves the
// server, never the account number. A lookup failure never blocks saving: the directory being down is not a reason
// to refuse a payee.
export const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const DIRECTORY = 'https://ifsc.razorpay.com/';

const title = (v) =>
  typeof v === 'string'
    ? v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim()
    : '';

// What the page shows: the bank and branch, never the whole directory record.
export function branchForResponse(record) {
  const bank = typeof record?.BANK === 'string' ? record.BANK.trim() : '';
  if (!bank) return null;
  return { bank, branch: title(record.BRANCH), city: title(record.CITY || record.DISTRICT), state: title(record.STATE) };
}

// -> { found: true, ...branch } | { found: false } (the code names no branch) | { unavailable: true } (could not ask)
export async function lookupIfsc(code, fetchImpl = fetch) {
  const ifsc = typeof code === 'string' ? code.replace(/\s+/g, '').toUpperCase() : '';
  if (!IFSC_SHAPE.test(ifsc)) return { found: false };
  try {
    const res = await fetchImpl(`${DIRECTORY}${ifsc}`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 404) return { found: false };
    if (!res.ok) return { unavailable: true };
    const branch = branchForResponse(await res.json());
    return branch ? { found: true, ...branch } : { found: false };
  } catch {
    return { unavailable: true };
  }
}
