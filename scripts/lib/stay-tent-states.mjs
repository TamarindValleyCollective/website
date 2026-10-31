// What each tent is doing on one day, for the Day view's "By tent" tiles (accommodation-calendar.astro). Pure and tested.
//
// Nights, not days: a stay occupies the nights [start, check-out), so on the check-out day the tent is free tonight but
// still needs cleaning ("leaving"), and a tent where one stay ends and another begins that day is a "turnover".
//
//   arriving   a stay starts today              staying    on the farm before today and here tonight
//   leaving    a stay ends today, nobody new    turnover   one stay ends today and another starts today
//   closed     a tent closure, or a whole-farm closure (unless the unit is set to stay open)
//   member     a member-run unit with nothing booked: staff cannot book it
//   free       nothing tonight and nobody leaving
import { checkOutDate } from './stay-notice.mjs';

const covers = (b, date) => b.startDate <= date && date < checkOutDate(b.startDate, b.nights);

/**
 * @param {any[]} units the farm's units (id, label, shortLabel, group, capacity, manager, status, ignoresFarmClosure)
 * @param {any[]} bookings the admin API's bookings
 * @param {string} date YYYY-MM-DD
 * @returns {Array<{ unit: any, k: 'free' | 'arriving' | 'staying' | 'leaving' | 'turnover' | 'closed' | 'member', booking?: any, leaving?: any, why?: string }>}
 */
export function unitStates(units, bookings, date) {
  const farmClosure = bookings.find((b) => b.type === 'farm-closure' && covers(b, date));
  return units
    .filter((u) => u.status !== 'offboarded')
    .map((unit) => {
      const mine = bookings.filter((b) => b.type !== 'farm-closure' && b.tents.some((t) => t.tentId === unit.id));
      const tonight = mine.find((b) => covers(b, date));
      const leaving = mine.find((b) => b.type !== 'unit-closure' && checkOutDate(b.startDate, b.nights) === date);

      if (tonight?.type === 'unit-closure') return { unit, k: 'closed', booking: tonight, why: tonight.label ?? tonight.note ?? 'Closed' };
      if (farmClosure && !unit.ignoresFarmClosure) return { unit, k: 'closed', why: farmClosure.note ?? 'Farm on Vacation' };
      if (tonight && leaving) return { unit, k: 'turnover', booking: tonight, leaving };
      if (tonight) return { unit, k: tonight.startDate === date ? 'arriving' : 'staying', booking: tonight };
      if (leaving) return { unit, k: 'leaving', booking: leaving };
      return { unit, k: unit.manager === 'member' ? 'member' : 'free' };
    });
}

/**
 * The line above the tiles: how many of the farm's own tents are in use tonight, and what is free (with its beds).
 * Closed and member-run units are not counted either way.
 * @param {ReturnType<typeof unitStates>} states
 */
export function tentSummary(states) {
  const open = states.filter((s) => s.unit.manager !== 'member' && s.k !== 'closed');
  const inUse = open.filter((s) => s.k === 'arriving' || s.k === 'staying' || s.k === 'turnover');
  const free = open.filter((s) => s.k === 'free' || s.k === 'leaving');
  return {
    total: open.length,
    inUse: inUse.length,
    free: free.map((s) => s.unit.shortLabel || s.unit.label),
    freeBeds: free.reduce((n, s) => n + (s.unit.capacity ?? 0), 0),
  };
}
