// Data-access layer for the accommodation_* tables (see
// supabase/migrations/0005_accommodation_bookings.sql,
// 0007_accommodation_guest_directory.sql,
// 0008_accommodation_audit_and_justification.sql) in the "TVC ERP" Supabase
// project. Mirrors supabase.mjs's hand-rolled PostgREST style (no
// @supabase/supabase-js) and reuses its restHeaders for the same
// service_role auth. Used exclusively by
// netlify/functions/accommodation-admin.mts (full read/write, guest data
// included) — the public, guest-free availability view this once also
// backed was dropped rather than shipped to production alongside the admin
// tool (2026-08-30); a future public view is a separate, not-yet-designed
// piece of work.
//
// Conflict-checking (no shared tent on a shared night) is enforced in
// Postgres itself, not here: accommodation_create_booking/
// accommodation_update_booking (rpc/ functions) do the multi-table write
// inside one transaction and rely on accommodation_tent_assignments' EXCLUDE
// constraint to make an overlapping insert physically impossible, even
// under concurrent requests — the race that let two identical bookings land
// 38s apart under Netlify Blobs' eventual consistency. A conflict surfaces
// here as a thrown Error with `.status` 409 (404 for an update/delete
// against a deleted/nonexistent id, 422 for editing/deleting a past booking
// with no reason) — read directly off the RPC's HTTP response, since
// PostgREST maps the functions' `RAISE EXCEPTION ... USING ERRCODE = 'PT409'`
// (etc.) straight to that status code.
//
// Guest identity (accommodation_people) and the full create/update/delete
// audit trail (accommodation_booking_audit_log) are both enforced inside
// the same rpc/ functions - accommodation_replace_tents resolves each guest
// to a person row (by explicit personId, else by mobile number + name
// together, else a new person), and a set of table triggers on
// accommodation_bookings write the audit row no matter which of these
// functions the write came through. Nothing here needs to know about
// either mechanism directly.
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

// Today's date (YYYY-MM-DD) in the farm's own timezone - mirrors the
// `(now() at time zone 'Asia/Kolkata')::date` the "is this booking past"
// check uses on the DB side (accommodation_update_booking/
// accommodation_delete_booking), so isPast here can never disagree with
// what the RPC actually enforces.
function todayInIst() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function isPastBooking(startDate, nights) {
  const [y, m, d] = startDate.split('-').map(Number);
  const lastNight = new Date(Date.UTC(y, m - 1, d + nights - 1));
  return lastNight.toISOString().slice(0, 10) < todayInIst();
}

const ADMIN_SELECT =
  'select=id,type,event_slug,event_title,label,exclusive,start_date,nights,note,created_by,created_at,updated_by,updated_at,' +
  'accommodation_tent_assignments(tent_id,accommodation_guests(seq,age_group,person_id,accommodation_people(name,mobile_number,gender,preferences)))';

// Turns a PostgREST row (snake_case, SQL null for absent optional fields)
// back into the exact JSON shape the client already gets today (camelCase,
// absent key rather than null).
function rowToBooking(row) {
  const booking = {
    id: row.id,
    type: row.type,
    startDate: row.start_date,
    nights: row.nights,
    isPast: isPastBooking(row.start_date, row.nights),
    tents: (row.accommodation_tent_assignments ?? []).map((ta) => ({
      tentId: ta.tent_id,
      guests: (ta.accommodation_guests ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((g) => ({
          personId: g.person_id,
          name: g.accommodation_people.name,
          mobileNumber: g.accommodation_people.mobile_number ?? undefined,
          gender: g.accommodation_people.gender ?? undefined,
          preferences: g.accommodation_people.preferences ?? undefined,
          ageGroup: g.age_group,
        })),
    })),
  };
  if (row.event_slug != null) booking.eventSlug = row.event_slug;
  if (row.event_title != null) booking.eventTitle = row.event_title;
  if (row.label != null) booking.label = row.label;
  if (row.type === 'private-event') booking.exclusive = Boolean(row.exclusive);
  if (row.note != null) booking.note = row.note;
  if (row.created_by != null) booking.createdBy = row.created_by;
  if (row.created_at != null) booking.createdAt = row.created_at;
  if (row.updated_by != null) booking.updatedBy = row.updated_by;
  if (row.updated_at != null) booking.updatedAt = row.updated_at;
  return booking;
}

export async function listBookingsForAdmin({ month }) {
  const res = await restFetch(`/accommodation_bookings?stay_range=${stayRangeOverlapFilter(month)}&${ADMIN_SELECT}`);
  return (await res.json()).map(rowToBooking);
}

async function getBookingById(id) {
  const res = await restFetch(`/accommodation_bookings?id=eq.${id}&${ADMIN_SELECT}`);
  const rows = await res.json();
  return rows[0] ? rowToBooking(rows[0]) : null;
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

export async function updateBooking({ id, type, eventSlug, eventTitle, label, exclusive, startDate, nights, tents, note, updatedBy, reason }) {
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
    p_updated_by: updatedBy,
    p_reason: reason || null,
  });
  return getBookingById(id);
}

export async function deleteBooking(id, { deletedBy, reason }) {
  await callRpc('accommodation_delete_booking', { p_id: id, p_deleted_by: deletedBy, p_reason: reason || null });
}

const PERSON_FIELDS = 'id,name,mobile_number,gender,preferences';

// Mobile number takes priority when both are given - it's the reliable
// identity signal (see accommodation_resolve_person's own matching order,
// which additionally requires name to agree too - see 0011's migration
// comment on why mobile_number alone isn't a safe auto-match key, e.g. a
// couple sharing one number). Name search deliberately returns candidates
// for a human to pick from rather than resolving to one - see this file's
// header comment and the "never silently merge on name" decision behind
// accommodation_resolve_person.
export async function searchGuests({ query, mobileNumber }) {
  const path = mobileNumber
    ? `/accommodation_people?mobile_number=eq.${encodeURIComponent(mobileNumber)}&select=${PERSON_FIELDS}`
    : `/accommodation_people?name=ilike.*${encodeURIComponent(query ?? '')}*&select=${PERSON_FIELDS}&order=name.asc&limit=10`;
  const res = await restFetch(path);
  const rows = await res.json();
  return rows.map((p) => ({ id: p.id, name: p.name, mobileNumber: p.mobile_number ?? undefined, gender: p.gender ?? undefined, preferences: p.preferences ?? undefined }));
}

export async function listStaysForPerson(personId) {
  const personRes = await restFetch(`/accommodation_people?id=eq.${personId}&select=${PERSON_FIELDS}`);
  const [person] = await personRes.json();
  if (!person) return null;

  const staysRes = await restFetch(
    `/accommodation_guests?person_id=eq.${personId}&select=age_group,` +
      'accommodation_tent_assignments(tent_id,accommodation_bookings(id,start_date,nights,type,label,event_title))',
  );
  const rows = await staysRes.json();
  const stays = rows
    .map((g) => {
      const ta = g.accommodation_tent_assignments;
      const b = ta.accommodation_bookings;
      return {
        bookingId: b.id,
        startDate: b.start_date,
        nights: b.nights,
        tentId: ta.tent_id,
        type: b.type,
        label: b.label ?? undefined,
        eventTitle: b.event_title ?? undefined,
        ageGroupAtStay: g.age_group,
      };
    })
    .sort((a, b) => b.startDate.localeCompare(a.startDate));

  return {
    person: { id: person.id, name: person.name, mobileNumber: person.mobile_number ?? undefined, gender: person.gender ?? undefined, preferences: person.preferences ?? undefined },
    stays,
  };
}
