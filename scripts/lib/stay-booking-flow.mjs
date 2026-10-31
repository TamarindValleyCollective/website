// The rules behind the "New booking" flow on the Stays page (src/components/stays/NewBookingFlow.astro): which tents are
// free for a stay, whether each step is complete, and the exact payload the booking API takes. Pure and tested, so the
// screen only has to draw it. The server (netlify/functions/accommodation-admin.mts, validateBookingInput and the
// database's conflict checks) stays the authority; these rules exist so a person finds out at the step, not after Save.
import { checkOutDate } from './stay-notice.mjs';

export const AGE_GROUPS = ['Adult', 'Child'];
export const GENDERS = ['Male', 'Female', 'NA'];

/** The date strings of every night of a stay (the check-out day is not a night). */
export function nightsOf(startDate, nights) {
  const [y, m, d] = startDate.split('-').map(Number);
  return Array.from({ length: nights }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

/** Nights between two dates (check-in, check-out); 0 when the order is wrong. */
export function nightsBetween(checkIn, checkOut) {
  const diff = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
  return diff > 0 ? diff : 0;
}

export { checkOutDate };

/** A unit staff can put a booking in: not run by a member, not offboarded. */
export const bookableUnits = (units) => units.filter((u) => u.manager !== 'member' && u.status !== 'offboarded');

/**
 * The booking type the flow's answers amount to.
 * @param {{ kind: 'guests' | 'event' | 'block' | null, memberStay?: boolean, eventMode?: 'public' | 'private', wholeFarm?: boolean }} s
 */
export function bookingType(s) {
  if (s.kind === 'guests') return s.memberStay ? 'member-stay' : 'casual-stay';
  if (s.kind === 'event') return s.eventMode === 'public' ? 'public-event' : 'private-event';
  if (s.kind === 'block') return s.wholeFarm ? 'farm-closure' : 'unit-closure';
  return null;
}

/**
 * Which of the three starting choices a role may use, from the booking types it may write (null = every type).
 * @param {string[] | null} allowedTypes
 */
export function allowedKinds(allowedTypes) {
  const ok = (t) => !allowedTypes || allowedTypes.includes(t);
  return {
    guests: ok('casual-stay') || ok('member-stay'),
    memberStay: ok('member-stay'),
    casualStay: ok('casual-stay'),
    event: ok('public-event') || ok('private-event'),
    publicEvent: ok('public-event'),
    privateEvent: ok('private-event'),
    block: ok('unit-closure') || ok('farm-closure'),
  };
}

/**
 * Per unit: null when it is free for the stay, otherwise why not. A unit is taken when any other booking (including a
 * tent closure) holds it on one of the nights; a whole-farm closure shuts every unit that does not ignore it.
 * @param {{ units: any[], bookings: any[], startDate: string, nights: number }} input
 * @returns {Map<string, null | { reason: 'booked' | 'closed', by: string | null }>}
 */
export function unitAvailability({ units, bookings, startDate, nights }) {
  const wanted = new Set(nightsOf(startDate, nights));
  const overlaps = (b) => nightsOf(b.startDate, b.nights).some((n) => wanted.has(n));
  const closure = bookings.find((b) => b.type === 'farm-closure' && overlaps(b));
  return new Map(
    units.map((u) => {
      const held = bookings.find((b) => b.type !== 'farm-closure' && b.tents.some((t) => t.tentId === u.id) && overlaps(b));
      if (held) return [u.id, { reason: 'booked', by: held.label ?? held.eventTitle ?? null }];
      if (closure && !u.ignoresFarmClosure) return [u.id, { reason: 'closed', by: closure.note ?? null }];
      return [u.id, null];
    }),
  );
}

const unitById = (units, id) => units.find((u) => u.id === id);
const guestsIn = (state, tentId) => state.guests.filter((g) => g.tentId === tentId && (g.name?.trim() || g.mobileNumber?.trim() || g.personId));

/**
 * What is missing for a step, or null when it is complete. Mirrors the server's rules (guest name, age group, gender, a
 * mobile number for a new guest, a tent's capacity, the family/solo rule) so they show up before Save.
 * @param {any} state the flow's answers
 * @param {1 | 2 | 3 | 4} step
 * @param {{ units: any[], today: string, allowedTypes?: string[] | null }} ctx
 * @returns {string | null}
 */
export function stepProblem(state, step, ctx) {
  const type = bookingType(state);
  if (step === 1) {
    if (!state.kind) return 'Choose what this is.';
    if (state.kind === 'event' && !state.eventMode) return 'Choose a public event or a private one.';
    if (state.kind === 'guests' && state.memberStay && !state.member) return 'Choose which member is staying.';
    const kinds = allowedKinds(ctx.allowedTypes ?? null);
    if (type === 'casual-stay' && !kinds.casualStay) return 'You are not allowed to add guest stays.';
    return null;
  }
  if (step === 2) {
    if (!state.startDate) return 'Choose the check-in day.';
    if (!(state.nights >= 1)) return 'Choose the check-out day, after check-in.';
    if (state.startDate < ctx.today) return 'A new booking cannot start in the past.';
    return null;
  }
  if (step === 3) {
    if (state.kind === 'block' && state.wholeFarm) return null;
    if (state.kind === 'event' && state.exclusive) return null;
    return state.tentIds.length ? null : state.kind === 'block' ? 'Choose the tent to close, or the whole farm.' : 'Choose at least one tent.';
  }
  if (step === 4) {
    if (state.kind === 'block') return (state.reason ?? '').trim().length >= 3 ? null : 'Say why it is closed.';
    for (const tentId of state.tentIds) {
      const unit = unitById(ctx.units, tentId);
      if (unit && guestsIn(state, tentId).length > unit.capacity) return `${unit.label} holds at most ${unit.capacity}.`;
    }
    const listed = state.guests.filter((g) => g.name?.trim() || g.mobileNumber?.trim() || g.personId);
    if (state.kind === 'guests' && listed.length === 0) return 'Add at least the lead guest.';
    for (const g of listed) {
      if (!g.name?.trim()) return 'Every guest needs a name.';
      if (!g.personId && !g.mobileNumber?.trim()) return `${g.name.trim()} needs a mobile number.`;
      if (!state.tentIds.includes(g.tentId)) return `${g.name.trim()} is not in one of the chosen tents.`;
    }
    if (state.family) {
      for (const tentId of state.tentIds) {
        const unit = unitById(ctx.units, tentId);
        if (unit?.kind === 'byot') return `${unit.label} is a Bring Your Own Tent slot, so a family booking does not apply.`;
        if (guestsIn(state, tentId).length > 1) return 'A family booking lists one guest per tent. Remove the extra guests or turn it off.';
      }
    }
    return null;
  }
  return null;
}

/** The API's save payload (POST /api/accommodation-admin/bookings) for a complete flow. */
export function buildPayload(state, units) {
  const type = bookingType(state);
  const clean = (v) => (v?.trim ? v.trim() || undefined : v || undefined);
  const payload = { type, startDate: state.startDate, nights: state.nights, tents: [] };

  if (type === 'farm-closure') {
    payload.label = clean(state.reason);
    payload.note = clean(state.reason);
    return payload;
  }
  if (type === 'unit-closure') {
    payload.label = clean(state.reason);
    payload.tents = state.tentIds.map((tentId) => ({ tentId, solo: false, guests: [] }));
    payload.note = clean(state.note);
    return payload;
  }

  payload.tents = state.tentIds.map((tentId) => {
    const guests = guestsIn(state, tentId).map((g) => ({
      personId: g.personId || undefined,
      name: g.name.trim(),
      ageGroup: g.ageGroup || 'Adult',
      gender: g.gender || 'NA',
      mobileNumber: clean(g.mobileNumber),
      email: clean(g.email),
      preferences: clean(g.preferences),
    }));
    const unit = unitById(units, tentId);
    return { tentId, solo: Boolean(state.family) && guests.length <= 1 && unit?.kind !== 'byot', guests };
  });
  payload.note = clean(state.note);
  if (type === 'member-stay') payload.label = state.member || undefined;
  if (type === 'public-event') {
    payload.eventSlug = state.eventSlug;
    payload.eventTitle = state.eventTitle;
  }
  if (type === 'private-event') {
    payload.label = clean(state.label);
    payload.exclusive = Boolean(state.exclusive);
  }
  return payload;
}
