// How many units of each type are free on each night: the numbers behind the Week and Month capacity views of the Stays
// page (src/components/stays/CapacityView.astro). Pure (no database, no clock) so the screen only has to draw it and the
// rules are tested. A stay occupies the nights [startDate, check-out); the check-out day itself is not a night.
//
// A unit is free on a night when it is on offer and nothing holds it: no booking (including a tent closure) has it that
// night, and no whole-farm closure shuts it (a unit marked ignoresFarmClosure stays open through one).
import { nightsOf } from './stay-booking-flow.mjs';

/** On offer: not paused, not offboarded, and not a member's unit set to turn requests away. */
export const isOffered = (unit) => unit.status !== 'paused' && unit.status !== 'offboarded' && !(unit.manager === 'member' && unit.requestMode === 'reject');

/**
 * What holds each night: the units with a booking, and whether the whole farm is closed.
 * @param {any[]} bookings
 * @returns {Map<string, { units: Set<string>, farmClosed: boolean }>}
 */
export function nightIndex(bookings) {
  const index = new Map();
  for (const b of bookings) {
    for (const night of nightsOf(b.startDate, b.nights)) {
      let entry = index.get(night);
      if (!entry) index.set(night, (entry = { units: new Set(), farmClosed: false }));
      if (b.type === 'farm-closure') entry.farmClosed = true;
      else for (const t of b.tents) entry.units.add(t.tentId);
    }
  }
  return index;
}

/**
 * Free and total units of the given types on one night.
 * @param {any[]} units every unit
 * @param {Map<string, { units: Set<string>, farmClosed: boolean }>} index from nightIndex
 * @param {string} date
 * @param {string[] | null} typeIds null = every type
 * @returns {{ free: number, total: number }}
 */
export function capacityOn(units, index, date, typeIds = null) {
  const held = index.get(date);
  let free = 0;
  let total = 0;
  for (const u of units) {
    if (!isOffered(u) || (typeIds && !typeIds.includes(u.type))) continue;
    total += 1;
    if (held?.units.has(u.id)) continue;
    if (held?.farmClosed && !u.ignoresFarmClosure) continue;
    free += 1;
  }
  return { free, total };
}

/**
 * How full a cell is: 'none' (nothing of this type on offer), 'full', 'tight' (three quarters taken or more) or 'open'.
 * @param {{ free: number, total: number }} c
 */
export function levelOf({ free, total }) {
  if (total === 0) return 'none';
  if (free === 0) return 'full';
  return (total - free) / total >= 0.75 ? 'tight' : 'open';
}

/** Share of the units taken, 0 to 1. */
export const taken = ({ free, total }) => (total ? (total - free) / total : 0);

/**
 * One row per type that has units on offer, with a cell per date.
 * @param {{ units: any[], types: { id: string, label: string }[], bookings: any[], dates: string[] }} input
 */
export function capacityRows({ units, types, bookings, dates }) {
  const index = nightIndex(bookings);
  return types
    .map((type) => ({
      type,
      cells: dates.map((date) => ({ date, ...capacityOn(units, index, date, [type.id]) })),
      total: units.filter((u) => u.type === type.id && isOffered(u)).length,
    }))
    .filter((row) => row.total > 0);
}

/** The month calendar's cells: the day of the week (Monday first, 0 to 6) the first date falls on, and a cell per date. */
export function monthCells({ units, bookings, dates, typeIds }) {
  const index = nightIndex(bookings);
  const [y, m, d] = dates[0].split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return { lead, cells: dates.map((date) => ({ date, ...capacityOn(units, index, date, typeIds?.length ? typeIds : null) })) };
}

const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * Whether a request fits: `qty` units of a type free for every night of a stay. When it does not, the first night that is
 * short and the next start date (within `lookahead` days) that would fit.
 * @param {{ units: any[], bookings: any[], typeId: string, qty: number, from: string, nights: number, lookahead?: number }} input
 * @returns {{ ok: true, fewest: number } | { ok: false, shortOn: string, free: number, next: string | null }}
 */
export function findSpace({ units, bookings, typeId, qty, from, nights, lookahead = 60 }) {
  const index = nightIndex(bookings);
  const freeOn = (date) => capacityOn(units, index, date, [typeId]).free;
  const check = (start) => {
    let fewest = Infinity;
    for (const night of nightsOf(start, nights)) {
      const free = freeOn(night);
      if (free < qty) return { ok: false, shortOn: night, free };
      fewest = Math.min(fewest, free);
    }
    return { ok: true, fewest };
  };
  const result = check(from);
  if (result.ok) return result;
  let next = null;
  for (let i = 1; i <= lookahead && next === null; i++) if (check(addDays(from, i)).ok) next = addDays(from, i);
  return { ...result, next };
}
