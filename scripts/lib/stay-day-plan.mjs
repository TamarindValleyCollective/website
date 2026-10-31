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

/** One or two tents by name; a booking over more (a whole-farm event) is just a count. */
export function tentsLabel(tents) {
  return tents.length <= 2 ? tents.join(' and ') : plural(tents.length, 'tent');
}

function whoOf(booking) {
  const lead = booking.tents.flatMap((t) => t.guests)[0]?.name;
  return booking.label || booking.eventTitle || lead || 'A booking';
}

function guestCount(booking) {
  return booking.tents.reduce((sum, t) => sum + t.guests.length, 0);
}

/** @typedef {{ id: string, who: string, guests: number, tents: string[], note: string }} PlanEntry */
/** @typedef {PlanEntry & { until: string }} StayingEntry */
/** @typedef {{ date: string, arriving: PlanEntry[], leaving: PlanEntry[], staying: StayingEntry[], breakfast: number, dinner: number, food: { who: string, need: string }[], notes: { who: string, note: string }[], quiet: boolean }} DayPlan */

/**
 * @param {any[]} bookings the admin API's bookings (type, startDate, nights, tents with guests, label, note)
 * @param {string} date YYYY-MM-DD (the farm's local day)
 * @param {Map<string, string>} labels unit id -> display name
 * @returns {DayPlan}
 */
export function buildDayPlan(bookings, date, labels = new Map()) {
  const rows = bookings
    .filter((b) => GUEST_TYPES.has(b.type))
    .map((b) => ({ booking: b, checkOut: checkOutDate(b.startDate, b.nights) }));
  const describe = ({ booking }) => ({
    id: booking.id,
    who: whoOf(booking),
    guests: guestCount(booking),
    tents: [...new Set(booking.tents.map((t) => labels.get(t.tentId) ?? t.tentId))],
    note: booking.note?.trim() ?? '',
  });

  const arriving = rows.filter((r) => r.booking.startDate === date).map(describe);
  const leaving = rows.filter((r) => r.checkOut === date).map(describe);
  // On the farm before today and still here tonight: neither arriving nor leaving, but part of today.
  const staying = rows.filter((r) => r.booking.startDate < date && date < r.checkOut).map((r) => ({ ...describe(r), until: r.checkOut }));
  const breakfast = rows.filter((r) => r.booking.startDate < date && date <= r.checkOut).reduce((n, r) => n + guestCount(r.booking), 0);
  const dinner = rows.filter((r) => r.booking.startDate <= date && date < r.checkOut).reduce((n, r) => n + guestCount(r.booking), 0);

  // Everyone who is on the farm at some point today needs their food needs and notes known.
  const here = rows.filter((r) => r.booking.startDate <= date && date <= r.checkOut);
  const foodAll = here.flatMap((r) =>
    r.booking.tents.flatMap((t) => t.guests.filter((g) => g.preferences?.trim()).map((g) => ({ who: g.name, need: g.preferences.trim() }))),
  );
  // The same person on two tents (or entered twice) with the same note is one line, not two.
  const food = [...new Map(foodAll.map((f) => [`${f.who}\u0000${f.need}`, f])).values()];
  const notes = here.filter((r) => r.booking.note?.trim()).map((r) => ({ who: whoOf(r.booking), note: r.booking.note.trim() }));

  return { date, arriving, leaving, staying, breakfast, dinner, food, notes, quiet: here.length === 0 };
}

const line = (items, one) =>
  items.length ? items.map((s) => `${s.who} (${[s.guests ? plural(s.guests, 'guest') : null, tentsLabel(s.tents) || null].filter(Boolean).join(', ') || one})`).join('; ') : 'Nobody';

/**
 * The five one-line values the tvc_stays_daily_plan template fills in (Meta forbids newlines inside a variable).
 * @param {DayPlan} plan
 * @param {string} dateLabel
 */
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

/**
 * The plan as a plain message a person can paste into WhatsApp.
 * @param {DayPlan} plan
 * @param {string} dateLabel
 */
export function planToMessageText(plan, dateLabel) {
  const who = (items) =>
    items.length ? items.map((s) => `${tentsLabel(s.tents)} ${s.who}${s.guests ? ` (${plural(s.guests, 'guest')})` : ''}`).join('; ') : 'none';
  return [
    `Stays plan, ${dateLabel}`,
    '',
    `Check-ins: ${who(plan.arriving)}`,
    `Check-outs: ${who(plan.leaving)}`,
    `Breakfast: ${plan.breakfast}. Dinner: ${plan.dinner}.`,
    plan.food.length ? `Food: ${plan.food.map((f) => `${f.who} - ${f.need}`).join('; ')}` : null,
    plan.notes.length ? `Notes: ${plan.notes.map((n) => `${n.who} - ${n.note}`).join('; ')}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
