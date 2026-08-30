// Data-access layer for the accommodation_* tables (see
// supabase/migrations/0005_accommodation_bookings.sql) in the "TVC ERP"
// Supabase project. Mirrors supabase.mjs's hand-rolled PostgREST style (no
// @supabase/supabase-js) and reuses its restHeaders for the same
// service_role auth. Used by netlify/functions/accommodation-admin.mts
// (full read/write, guest data included) and
// accommodation-availability.mts (read-only, guest-free — see
// listBookingsForAvailability's select list).
//
// Conflict-checking (no shared tent on a shared night) is enforced in
// Postgres itself, not here: accommodation_create_booking/
// accommodation_update_booking (rpc/ functions) do the multi-table write
// inside one transaction and rely on accommodation_tent_assignments' EXCLUDE
// constraint to make an overlapping insert physically impossible, even
// under concurrent requests — the race that let two identical bookings land
// 38s apart under Netlify Blobs' eventual consistency. A conflict surfaces
// here as a thrown Error with `.status` 409 (or 404 for an update against a
// deleted/nonexistent id), read directly off the RPC's HTTP response —
// PostgREST maps the functions' `RAISE EXCEPTION ... USING ERRCODE = 'PT409'`
// straight to that status code.
import { restHeaders } from './supabase.mjs';

function supabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

async function restFetch(path, options = {}) {
  const res = await fetch(`${supabaseUrl()}/rest/v1${path}`, { ...options, headers: restHeaders(options.headers) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `Supabase REST ${options.method ?? 'GET'} ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function callRpc(fnName, args) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `RPC ${fnName} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// [start, end) for a "YYYY-MM" month, as the two date strings PostgREST's
// range-overlap filter needs.
function monthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${monthStr}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, end };
}

function stayRangeOverlapFilter(monthStr) {
  const { start, end } = monthRange(monthStr);
  return `ov.${encodeURIComponent(`[${start},${end})`)}`;
}

const ADMIN_SELECT =
  'select=id,type,event_slug,event_title,label,exclusive,start_date,nights,note,created_by,created_at,updated_at,' +
  'accommodation_tent_assignments(tent_id,accommodation_guests(seq,name,age_group,gender))';

// Never embeds accommodation_guests - this is the only place that
// distinction is enforced, so a routing mistake elsewhere can't leak guest
// PII to a public, unauthenticated caller (see accommodation-availability.mts's
// header comment, which relies on this).
const AVAILABILITY_SELECT = 'select=id,type,event_title,label,exclusive,start_date,nights,accommodation_tent_assignments(tent_id)';

// Turns a PostgREST row (snake_case, SQL null for absent optional fields)
// back into the exact JSON shape the client already gets today from Blobs
// (camelCase, absent key rather than null) - the client contract doesn't
// change as part of this migration. `includeGuests` mirrors which select
// list produced the row: false for availability's tent-only embed, so
// `guests` is omitted from each tent entirely rather than emitted as `[]`.
function rowToBooking(row, { includeGuests }) {
  const booking = {
    id: row.id,
    type: row.type,
    startDate: row.start_date,
    nights: row.nights,
    tents: (row.accommodation_tent_assignments ?? []).map((ta) => {
      const tent = { tentId: ta.tent_id };
      if (includeGuests) {
        tent.guests = (ta.accommodation_guests ?? [])
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((g) => ({ name: g.name, ageGroup: g.age_group, gender: g.gender }));
      }
      return tent;
    }),
  };
  if (row.event_slug != null) booking.eventSlug = row.event_slug;
  if (row.event_title != null) booking.eventTitle = row.event_title;
  if (row.label != null) booking.label = row.label;
  if (row.type === 'private-event') booking.exclusive = Boolean(row.exclusive);
  if (row.note != null) booking.note = row.note;
  if (row.created_by != null) booking.createdBy = row.created_by;
  if (row.created_at != null) booking.createdAt = row.created_at;
  if (row.updated_at != null) booking.updatedAt = row.updated_at;
  return booking;
}

export async function listBookingsForAdmin({ month }) {
  const res = await restFetch(`/accommodation_bookings?stay_range=${stayRangeOverlapFilter(month)}&${ADMIN_SELECT}`);
  return (await res.json()).map((row) => rowToBooking(row, { includeGuests: true }));
}

export async function listBookingsForAvailability({ month }) {
  const res = await restFetch(`/accommodation_bookings?stay_range=${stayRangeOverlapFilter(month)}&${AVAILABILITY_SELECT}`);
  return (await res.json()).map((row) => rowToBooking(row, { includeGuests: false }));
}

async function getBookingById(id) {
  const res = await restFetch(`/accommodation_bookings?id=eq.${id}&${ADMIN_SELECT}`);
  const rows = await res.json();
  return rows[0] ? rowToBooking(rows[0], { includeGuests: true }) : null;
}

export async function createBooking({ type, eventSlug, eventTitle, label, exclusive, startDate, nights, tents, note, createdBy }) {
  const created = await callRpc('accommodation_create_booking', {
    p_type: type,
    p_event_slug: eventSlug ?? null,
    p_event_title: eventTitle ?? null,
    p_label: label ?? null,
    p_exclusive: exclusive ?? false,
    p_start_date: startDate,
    p_nights: nights,
    p_note: note ?? null,
    p_created_by: createdBy,
    p_tents: tents ?? [],
  });
  return getBookingById(created.id);
}

export async function updateBooking({ id, type, eventSlug, eventTitle, label, exclusive, startDate, nights, tents, note }) {
  await callRpc('accommodation_update_booking', {
    p_id: id,
    p_type: type,
    p_event_slug: eventSlug ?? null,
    p_event_title: eventTitle ?? null,
    p_label: label ?? null,
    p_exclusive: exclusive ?? false,
    p_start_date: startDate,
    p_nights: nights,
    p_note: note ?? null,
    p_tents: tents ?? [],
  });
  return getBookingById(id);
}

export async function deleteBooking(id) {
  await restFetch(`/accommodation_bookings?id=eq.${id}`, { method: 'DELETE' });
}
