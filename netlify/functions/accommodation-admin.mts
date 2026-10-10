// Netlify Function (v2 API) backing the internal accommodation-calendar
// admin tool (src/pages/internal/accommodation-calendar.astro). Lets the
// farm manager, Madhavan, record bookings against the farm's fixed tent
// inventory (scripts/lib/accommodation.mjs) - who's in which tent, for how
// long, and why (linked public event / private retreat / casual Linger
// stay / community-member stay / a tent or the whole farm closed). This is
// the only place guest names/ages/genders are ever readable; the public
// counterpart (accommodation-availability.mts) is a deliberately separate
// file with no auth and no access to this data, so a routing mistake here
// can't leak guest PII to a visitor.
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts)
// verifies the ID token and checks the caller's role in the "accommodation"
// module — `view` to read, `edit` to create/update/delete and to search the
// guest directory. Migrated 2026-10 from the dedicated "Accommodation
// Calendar - Allowed Emails" Sheet; its three roles map onto the shared ones:
// admin -> admin, restricted -> user with scope.allowedTypes, viewer ->
// read_only. A `user` row may carry scope.allowedTypes to limit which booking
// types they can write; writes are enforced here (canWriteType), not just
// hidden in the UI — the type is attacker-controlled in the request body, so
// canWriteType() gates handleCreate/handleUpdate/handleDelete directly.
//
// Privacy: a guest's mobile number and email are write-only — they never
// leave this Function. Responses carry hasMobile/hasEmail flags instead; the
// page shows "On file (hidden)" and lets staff replace a value, and a save
// that omits them keeps the stored ones (accommodation_resolve_person
// coalesces). Names and preferences/allergies are sent in full to roles that
// operate the calendar and withheld/masked for read_only. Staff are recorded
// by id, not email, in created_by/updated_by and the booking audit log.
import { requireStaff, type StaffGrant } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { BOOKING_TYPES, type BookingType, type Capability } from './lib/staff-registry';
import { ACCOMMODATION_UNITS, normalizeMobileNumber, isValidEmail } from '../../scripts/lib/accommodation.mjs';
import { listBookingsForAdmin, createBooking, updateBooking, deleteBooking, searchGuests, listStaysForPerson, getBookingById } from '../../scripts/lib/accommodation-db.mjs';


interface Guest {
  personId?: string;
  name?: string;
  mobileNumber?: string;
  email?: string;
  ageGroup?: 'Adult' | 'Child';
  gender?: string;
  preferences?: string;
}

interface TentAssignment {
  tentId: string;
  // "Family Booking" checkbox (see accommodation-calendar.astro's
  // effectiveCapacity) - caps this tent at 1 guest instead of its real
  // physical capacity, for the common solo/one-family-occupancy case.
  // Persisted (migration 0017) so reopening a saved booking doesn't silently
  // reopen the tent back up to full capacity.
  solo?: boolean;
  guests: Guest[];
}

interface Booking {
  id: string;
  type: BookingType;
  eventSlug?: string;
  // Snapshotted at creation time from the events content collection by the
  // admin page (which can read astro:content) - this Function can't read
  // Astro content collections at runtime (same constraint event-interest.mts
  // notes about itself), so the public-event's title travels with the
  // booking rather than being re-fetched per request.
  eventTitle?: string;
  label?: string;
  exclusive?: boolean;
  startDate: string;
  nights: number;
  tents: TentAssignment[];
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Whether an authenticated caller may create/edit/delete a booking of the
// given type - never how much they can *read*, which is the same for every
// role (the whole grid), restriction only on writes. `admin` writes anything;
// `user` writes the types in scope.allowedTypes, or any type when the row
// carries no scope; `read_only` writes nothing.
function canWriteType(staff: StaffGrant, type: BookingType): boolean {
  if (staff.role === 'admin') return true;
  if (staff.role === 'user') {
    const allowed = staff.scope?.allowedTypes;
    return allowed ? allowed.includes(type) : true;
  }
  return false;
}

// The page (accommodation-calendar.astro) still reasons in the old three
// roles, so hand it that shape: a `user` with a type scope is its
// 'restricted', one without is indistinguishable from 'admin' for the page's
// purposes (writes everything). The server-side canWriteType above is the
// real gate either way.
function pageAccess(staff: StaffGrant): { role: 'admin' | 'restricted' | 'viewer'; allowedTypes: BookingType[] | null } {
  if (staff.role === 'read_only') return { role: 'viewer', allowedTypes: null };
  if (staff.role === 'user' && staff.scope?.allowedTypes) {
    return { role: 'restricted', allowedTypes: staff.scope.allowedTypes as BookingType[] };
  }
  return { role: 'admin', allowedTypes: null };
}

const VALID_TYPES: readonly BookingType[] = BOOKING_TYPES;
const UNITS_BY_ID = new Map(ACCOMMODATION_UNITS.map((u) => [u.id, u]));
const VALID_AGE_GROUPS = ['Adult', 'Child'];
const VALID_GENDERS = ['Male', 'Female', 'NA'];

function validateBookingInput(input: Partial<Booking>): string | null {
  if (!input.type || !VALID_TYPES.includes(input.type)) return `type must be one of ${VALID_TYPES.join(', ')}`;
  if (!input.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) return 'startDate must be YYYY-MM-DD';
  if (!Number.isInteger(input.nights) || (input.nights as number) < 1) return 'nights must be a positive integer';
  if (!Array.isArray(input.tents)) return 'tents must be an array (empty for a farm-wide closure)';
  for (const t of input.tents) {
    const unit = UNITS_BY_ID.get(t.tentId);
    if (!unit) return `Unknown tentId "${t.tentId}"`;
    // The hard cap this whole model rests on - "the same tent cannot be
    // shared across 2 different events" only means something if a tent's
    // own guest count can't exceed its own physical capacity either.
    if (Array.isArray(t.guests) && t.guests.length > unit.capacity) {
      return `${unit.label} holds at most ${unit.capacity}, but ${t.guests.length} guest(s) were assigned`;
    }
    // Mirrors the client's own soloCheckbox.disabled rule (guestCount >= 2
    // can't turn it on) and its "doesn't apply to BYOT" rule - both are only
    // enforced client-side otherwise, and this endpoint is the actual
    // trust boundary for everything else in this loop.
    if (t.solo && Array.isArray(t.guests) && t.guests.length > 1) {
      return `${unit.label} is marked as a solo/family booking but has ${t.guests.length} guests`;
    }
    if (t.solo && unit.kind === 'byot') {
      return `${unit.label} is a Bring Your Own Tent slot - the solo/family booking option doesn't apply to it`;
    }
    // Name, age group, and gender are all mandatory per guest now (name was
    // originally allowed to be blank, but live testing found a booking could
    // silently save with an unnamed guest, which isn't wanted after all) -
    // the client's own form already enforces all three (required inputs,
    // and both selects always default to a real option), so a violation
    // here means a request bypassing the client's form, not a legitimate
    // partial entry.
    for (const g of t.guests ?? []) {
      if (!g.name || !g.name.trim()) return 'Each guest needs a name';
      if (!g.ageGroup || !VALID_AGE_GROUPS.includes(g.ageGroup)) return `Each guest needs an age group (${VALID_AGE_GROUPS.join('/')})`;
      if (!g.gender || !VALID_GENDERS.includes(g.gender)) return `Each guest needs a gender (${VALID_GENDERS.join('/')})`;
      // personId, when present, must be a real UUID - it's meant to come
      // only from a guest-search result the client displayed, never typed
      // freehand, so anything else means a request bypassing that flow.
      if (g.personId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.personId)) {
        return 'personId must be a UUID';
      }
      // Mobile number is mandatory for a genuinely new guest (Sharath,
      // 2026-09-15) - but every save resends the booking's *entire* guest
      // list (accommodation_replace_tents replaces all of it), so requiring
      // it unconditionally here blocked editing any of it - e.g. cancelling
      // one guest out of an old multi-guest event booking - the moment a
      // single, otherwise-untouched guest predating this rule had no mobile
      // on file (Sharath, 2026-09-29). A guest with a personId already
      // exists in the directory; don't retroactively force a backfill just
      // because their booking is being edited for an unrelated reason.
      // Normalizes in place either way (bare 10-digit numbers become
      // +91-prefixed) so accommodation-db.mjs/the RPC layer only ever see an
      // already-normalized value, never raw client input, when one is given.
      // See normalizeMobileNumber's own comment for the validation rules.
      if (!g.mobileNumber || g.mobileNumber.trim() === '') {
        if (g.personId == null) return 'Each guest needs a mobile number';
      } else {
        const normalized = normalizeMobileNumber(g.mobileNumber);
        if (!normalized) return `"${g.mobileNumber}" doesn't look like a valid mobile number - use a 10-digit Indian number or include a country code (e.g. +1...)`;
        g.mobileNumber = normalized;
      }
      // Optional, captured for a possible future confirmation-email feature
      // (see migration 0015) - same shape check the DB's own CHECK
      // constraint enforces as a backstop, via the one shared implementation.
      if (g.email != null && g.email.trim() !== '') {
        if (!isValidEmail(g.email)) return `"${g.email}" doesn't look like a valid email address`;
        g.email = g.email.trim();
      } else {
        g.email = undefined;
      }
    }
  }
  if (input.type === 'public-event' && !input.eventSlug) return 'eventSlug is required for type "public-event"';
  return null;
}

// Short, non-reversible tag that tells two same-named guests apart in the
// page's typeahead now that their numbers are no longer shown.
function personRef(id: string): string {
  return id.slice(0, 4).toUpperCase();
}

// What a caller may see of one directory person: contact details are never
// sent (only whether each is on file); the name is masked and the
// preferences/allergies withheld for read-only roles.
function shapePerson(p: any, staff: StaffGrant) {
  const visible = canSeeNames(staff.role);
  return {
    name: visible ? p.name : maskName(p.name ?? ''),
    hasMobile: Boolean(p.mobileNumber),
    hasEmail: Boolean(p.email),
    gender: p.gender,
    preferences: visible ? p.preferences : undefined,
  };
}

// Strips a raw booking (from accommodation-db.mjs, which still carries the
// real mobile/email so the data layer stays honest) down to what the browser
// may see. createdBy/updatedBy are dropped too: the page never displayed them
// and they held staff emails.
function shapeBooking(b: any, staff: StaffGrant) {
  const { createdBy: _createdBy, updatedBy: _updatedBy, ...rest } = b;
  return {
    ...rest,
    tents: (b.tents ?? []).map((t: any) => ({
      ...t,
      guests: (t.guests ?? []).map((g: any) => ({
        personId: g.personId,
        ageGroup: g.ageGroup,
        ...shapePerson(g, staff),
      })),
    })),
  };
}

async function handleList(url: URL, staff: StaffGrant): Promise<Response> {
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ error: 'month is required, as YYYY-MM' }, 400);

  const bookings = await listBookingsForAdmin({ month });
  return jsonResponse({
    units: ACCOMMODATION_UNITS,
    bookings: bookings.map((b: any) => shapeBooking(b, staff)),
    access: pageAccess(staff),
  });
}

async function handleCreate(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: Partial<Booking>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const validationError = validateBookingInput(payload);
  if (validationError) return jsonResponse({ error: validationError }, 400);
  if (!canWriteType(staff, payload.type!)) {
    return jsonResponse({ error: `You are not authorized to create a "${payload.type}" booking` }, 403);
  }

  try {
    const booking = await createBooking({
      type: payload.type!,
      eventSlug: payload.eventSlug,
      eventTitle: payload.eventTitle,
      label: payload.label,
      exclusive: payload.type === 'private-event' ? Boolean(payload.exclusive) : undefined,
      startDate: payload.startDate!,
      nights: payload.nights!,
      tents: payload.tents ?? [],
      note: payload.note,
      createdBy: staff.id,
    });
    return jsonResponse({ booking: shapeBooking(booking, staff) });
  } catch (err) {
    // 409 here means accommodation_create_booking's EXCLUDE-constraint-backed
    // conflict check rejected an overlapping tent/night - the error message
    // already names the conflicting booking (see the migration's rpc
    // functions), so it's passed straight through.
    const status = (err as { status?: number }).status;
    if (status === 409) return jsonResponse({ error: (err as Error).message }, 409);
    console.error('Failed to create booking', err);
    return jsonResponse({ error: 'Failed to save the booking' }, 500);
  }
}

async function handleUpdate(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: Partial<Booking> & { id?: string; reason?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!payload.id) return jsonResponse({ error: 'id is required' }, 400);
  const validationError = validateBookingInput(payload);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  // A restricted/viewer caller must be authorized for BOTH the booking's
  // current type and the type it's being changed to - otherwise a
  // Linger-scoped user could retype a member-stay into casual-stay to gain
  // write access to it, or vice versa launder a change out of their own
  // scope into a type nobody's watching.
  const existing = await getBookingById(payload.id);
  if (!existing) return jsonResponse({ error: 'Booking not found' }, 404);
  if (!canWriteType(staff, existing.type) || !canWriteType(staff, payload.type!)) {
    return jsonResponse({ error: 'You are not authorized to edit this booking' }, 403);
  }

  try {
    const booking = await updateBooking({
      id: payload.id,
      type: payload.type!,
      eventSlug: payload.eventSlug,
      eventTitle: payload.eventTitle,
      label: payload.label,
      exclusive: payload.type === 'private-event' ? Boolean(payload.exclusive) : undefined,
      startDate: payload.startDate!,
      nights: payload.nights!,
      tents: payload.tents ?? [],
      note: payload.note,
      updatedBy: staff.id,
      reason: payload.reason,
    });
    return jsonResponse({ booking: shapeBooking(booking, staff) });
  } catch (err) {
    // 404: accommodation_update_booking found no row for this id. 409: its
    // conflict check rejected an overlapping tent/night (message already
    // names the conflicting booking). 422: the booking's stay has already
    // ended and no reason was given - see the migration's rpc functions.
    const status = (err as { status?: number }).status;
    if (status === 404) return jsonResponse({ error: 'Booking not found' }, 404);
    if (status === 409) return jsonResponse({ error: (err as Error).message }, 409);
    if (status === 422) return jsonResponse({ error: (err as Error).message, code: 'PAST_BOOKING_REASON_REQUIRED' }, 422);
    console.error('Failed to update booking', err);
    return jsonResponse({ error: 'Failed to save the booking' }, 500);
  }
}

async function handleDelete(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: { id?: string; reason?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!payload.id) return jsonResponse({ error: 'id is required' }, 400);

  const existing = await getBookingById(payload.id);
  if (!existing) return jsonResponse({ error: 'Booking not found' }, 404);
  if (!canWriteType(staff, existing.type)) {
    return jsonResponse({ error: 'You are not authorized to cancel this booking' }, 403);
  }

  try {
    await deleteBooking(payload.id, { deletedBy: staff.id, reason: payload.reason });
    return jsonResponse({ ok: true });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return jsonResponse({ error: 'Booking not found' }, 404);
    if (status === 422) return jsonResponse({ error: (err as Error).message, code: 'PAST_BOOKING_REASON_REQUIRED' }, 422);
    console.error('Failed to delete booking', err);
    return jsonResponse({ error: 'Failed to delete the booking' }, 500);
  }
}

async function handleGuestSearch(url: URL, staff: StaffGrant): Promise<Response> {
  const mobile = url.searchParams.get('mobile');
  const query = url.searchParams.get('q');
  if (!mobile && !query?.trim()) return jsonResponse({ error: 'q or mobile is required' }, 400);

  // `mobile` is an exact match against what the caller typed, used by the
  // page to notice that a number already belongs to someone else. It returns
  // who (a name), never the stored number or email.
  const matches = await searchGuests({ query: query?.trim(), mobileNumber: mobile ?? undefined });
  return jsonResponse({ matches: matches.map((m: any) => ({ id: m.id, ref: personRef(m.id), ...shapePerson(m, staff) })) });
}

async function handleGuestStays(id: string, staff: StaffGrant): Promise<Response> {
  const result = await listStaysForPerson(id);
  if (!result) return jsonResponse({ error: 'Guest not found' }, 404);
  return jsonResponse({ person: { id: result.person.id, ref: personRef(result.person.id), ...shapePerson(result.person, staff) }, stays: result.stays });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const staysMatch = url.pathname.match(/^\/api\/accommodation-admin\/guests\/([^/]+)\/stays$/);

  // Pick the route first so each one is gated by the capability it needs:
  // reading is `view`; writing and searching the directory (which exists to
  // fill in a booking form) is `edit`.
  type Route = { capability: Capability<'accommodation'>; run: (staff: StaffGrant) => Promise<Response> };
  const route: Route | null =
    url.pathname === '/api/accommodation-admin/bookings' && req.method === 'GET'
      ? { capability: 'view', run: (staff) => handleList(url, staff) }
      : url.pathname === '/api/accommodation-admin/bookings' && req.method === 'POST'
        ? { capability: 'edit', run: (staff) => handleCreate(req, staff) }
        : url.pathname === '/api/accommodation-admin/bookings/update' && req.method === 'POST'
          ? { capability: 'edit', run: (staff) => handleUpdate(req, staff) }
          : url.pathname === '/api/accommodation-admin/bookings/delete' && req.method === 'POST'
            ? { capability: 'edit', run: (staff) => handleDelete(req, staff) }
            : url.pathname === '/api/accommodation-admin/guests/search' && req.method === 'GET'
              ? { capability: 'edit', run: (staff) => handleGuestSearch(url, staff) }
              : staysMatch && req.method === 'GET'
                ? { capability: 'view', run: (staff) => handleGuestStays(staysMatch[1], staff) }
                : null;
  if (!route) return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireStaff(req, 'accommodation', route.capability);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return route.run(auth.staff);
};

export const config = {
  path: [
    '/api/accommodation-admin/bookings',
    '/api/accommodation-admin/bookings/update',
    '/api/accommodation-admin/bookings/delete',
    '/api/accommodation-admin/guests/search',
    '/api/accommodation-admin/guests/:id/stays',
  ],
};
