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
// Auth follows the exact pattern photo-pool.mts/whatsapp-admin.mts already
// established: Google Sign-In client-side, this Function verifies the ID
// token itself (google-id-token.mjs) against a live allow-list. Unlike those
// two, this uses its OWN Sheet/env var (ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID)
// rather than reusing PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID - Madhavan isn't
// "core team" in the sense that list means, and shouldn't gain photo/WhatsApp
// access as a side effect of getting calendar access (or vice versa).
import { getStore } from '@netlify/blobs';
import { getAllowedEmails } from '../../scripts/lib/google-drive.mjs';
import { verifyGoogleIdToken } from '../../scripts/lib/google-id-token.mjs';
import { ACCOMMODATION_UNITS, nightsForBooking, bookingTouchesMonth } from '../../scripts/lib/accommodation.mjs';

type BookingType = 'public-event' | 'private-event' | 'casual-stay' | 'member-stay' | 'unit-closure' | 'farm-closure';

interface Guest {
  name?: string;
  ageGroup?: 'Adult' | 'Child';
  gender?: string;
}

interface TentAssignment {
  tentId: string;
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

type AuthResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 500; error: string };

const ALLOWED_EMAILS_TTL_MS = 2 * 60 * 1000;
let cachedAllowedEmails: { emails: string[]; expiresAt: number } | null = null;

async function getCachedAllowedEmails(): Promise<string[]> {
  if (cachedAllowedEmails && cachedAllowedEmails.expiresAt > Date.now()) {
    return cachedAllowedEmails.emails;
  }
  const sheetId = process.env.ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID;
  if (!sheetId) throw new Error('Missing ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID');
  const emails = await getAllowedEmails(sheetId);
  cachedAllowedEmails = { emails, expiresAt: Date.now() + ALLOWED_EMAILS_TTL_MS };
  return emails;
}

async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Sign-in required' };

  const clientId = process.env.PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('Missing PUBLIC_GOOGLE_CLIENT_ID');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  let email: string;
  try {
    const payload = await verifyGoogleIdToken(token, { audience: clientId });
    email = String(payload.email).toLowerCase();
  } catch (err) {
    console.error('ID token verification failed', err);
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  try {
    const allowed = await getCachedAllowedEmails();
    if (!allowed.includes(email)) {
      return { ok: false, status: 403, error: 'This Google account is not authorized to manage the accommodation calendar' };
    }
  } catch (err) {
    console.error('Failed to check the accommodation-calendar allow-list', err);
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  return { ok: true, email };
}

function store() {
  return getStore('accommodation-bookings');
}

// Plain full-scan-then-filter, no secondary date index - list() with no
// `paginate: true` already returns every blob in one Promise<ListResult>
// (@netlify/blobs handles pagination internally), so this is a single round
// trip plus one get() per booking. Same "fine at this scale, revisit if it
// grows" reasoning event-interest.mts already applies to its own read
// pattern - this farm will have, at most, low hundreds of bookings a year.
async function listAllBookings(): Promise<Booking[]> {
  const s = store();
  const { blobs } = await s.list();
  const bookings = await Promise.all(blobs.map(({ key }) => s.get(key, { type: 'json' }) as Promise<Booking | null>));
  return bookings.filter((b): b is Booking => b !== null);
}

const VALID_TYPES: BookingType[] = ['public-event', 'private-event', 'casual-stay', 'member-stay', 'unit-closure', 'farm-closure'];
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
    }
  }
  if (input.type === 'public-event' && !input.eventSlug) return 'eventSlug is required for type "public-event"';
  return null;
}

// "A tent isn't shared across two different parties" (see the design
// conversation) - reject a create/update whose tent(s) overlap, on any
// shared night, with another booking's tent(s). farm-closure bookings have
// no tents, so they never trip this - farm-wide closures are enforced
// separately by the public availability calculation, not by this guard.
function findConflict(candidate: Booking, existing: Booking[]): Booking | null {
  if (candidate.tents.length === 0) return null;
  const candidateNights = new Set(nightsForBooking(candidate));
  const candidateTentIds = new Set(candidate.tents.map((t) => t.tentId));
  for (const other of existing) {
    if (other.id === candidate.id || other.tents.length === 0) continue;
    const sharesTent = other.tents.some((t) => candidateTentIds.has(t.tentId));
    if (!sharesTent) continue;
    const sharesNight = nightsForBooking(other).some((n) => candidateNights.has(n));
    if (sharesNight) return other;
  }
  return null;
}

async function handleList(url: URL): Promise<Response> {
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ error: 'month is required, as YYYY-MM' }, 400);

  const all = await listAllBookings();
  const bookings = all.filter((b) => bookingTouchesMonth(b, month));
  return jsonResponse({ units: ACCOMMODATION_UNITS, bookings });
}

async function handleCreate(req: Request, email: string): Promise<Response> {
  let payload: Partial<Booking>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const validationError = validateBookingInput(payload);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  const now = new Date().toISOString();
  const booking: Booking = {
    id: crypto.randomUUID(),
    type: payload.type!,
    eventSlug: payload.eventSlug,
    eventTitle: payload.eventTitle,
    label: payload.label,
    exclusive: payload.type === 'private-event' ? Boolean(payload.exclusive) : undefined,
    startDate: payload.startDate!,
    nights: payload.nights!,
    tents: payload.tents ?? [],
    note: payload.note,
    createdBy: email,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const existing = await listAllBookings();
    const conflict = findConflict(booking, existing);
    if (conflict) {
      return jsonResponse({ error: `Conflicts with an existing booking (${conflict.label ?? conflict.eventTitle ?? conflict.type}) on a shared tent/night` }, 409);
    }
    await store().setJSON(booking.id, booking);
    return jsonResponse({ booking });
  } catch (err) {
    console.error('Failed to create booking', err);
    return jsonResponse({ error: 'Failed to save the booking' }, 500);
  }
}

async function handleUpdate(req: Request): Promise<Response> {
  let payload: Partial<Booking> & { id?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!payload.id) return jsonResponse({ error: 'id is required' }, 400);
  const validationError = validateBookingInput(payload);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  try {
    const s = store();
    const existingBooking = (await s.get(payload.id, { type: 'json' })) as Booking | null;
    if (!existingBooking) return jsonResponse({ error: 'Booking not found' }, 404);

    const updated: Booking = {
      ...existingBooking,
      type: payload.type!,
      eventSlug: payload.eventSlug,
      eventTitle: payload.eventTitle,
      label: payload.label,
      exclusive: payload.type === 'private-event' ? Boolean(payload.exclusive) : undefined,
      startDate: payload.startDate!,
      nights: payload.nights!,
      tents: payload.tents ?? [],
      note: payload.note,
      updatedAt: new Date().toISOString(),
    };

    const all = await listAllBookings();
    const conflict = findConflict(updated, all);
    if (conflict) {
      return jsonResponse({ error: `Conflicts with an existing booking (${conflict.label ?? conflict.eventTitle ?? conflict.type}) on a shared tent/night` }, 409);
    }

    await s.setJSON(updated.id, updated);
    return jsonResponse({ booking: updated });
  } catch (err) {
    console.error('Failed to update booking', err);
    return jsonResponse({ error: 'Failed to save the booking' }, 500);
  }
}

async function handleDelete(req: Request): Promise<Response> {
  let payload: { id?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!payload.id) return jsonResponse({ error: 'id is required' }, 400);

  try {
    await store().delete(payload.id);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to delete booking', err);
    return jsonResponse({ error: 'Failed to delete the booking' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(req.url);

  if (url.pathname === '/api/accommodation-admin/bookings' && req.method === 'GET') return handleList(url);
  if (url.pathname === '/api/accommodation-admin/bookings' && req.method === 'POST') return handleCreate(req, auth.email);
  if (url.pathname === '/api/accommodation-admin/bookings/update' && req.method === 'POST') return handleUpdate(req);
  if (url.pathname === '/api/accommodation-admin/bookings/delete' && req.method === 'POST') return handleDelete(req);

  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/accommodation-admin/bookings', '/api/accommodation-admin/bookings/update', '/api/accommodation-admin/bookings/delete'],
};
