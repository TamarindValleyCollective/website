// Pure logic behind the partner API's read endpoints (GET /units and
// GET /availability): validating the date window, and turning the farm's
// bookings into per-night free/unavailable answers. No I/O, so it is tested
// directly (partner-availability.test.mjs); scripts/lib/partner-db.mjs fetches
// the rows this consumes.
//
// What counts as "unavailable" for a unit on a night:
//   - the unit has a tent assignment (any booking type) covering the night;
//   - a farm-closure booking covers the night. Those have no tent rows at all
//     (accommodation_create_booking checks every tent at creation time, but
//     stores none), so they must be applied to every unit here;
//   - an exclusive booking (a private event that has the whole farm) covers
//     the night. The flag's exact meaning lives in the admin UI, so this
//     errs on the side of showing less availability, never more.
// A partner is never told why a unit is unavailable, only that it is.

export const MAX_WINDOW_NIGHTS = 90;
export const MAX_HORIZON_DAYS = 365;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtcMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// True only for a real calendar date written YYYY-MM-DD (rejects 2026-02-30).
export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

export function addDays(date, days) {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

export function todayInIst(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// [from, to) as the dates of each night. Returns { error } when the window is
// not acceptable: it must be real dates, at most 90 nights, start today (India
// time) or later and end within a year from today.
export function parseWindow(from, to, now = new Date()) {
  if (!isValidDate(from) || !isValidDate(to)) return { error: 'from and to must be dates written YYYY-MM-DD' };
  if (to <= from) return { error: 'to must be after from (the night of to is not included)' };
  const nights = (toUtcMs(to) - toUtcMs(from)) / DAY_MS;
  if (nights > MAX_WINDOW_NIGHTS) return { error: `The window can cover at most ${MAX_WINDOW_NIGHTS} nights` };
  const today = todayInIst(now);
  if (from < today) return { error: 'from cannot be in the past' };
  if (to > addDays(today, MAX_HORIZON_DAYS)) return { error: `Dates can be at most ${MAX_HORIZON_DAYS} days ahead` };
  const dates = [];
  for (let i = 0; i < nights; i += 1) dates.push(addDays(from, i));
  return { dates };
}

// PostgREST returns a daterange as text: "[2026-12-12,2026-12-15)". Returns
// the half-open range as { start, end } dates, or null when unparseable.
export function parseDateRange(text) {
  const match = /^[[(](\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})[\])]$/.exec(String(text ?? ''));
  if (!match) return null;
  const [, a, b] = match;
  // Postgres canonicalises dateranges to [) form, but handle the others.
  const start = text.startsWith('(') ? addDays(a, 1) : a;
  const end = text.endsWith(']') ? addDays(b, 1) : b;
  return { start, end };
}

function covers(range, date) {
  return range.start <= date && date < range.end;
}

// Everything the catalogue shows a partner about its units and pools. Never
// includes who owns a unit, and `kind` is left out (it would reveal member
// homes).
export function toCatalogue({ units, pools }) {
  return {
    units: units
      .filter((u) => u.active)
      .map((u) => ({ id: u.id, name: u.name, capacity: u.capacity, ...(u.group_name ? { group: u.group_name } : {}) })),
    pools: pools
      .filter((p) => p.active)
      .map((p) => {
        const members = p.units.filter((u) => u.active);
        const caps = members.map((u) => u.capacity);
        return {
          id: p.id,
          name: p.name,
          size: members.length,
          capacity: caps.length ? { min: Math.min(...caps), max: Math.max(...caps) } : { min: 0, max: 0 },
        };
      }),
  };
}

// units: the units to report individually (already limited to the partner's
// grants); pools: [{ id, name, units: [every active unit in the pool] }];
// assignments: [{ tent_id, stay_range }]; blocks: [{ start, end }] ranges that
// close every unit (farm closures, exclusive bookings).
export function buildAvailability({ dates, units, pools, assignments, blocks }) {
  const busy = new Map();
  for (const a of assignments) {
    const range = parseDateRange(a.stay_range);
    if (!range) continue;
    busy.set(a.tent_id, [...(busy.get(a.tent_id) ?? []), range]);
  }
  const allBlocks = blocks.filter((b) => b && b.start && b.end);

  function isFree(unitId, date) {
    if (allBlocks.some((b) => covers(b, date))) return false;
    return !(busy.get(unitId) ?? []).some((r) => covers(r, date));
  }

  return {
    from: dates[0],
    to: addDays(dates[dates.length - 1], 1),
    units: units
      .filter((u) => u.active)
      .map((u) => ({
        id: u.id,
        nights: Object.fromEntries(dates.map((d) => [d, isFree(u.id, d) ? 'free' : 'unavailable'])),
      })),
    pools: pools.map((p) => {
      const members = p.units.filter((u) => u.active);
      return {
        id: p.id,
        nights: Object.fromEntries(
          dates.map((d) => [d, { free: members.filter((u) => isFree(u.id, d)).length, total: members.length }]),
        ),
      };
    }),
  };
}

// A booking row ({ start_date, nights }) as a half-open range.
export function bookingRange(row) {
  return { start: row.start_date, end: addDays(row.start_date, row.nights) };
}
