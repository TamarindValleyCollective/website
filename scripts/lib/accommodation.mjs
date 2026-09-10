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
// `group` is a display-only clustering (Sharath, 2026-09-10) for the admin
// tool's Tents picker - Malabar/Banyan/Bamboo/Portable, matching how the
// site's own marketing copy already talks about accommodation types (see
// the accommodationTypes content collection). Purely presentational: not
// read by any booking/conflict/capacity logic, which still operates per
// physical unit id exactly as before.
// `shortLabel` (same day) is the checkbox text used ONLY inside that same
// grouped picker, where the group heading directly above already says
// "Malabar Hut"/etc - repeating it on every checkbox read as redundant.
// `label` (the full, standalone name) is still used everywhere else that has
// no group heading for context: grid/day-view tooltips, a guest's past-stays
// list, booking cards. Nothing about a booking ever stores either string -
// both are always looked up fresh from this file by tentId at display time
// (see rowToBooking/UNITS.find() call sites), so renaming either one here
// immediately updates every place it's shown, confirmation emails included
// once that feature exists.
//
// Wording (2026-09-10, Sharath): every unit says "Tent" except Bamboo Huts,
// which says "Hut" instead (matches its own group name) - and Tent08/09
// (Portable Tents, previously just "Campground Portable" x2 with nothing to
// tell them apart but capacity) got real names, "Large"/"Medium". `label`
// keeps the group name as a prefix (it has no heading nearby to supply that
// context); `shortLabel` drops it (the picker's own group heading already
// supplies it) - same wording otherwise, so the two names for one unit never
// read as contradicting each other across different parts of the page.
// BYOT01-05 (2026-09-10, Sharath): five slots for guests camping in their
// own tent rather than one of the farm's own 9 physical units above - "the
// capacity of the tents is not material here" (there's no real structure
// with a fixed bed count to enforce), but guest details still need
// recording the same as any other tent, so each slot gets a working cap of
// 3 for that purpose specifically (Sharath's follow-up). `kind: 'byot'`
// exists only to exclude these from TOTAL_ROOMS/TOTAL_CAPACITY below (the
// farm's own physical-room figures) - everything else (capacity, the dots
// meter, Family Booking, conflict-checking so the same slot can't be
// double-booked) reuses the exact same code path as a real unit, since a
// slot behaves identically to one for every purpose except "is this a room
// the farm itself owns." Its own group ("Bring Your Own Tent") means the
// existing group-rendering (booking form's Tents picker, and the calendar's
// day/week/month views once that grouping was extended there) picks these
// up automatically - no new UI code needed for this, just data.
export const ACCOMMODATION_UNITS = [
  { id: 'Tent01', label: 'Malabar Hut Fixed Tent (N)', shortLabel: 'Fixed Tent (N)', capacity: 3, kind: 'fixed', group: 'Malabar Hut' },
  { id: 'Tent02', label: 'Malabar Hut Fixed Tent (S)', shortLabel: 'Fixed Tent (S)', capacity: 3, kind: 'fixed', group: 'Malabar Hut' },
  { id: 'Tent03', label: 'Malabar Hut Portable Tent', shortLabel: 'Portable Tent', capacity: 2, kind: 'removable', group: 'Malabar Hut' },
  { id: 'Tent04', label: 'Banyan Hut Fixed Tent', shortLabel: 'Fixed Tent', capacity: 3, kind: 'fixed', group: 'Banyan Hut' },
  { id: 'Tent05', label: 'Banyan Hut Portable Tent', shortLabel: 'Portable Tent', capacity: 2, kind: 'removable', group: 'Banyan Hut' },
  { id: 'Tent06', label: 'Upper Bamboo Hut', shortLabel: 'Upper Hut', capacity: 2, kind: 'fixed', group: 'Bamboo Huts' },
  { id: 'Tent07', label: 'Lower Bamboo Hut', shortLabel: 'Lower Hut', capacity: 2, kind: 'fixed', group: 'Bamboo Huts' },
  { id: 'Tent08', label: 'Large Portable Tent', shortLabel: 'Large Tent', capacity: 3, kind: 'removable', group: 'Portable Tents' },
  { id: 'Tent09', label: 'Medium Portable Tent', shortLabel: 'Medium Tent', capacity: 2, kind: 'removable', group: 'Portable Tents' },
  { id: 'BYOT01', label: 'Bring Your Own Tent 1', shortLabel: 'Tent 1', capacity: 3, kind: 'byot', group: 'Bring Your Own Tent' },
  { id: 'BYOT02', label: 'Bring Your Own Tent 2', shortLabel: 'Tent 2', capacity: 3, kind: 'byot', group: 'Bring Your Own Tent' },
  { id: 'BYOT03', label: 'Bring Your Own Tent 3', shortLabel: 'Tent 3', capacity: 3, kind: 'byot', group: 'Bring Your Own Tent' },
  { id: 'BYOT04', label: 'Bring Your Own Tent 4', shortLabel: 'Tent 4', capacity: 3, kind: 'byot', group: 'Bring Your Own Tent' },
  { id: 'BYOT05', label: 'Bring Your Own Tent 5', shortLabel: 'Tent 5', capacity: 3, kind: 'byot', group: 'Bring Your Own Tent' },
];

// The farm's own physical rooms only - BYOT slots aren't a structure the
// farm owns, so they don't belong in a "how many rooms/people can the farm
// itself house" figure (not currently read anywhere outside this file, but
// kept correct in case that changes - see the file's own header comment on
// the now-dropped public availability view this was originally built for).
const PHYSICAL_UNITS = ACCOMMODATION_UNITS.filter((u) => u.kind !== 'byot');
export const TOTAL_ROOMS = PHYSICAL_UNITS.length;
export const TOTAL_CAPACITY = PHYSICAL_UNITS.reduce((sum, u) => sum + u.capacity, 0);

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

// A generic "does this look like an email" shape check, not a real
// RFC 5322 validator - matches the same permissive local@domain.tld pattern
// as the accommodation_people_email_format CHECK constraint added in
// migration 0015, so the client's instant feedback and the DB's actual
// backstop can never disagree about what counts as valid. Guest email is
// captured for a possible future confirmation-email feature (no sender
// exists yet) - like mobile number, optional and untrimmed here; the caller
// decides what "not provided" vs "provided but invalid" means.
export function isValidEmail(raw) {
  if (!raw) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.trim());
}
