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

// The farm's fixed tent/hut inventory. Updated with Sharath (2026-08-31):
// renamed every unit, switched to generic `TentNN` ids (the old
// location-named ids like `malabar-1`/`portable-3` were judged not generic
// enough now that every unit is, physically, a tent), reclassified the old
// "Portable Tent 4/5" as the named fixed Upper/Lower Bamboo Hut, and added
// one new 2-person Campground Portable - 9 units, 22-person total capacity
// (was 8 units / 20 people). Renaming the ids is a real migration, not just
// a relabel: existing bookings' `tent_id` in `accommodation_tent_assignments`
// had to be rewritten from the old ids to the new ones (see
// supabase/migrations/0012_accommodation_unit_inventory_update.sql) - the
// `TentNN` order below matches the order that migration's UPDATE mapping
// uses, confirmed against Sharath's original numbered list so no booking's
// tent gets silently reassigned to the wrong physical unit.
export const ACCOMMODATION_UNITS = [
  { id: 'Tent01', label: 'Malabar Hut Fixed (N)', capacity: 3, kind: 'fixed' },
  { id: 'Tent02', label: 'Malabar Hut Fixed (S)', capacity: 3, kind: 'fixed' },
  { id: 'Tent03', label: 'Malabar Hut Portable', capacity: 2, kind: 'removable' },
  { id: 'Tent04', label: 'Banyan Hut Fixed', capacity: 3, kind: 'fixed' },
  { id: 'Tent05', label: 'Banyan Hut Portable', capacity: 2, kind: 'removable' },
  { id: 'Tent06', label: 'Upper Bamboo Hut', capacity: 2, kind: 'fixed' },
  { id: 'Tent07', label: 'Lower Bamboo Hut', capacity: 2, kind: 'fixed' },
  { id: 'Tent08', label: 'Campground Portable', capacity: 3, kind: 'removable' },
  { id: 'Tent09', label: 'Campground Portable', capacity: 2, kind: 'removable' },
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

// Normalizes a guest's mobile number to E.164 (+<country code><digits>),
// defaulting to +91 (India) when no country code is given - this farm's
// guests are overwhelmingly Indian, and a bare 10-digit number typed into
// this field is always meant as a local Indian mobile number, not a
// landline (the whole point of collecting it is reaching a guest on
// WhatsApp/SMS). Returns null for empty input (field is optional) or for
// anything that doesn't parse as a plausible mobile number, so callers can
// tell "not provided" apart from "provided but invalid" and reject the
// latter rather than silently dropping it.
//
// Imported by both the client script (accommodation-calendar.astro, for
// instant feedback) and the server (accommodation-admin.mts, the actual
// gate) - one implementation, so "what counts as a valid mobile number"
// can't drift between the two.
export function normalizeMobileNumber(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasCountryCode = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasCountryCode) {
    // Generic E.164 plausibility check (8-15 digits total after the '+').
    // Real per-country mobile-vs-landline validation needs a library like
    // libphonenumber - disproportionate here given this farm's guest mix,
    // so a country code other than +91 just gets this looser check rather
    // than a false sense of per-country strictness.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  // No country code given - assume India. Indian mobile numbers are
  // exactly 10 digits and start with 6-9 under TRAI's numbering plan;
  // landline numbers and any other length are rejected outright rather
  // than accepted as if they were a mobile number.
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}
