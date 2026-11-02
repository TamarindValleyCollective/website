// Pure rules for the finance module's access (docs/finance/DESIGN.md, Access). Kept free of I/O so they can be tested
// and reused by every later finance session; the Netlify Functions call these.

// A grant with an end date (an auditor's) stops working at that instant. A value that cannot be read counts as
// expired: access that cannot be proven current is refused.
export function grantIsExpired(expiresAt, now = new Date()) {
  if (expiresAt === null || expiresAt === undefined) return false;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return true;
  return t <= now.getTime();
}

const MAX_DAYS_AHEAD = 400;
const IST_OFFSET_MS = 5.5 * 3_600_000;

// What the Access screen sends: "YYYY-MM-DD" (the last day the person may sign in) or null (no end). The grant runs
// to the close of that day in India time. Rejects dates that are not real, are in the past, or are over ~13 months out.
export function parseExpiry(input, now = new Date()) {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return { ok: false, error: 'Enter the last day as a date.' };
  const [y, m, d] = input.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return { ok: false, error: 'That is not a real date.' };
  const end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59) - IST_OFFSET_MS);
  if (end.getTime() <= now.getTime()) return { ok: false, error: 'The last day must be today or later.' };
  if (end.getTime() - now.getTime() > MAX_DAYS_AHEAD * 86_400_000) return { ok: false, error: 'Access can be given for at most 13 months at a time.' };
  return { ok: true, value: end.toISOString() };
}

// Whoever prepares a thing cannot also confirm or approve it. Every person must be known and all must differ.
export function makerIsNotChecker(...personIds) {
  if (personIds.length < 2) return false;
  if (personIds.some((id) => typeof id !== 'string' || id === '')) return false;
  return new Set(personIds).size === personIds.length;
}

// Finance field classes (DESIGN.md, Access / Masking): names are shown to anyone who can view, because an auditor
// needs payee names; payee account numbers and UPI IDs only to those who verify payees or export payment files.
export function payeeFieldVisibility(capabilities) {
  const has = (c) => capabilities.includes(c);
  return { names: has('view'), payeeBankDetails: has('verify-payee') || has('export') };
}

// "1234567890123" -> "•••• 0123". Last four only.
export function maskAccountNumber(account) {
  const digits = String(account).replace(/\s/g, '');
  return digits.length < 8 ? '••••' : `•••• ${digits.slice(-4)}`;
}

// "priya@okbank" -> "p••••@okbank".
export function maskUpiId(vpa) {
  const at = String(vpa).indexOf('@');
  if (at <= 0) return '••••';
  return `${vpa[0]}••••${vpa.slice(at)}`;
}
