// Pure logic for accommodation stay notifications (no I/O), shared by
// netlify/functions/lib/stay-notify.ts and unit-tested in stay-notice.test.mjs.
//
// Only these booking types ever notify guests. Member stays first (Sharath,
// 2026-10-12); widen this list to roll the feature out to other types.
export const NOTIFIABLE_BOOKING_TYPES = ['member-stay'];

export function isNotifiableType(type) {
  return NOTIFIABLE_BOOKING_TYPES.includes(type);
}

// What guests are told, as comparable data: the stay dates plus who is in which
// tent. A guest in two tents appears twice.
export function snapshotOf(booking) {
  return {
    startDate: booking.startDate,
    nights: booking.nights,
    assignments: booking.tents.flatMap((t) =>
      t.guests.filter((g) => g.personId).map((g) => ({ personId: g.personId, tentId: t.tentId })),
    ),
  };
}

function tentsByPerson(snapshot) {
  const map = new Map();
  for (const a of snapshot.assignments) map.set(a.personId, [...(map.get(a.personId) ?? []), a.tentId].sort());
  return map;
}

// What needs saying, given the last-notified snapshot (null = never finalized)
// and the current one: per person, 'confirmed' (new to the booking, or the
// first notice), 'updated' (tent or dates changed) or 'cancelled' (removed).
// People whose stay is unchanged are omitted.
export function diffNotices(previous, current) {
  const now = tentsByPerson(current);
  if (!previous) return [...now.keys()].map((personId) => ({ personId, kind: 'confirmed' }));
  const before = tentsByPerson(previous);
  const datesChanged = previous.startDate !== current.startDate || previous.nights !== current.nights;
  const out = [];
  for (const [personId, tents] of now) {
    if (!before.has(personId)) out.push({ personId, kind: 'confirmed' });
    else if (datesChanged || before.get(personId).join() !== tents.join()) out.push({ personId, kind: 'updated' });
  }
  for (const personId of before.keys()) if (!now.has(personId)) out.push({ personId, kind: 'cancelled' });
  return out;
}

// True when a finalized booking has drifted from what guests were last told.
export function hasPendingChanges(previous, current) {
  return previous != null && diffNotices(previous, current).length > 0;
}

// Check-out date (YYYY-MM-DD) for a stay of `nights` starting `startDate`.
export function checkOutDate(startDate, nights) {
  const [y, m, d] = startDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + nights)).toISOString().slice(0, 10);
}
