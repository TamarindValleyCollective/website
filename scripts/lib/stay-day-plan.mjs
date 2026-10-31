// Builds the "plan for the day" summary of the farm's stays from the bookings the admin calendar already holds:
// who arrives, who leaves, how many eat, and what food needs and notes to know. Pure (no database, no clock), so
// the daily WhatsApp message (netlify/functions/whatsapp-stays-daily-plan.mts) and its tests share one definition.
//
// A stay occupies the nights [startDate, checkOut); the check-out day itself is not a night. So on date D:
//   arriving   startDate === D
//   leaving    checkOut  === D
//   breakfast  slept here last night and is still here this morning (startDate < D <= checkOut)
//   dinner     sleeps here tonight (startDate <= D < checkOut)
import { checkOutDate } from './stay-notice.mjs';

// Closures hold a tent empty; nobody is arriving, eating or sleeping there.
const GUEST_TYPES = new Set(['casual-stay', 'public-event', 'private-event', 'member-stay']);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function whoOf(booking) {
  const lead = booking.tents.flatMap((t) => t.guests)[0]?.name;
  return booking.label || booking.eventTitle || lead || 'A booking';
}

function guestCount(booking) {
  return booking.tents.reduce((sum, t) => sum + t.guests.length, 0);
}

/** @param {string} date YYYY-MM-DD (the farm's local day) @param {Map<string,string>} labels unit id -> display name */
export function buildDayPlan(bookings, date, labels = new Map()) {
  const rows = bookings
    .filter((b) => GUEST_TYPES.has(b.type))
    .map((b) => ({ booking: b, checkOut: checkOutDate(b.startDate, b.nights) }));
  const describe = ({ booking }) => ({
    id: booking.id,
    who: whoOf(booking),
    guests: guestCount(booking),
    tents: [...new Set(booking.tents.map((t) => labels.get(t.tentId) ?? t.tentId))],
  });

  const arriving = rows.filter((r) => r.booking.startDate === date).map(describe);
  const leaving = rows.filter((r) => r.checkOut === date).map(describe);
  const breakfast = rows.filter((r) => r.booking.startDate < date && date <= r.checkOut).reduce((n, r) => n + guestCount(r.booking), 0);
  const dinner = rows.filter((r) => r.booking.startDate <= date && date < r.checkOut).reduce((n, r) => n + guestCount(r.booking), 0);

  // Everyone who is on the farm at some point today needs their food needs and notes known.
  const here = rows.filter((r) => r.booking.startDate <= date && date <= r.checkOut);
  const food = here.flatMap((r) =>
    r.booking.tents.flatMap((t) => t.guests.filter((g) => g.preferences?.trim()).map((g) => ({ who: g.name, need: g.preferences.trim() }))),
  );
  const notes = here.filter((r) => r.booking.note?.trim()).map((r) => ({ who: whoOf(r.booking), note: r.booking.note.trim() }));

  return { date, arriving, leaving, breakfast, dinner, food, notes, quiet: here.length === 0 };
}

const line = (items, one) =>
  items.length ? items.map((s) => `${s.who} (${[s.guests ? plural(s.guests, 'guest') : null, s.tents.join(' and ') || null].filter(Boolean).join(', ') || one})`).join('; ') : 'Nobody';

/** The five one-line values the tvc_stays_daily_plan template fills in (Meta forbids newlines inside a variable). */
export function planToTemplateParams(plan, dateLabel) {
  const food = [...plan.food.map((f) => `${f.who}: ${f.need}`), ...plan.notes.map((n) => `${n.who}: ${n.note}`)];
  return [
    dateLabel,
    line(plan.arriving, 'arriving'),
    line(plan.leaving, 'leaving'),
    `Breakfast ${plan.breakfast}, dinner ${plan.dinner}`,
    food.length ? food.join('; ') : 'None',
  ];
}
