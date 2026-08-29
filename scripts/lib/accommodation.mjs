// Shared accommodation-calendar data/logic for the prototype described in
// the design conversation this ships alongside: an internal booking tool
// (netlify/functions/accommodation-admin.mts,
// src/pages/internal/accommodation-calendar.astro) and a public availability
// view (netlify/functions/accommodation-availability.mts,
// src/components/views/AvailabilityView.astro). Plain ESM (not TypeScript),
// same reasoning as google-drive.mjs/google-id-token.mjs - both Netlify
// Functions (bundled by esbuild) and Astro pages/components (via Vite) can
// import this directly, with no risk of a TS-file cross-boundary import
// failing to resolve in either bundler.

// The farm's fixed tent/hut inventory. Confirmed with Sharath (2026-08-29):
// 3 fixed tents (Malabar x2, Banyan x1, 3 people each) plus 5 portable tents
// (1 three-person, 4 two-person) - sums to exactly the ~20-person cap already
// quoted on /visit/camping. Lives here as static data rather than a content
// collection or Blobs record since it only changes when the farm physically
// adds/removes a tent - a deploy-worthy change, same as everything else that
// lives in git on this site.
export const ACCOMMODATION_UNITS = [
  { id: 'malabar-1', label: 'Malabar Tent 1', capacity: 3, kind: 'fixed' },
  { id: 'malabar-2', label: 'Malabar Tent 2', capacity: 3, kind: 'fixed' },
  { id: 'banyan', label: 'Banyan Hut', capacity: 3, kind: 'fixed' },
  { id: 'portable-1', label: 'Portable Tent 1', capacity: 3, kind: 'removable' },
  { id: 'portable-2', label: 'Portable Tent 2', capacity: 2, kind: 'removable' },
  { id: 'portable-3', label: 'Portable Tent 3', capacity: 2, kind: 'removable' },
  { id: 'portable-4', label: 'Portable Tent 4', capacity: 2, kind: 'removable' },
  { id: 'portable-5', label: 'Portable Tent 5', capacity: 2, kind: 'removable' },
];

export const TOTAL_ROOMS = ACCOMMODATION_UNITS.length;
export const TOTAL_CAPACITY = ACCOMMODATION_UNITS.reduce((sum, u) => sum + u.capacity, 0);

const DAY_MS = 86_400_000;

function parseYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

// A booking's `nights` count covers full calendar nights starting at
// `startDate` - no same-day-turnover modeling (see the design conversation).
// A 3-night booking starting 2026-09-10 occupies the nights of the 10th,
// 11th, and 12th.
export function nightsForBooking(booking) {
  const start = parseYmd(booking.startDate);
  const out = [];
  for (let i = 0; i < booking.nights; i++) {
    out.push(toYmd(new Date(start.getTime() + i * DAY_MS)));
  }
  return out;
}

// All calendar-date strings (YYYY-MM-DD) in a given "YYYY-MM" month.
export function datesInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++) {
    out.push(`${monthStr}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

// Whether any night of `booking` falls within `monthStr` ("YYYY-MM") - used
// to decide which stored bookings are relevant to a given month view without
// needing a secondary date index (see accommodation-admin.mts/
// accommodation-availability.mts's own comments on why a plain store.list()
// scan is fine at this farm's scale).
export function bookingTouchesMonth(booking, monthStr) {
  return nightsForBooking(booking).some((d) => d.startsWith(monthStr));
}
