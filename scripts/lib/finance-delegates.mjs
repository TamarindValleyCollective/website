// Delegates of the UPI circle (docs/finance/FINANCE.md, "Delegates"): who a delegated payment belongs to. Pure and I/O-free
// (finance-delegates.test.mjs).
//
// No UPI file says which delegate paid: the export is in the operator's name. So a payment is attributed in this order:
//   0. only the delegates of the operator whose UPI the payment went through are candidates (a delegate belongs to one operator's circle; a
//      payment or a delegate with no operator recorded, from before operators, is not held back by it);
//   1. an explicit pick (an admin chose the delegate for that payment: fin_upi_delegate_links, keyed by the UPI reference);
//   2. the one delegate who was active on the day (their start and end dates), automatically;
//   3. otherwise it is left open: 'ambiguous' when two or more were active, 'none' when nobody was.
// Nothing is ever written onto the UPI row itself (fin_upi_lines is link-only), so changing a delegate's dates changes the
// attribution of every payment that was not picked by hand.

// A delegate is identified by the number the UPI app shows ("Paid for <number>"). It is personal data: it lives in the
// database only, never in this repository.
export const DELEGATE_NUMBER = /^[0-9]{7,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CAP_PAISE = 10_000_000;

const isRealDay = (s) => typeof s === 'string' && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** What to show for a delegate: their name when they have one, otherwise the number. */
export const delegateLabel = (delegate) => delegate.displayName || delegate.identifier;

/** The delegates active on a day (both ends inclusive; no end date means still active). */
export const activeOn = (delegates, day) => delegates.filter((d) => d.activeFrom <= day && (d.activeTo === null || d.activeTo >= day));

/**
 * Who a UPI row belongs to. `line`: { isCircle, paidAt, upiRef, operatorId? }; `links`: Map of UPI reference -> delegate id; delegates may carry an
 * operatorId, and then only the delegates of the line's operator are candidates.
 * Returns { delegateId, how }: how is 'assigned' | 'auto' | 'ambiguous' | 'none', or null for a payment that is not delegated.
 */
export function attribute(line, delegates, links) {
  if (!line.isCircle) return { delegateId: null, how: null };
  const picked = links.get(line.upiRef);
  if (picked && delegates.some((d) => d.id === picked)) return { delegateId: picked, how: 'assigned' };
  const mine = delegates.filter((d) => !line.operatorId || !d.operatorId || d.operatorId === line.operatorId);
  const active = activeOn(mine, line.paidAt);
  if (active.length === 1) return { delegateId: active[0].id, how: 'auto' };
  return { delegateId: null, how: active.length > 1 ? 'ambiguous' : 'none' };
}

/**
 * Checks a delegate before it is saved. On create the number is required; on update it cannot change (it is how the
 * delegate is known), so it is ignored. Returns { value } in the shape the table wants, or { error } in plain words.
 */
export function validateDelegate(body, { create }) {
  const value = {};
  if (create) {
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    if (!DELEGATE_NUMBER.test(identifier)) return { error: 'Enter the delegate’s number, digits only, as the UPI app shows it.' };
    value.identifier = identifier;
  }
  // Whose circle the delegate is in (an operator's id); the endpoint checks it exists and fills it in when there is only one operator.
  if (body.operatorId !== undefined && body.operatorId !== null && body.operatorId !== '') {
    if (typeof body.operatorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operatorId)) return { error: 'Choose the operator whose circle this is.' };
    value.operatorId = body.operatorId;
  }
  const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (name && (name.length < 2 || name.length > 60)) return { error: 'A name is 2 to 60 characters, or leave it empty to show the number.' };
  value.displayName = name || null;
  if (!isRealDay(body.activeFrom)) return { error: 'Choose the date they started as a delegate.' };
  value.activeFrom = body.activeFrom;
  const to = typeof body.activeTo === 'string' ? body.activeTo.trim() : '';
  if (to) {
    if (!isRealDay(to)) return { error: 'The end date is not a valid date.' };
    if (to < body.activeFrom) return { error: 'The end date is before the start date.' };
  }
  value.activeTo = to || null;
  if (body.capPaise === '' || body.capPaise === null || body.capPaise === undefined) value.capPaise = null;
  else {
    const cap = Number(body.capPaise);
    if (!Number.isInteger(cap) || cap <= 0 || cap > MAX_CAP_PAISE) return { error: 'The monthly limit must be a whole amount above zero, or empty for the default.' };
    value.capPaise = cap;
  }
  return { value };
}
