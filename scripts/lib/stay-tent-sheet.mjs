// The rules behind the tent sheet (src/components/stays/TentSheet.astro), the panel a tile on the Day view opens: one
// tent's guests and a few small changes (edit its guests, change the dates, move it to another tent, remove it), in
// place of the whole booking form. Pure and tested. The server (accommodation-admin.mts: validateBookingInput and the
// database's conflict checks) stays the authority; these rules make a person find out in the panel, not after Save.
//
// Every change posts the WHOLE booking to /bookings/update (that is the API), so buildUpdatePayload carries every other
// tent and guest across unchanged. A guest who is already in the directory is sent by personId alone: the browser never
// has their mobile or email (contact details are never sent to it), so nothing is, and what is on file is left alone.
import { checkOutDate } from './stay-notice.mjs';
import { bookableUnits, unitAvailability } from './stay-booking-flow.mjs';

/** Whether this caller may change a booking of this type (the page's roles: admin, restricted to some types, viewer). */
export function canWriteBooking(role, allowedTypes, type) {
  if (role === 'admin') return true;
  if (role === 'restricted') return Boolean(allowedTypes?.includes(type));
  return false;
}

export const tentGuests = (booking, tentId) => booking.tents.find((t) => t.tentId === tentId)?.guests ?? [];
export const otherTentIds = (booking, tentId) => booking.tents.map((t) => t.tentId).filter((id) => id !== tentId);

/** Where the stay stands on a day: arriving, leaving (needs cleaning) or staying (until the check-out). */
export function stayState(booking, date) {
  const out = checkOutDate(booking.startDate, booking.nights);
  if (booking.startDate === date) return { k: 'arriving', until: out };
  if (out === date) return { k: 'leaving', until: out };
  return { k: 'staying', until: out };
}

/**
 * The stay's status in words, as of `date` and judged against the real `today`: "today" only when it really is today, a
 * date for a future day ("Arriving Sat 7 Nov"), and the past tense for a day gone by ("Arrived Sat 3 Oct", "Left Sun 4 Oct").
 * @param {any} booking
 * @param {string} date the day the sheet is looking at
 * @param {string} today the real current day, YYYY-MM-DD
 * @param {(d: string) => string} fmt formats a date for display
 */
export function stayStatus(booking, date, today, fmt) {
  const st = stayState(booking, date);
  const when = date === today ? 'today' : date > today ? 'future' : 'past';
  if (st.k === 'arriving') return when === 'today' ? 'Arriving today' : when === 'future' ? `Arriving ${fmt(booking.startDate)}` : `Arrived ${fmt(booking.startDate)}`;
  if (st.k === 'leaving') return when === 'today' ? 'Leaving today' : when === 'future' ? `Leaving ${fmt(st.until)}` : `Left ${fmt(st.until)}`;
  return st.until < today ? `Stayed until ${fmt(st.until)}` : `Staying until ${fmt(st.until)}`;
}

/**
 * What is wrong with an edited guest list for one tent, or null. A guest already in the directory keeps their name (a
 * rename would change the person on every booking they are on); a new one needs a name and a mobile number.
 * @param {Array<{ personId?: string, name?: string, mobileNumber?: string }>} guests
 * @param {{ label: string, capacity: number }} unit
 * @param {boolean} solo the tent is a family booking: one guest listed
 */
export function guestsProblem(guests, unit, solo) {
  if (guests.length > unit.capacity) return `${unit.label} holds at most ${unit.capacity}.`;
  if (solo && guests.length > 1) return 'A family booking lists one guest. Remove the extra guests first.';
  for (const g of guests) {
    if (!g.name?.trim()) return 'Every guest needs a name.';
    if (!g.personId && !g.mobileNumber?.trim()) return `${g.name.trim()} needs a mobile number.`;
  }
  return null;
}

/** What is wrong with new dates, or null. */
export function datesProblem(startDate, nights) {
  if (!startDate) return 'Choose the check-in day.';
  if (!(nights >= 1)) return 'Check-out must be after check-in.';
  return null;
}

const plainGuest = (g) => ({
  personId: g.personId || undefined,
  name: g.name,
  ageGroup: g.ageGroup || 'Adult',
  gender: g.gender || 'NA',
  preferences: g.preferences?.trim() || undefined,
  mobileNumber: g.mobileNumber?.trim() || undefined,
});

/**
 * The /bookings/update payload for one change to a booking.
 * @param {any} booking
 * @param {{ kind: 'guests', tentId: string, guests: any[] } | { kind: 'dates', startDate: string, nights: number } | { kind: 'move', from: string, to: string } | { kind: 'removeTent', tentId: string }} change
 * @param {{ reason?: string, units?: any[] }} [extra] reason: required by the server when the stay has already happened
 */
export function buildUpdatePayload(booking, change, { reason, units = [] } = {}) {
  const asIs = (t) => ({ tentId: t.tentId, solo: Boolean(t.solo), guests: t.guests.map(plainGuest) });
  let tents = booking.tents.map(asIs);
  let { startDate, nights } = booking;

  if (change.kind === 'guests') tents = tents.map((t) => (t.tentId === change.tentId ? { ...t, guests: change.guests.map(plainGuest) } : t));
  else if (change.kind === 'dates') ({ startDate, nights } = change);
  else if (change.kind === 'move') {
    // A Bring Your Own Tent slot cannot be a family booking.
    const byot = units.find((u) => u.id === change.to)?.kind === 'byot';
    tents = tents.map((t) => (t.tentId === change.from ? { ...t, tentId: change.to, solo: t.solo && !byot } : t));
  } else if (change.kind === 'removeTent') tents = tents.filter((t) => t.tentId !== change.tentId);

  return {
    id: booking.id,
    type: booking.type,
    eventSlug: booking.eventSlug,
    eventTitle: booking.eventTitle,
    label: booking.label,
    exclusive: booking.type === 'private-event' ? Boolean(booking.exclusive) : undefined,
    startDate,
    nights,
    tents,
    note: booking.note,
    reason: reason?.trim() || undefined,
  };
}

/**
 * The units this booking's guests in `tentId` could move to: free on every night of the stay (ignoring this booking
 * itself), able to hold them, not run by a member, and not a tent the booking already has.
 * @param {{ units: any[], bookings: any[], booking: any, tentId: string }} input
 */
export function freeTentsFor({ units, bookings, booking, tentId }) {
  const guests = tentGuests(booking, tentId).length;
  const taken = new Set(booking.tents.map((t) => t.tentId));
  const availability = unitAvailability({ units: bookableUnits(units), bookings: bookings.filter((b) => b.id !== booking.id), startDate: booking.startDate, nights: booking.nights });
  return bookableUnits(units).filter((u) => !availability.get(u.id) && !taken.has(u.id) && u.capacity >= guests);
}
