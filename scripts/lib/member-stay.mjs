// Rules for a member booking their own stay in the portal. Pure functions: the endpoint
// (netlify/functions/members-me.mts) supplies the data and does the writing.
//
// A member picks check-in, nights, then the tents still free for those nights, and names
// who sleeps in each. The booking is an ordinary `member-stay` in the accommodation
// calendar; Madhavan can still move people between tents afterwards.
import { ACCOMMODATION_UNITS, normalizeMobileNumber } from './accommodation.mjs';

export const MAX_NIGHTS = 30;
export const MAX_AHEAD_DAYS = 400;
const AGE_GROUPS = ['Adult', 'Child'];
const GENDERS = ['Male', 'Female', 'NA'];
const DAY_MS = 86_400_000;

const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayNumber = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS);

// Dates and nights, as the member typed them. `today` is the farm's own date (IST).
export function validateStayDates({ startDate, nights }, today) {
  if (!ymd(startDate)) return 'Choose a check-in date.';
  if (!Number.isInteger(nights) || nights < 1) return 'Choose how many nights.';
  if (nights > MAX_NIGHTS) return `A booking here can be at most ${MAX_NIGHTS} nights. For a longer stay, contact the core team.`;
  if (dayNumber(startDate) < dayNumber(today)) return 'Check-in cannot be in the past.';
  if (dayNumber(startDate) - dayNumber(today) > MAX_AHEAD_DAYS) return 'That date is too far ahead to book yet.';
  return null;
}

export function checkOut(startDate, nights) {
  return new Date((dayNumber(startDate) + nights) * DAY_MS).toISOString().slice(0, 10);
}

// What is free, grouped the way the farm talks about its tents. `occupiedTentIds` are tents with a
// booking on any of the nights; `wholeFarmBlocked` is a closure or an exclusive private event, which
// the database does not record per tent. Bring-your-own-tent pitches are counted separately: they hold
// a family's own tent, so they are pitches, not beds the farm provides.
export function availabilityFor({ occupiedTentIds, wholeFarmBlocked }) {
  const taken = new Set(occupiedTentIds);
  const groups = new Map();
  let tentsFree = 0;
  let bedsFree = 0;
  let pitchesFree = 0;
  for (const u of ACCOMMODATION_UNITS) {
    const free = !wholeFarmBlocked && !taken.has(u.id);
    if (!groups.has(u.group)) groups.set(u.group, { group: u.group, byot: u.kind === 'byot', units: [] });
    groups.get(u.group).units.push({ id: u.id, label: u.label, shortLabel: u.shortLabel, capacity: u.capacity, kind: u.kind, free });
    if (!free) continue;
    if (u.kind === 'byot') pitchesFree += 1;
    else {
      tentsFree += 1;
      bedsFree += u.capacity;
    }
  }
  return { tentsFree, bedsFree, pitchesFree, wholeFarmBlocked: Boolean(wholeFarmBlocked), groups: [...groups.values()] };
}

// The request to book. Returns { error } or the booking shaped for accommodation_create_booking.
// Every chosen tent needs at least one person and no more than it holds; a person needs a name, an age
// group and a gender. A mobile number is optional (children, and family who have none), but must be valid
// if given. `guest` marks a paying guest (not family) for the pricing step.
// A person already on the register is sent as `memberId` instead of typed details: `family` maps the ids of
// the unit's registered people to { name, phone, email } read server-side, and they go in as an adult (the
// register holds no age or gender) with the number and email we already have, never typed again.
export function validateStayRequest(body, today, family = new Map()) {
  const dateError = validateStayDates({ startDate: body?.startDate, nights: body?.nights }, today);
  if (dateError) return { error: dateError };
  if (!Array.isArray(body.tents) || body.tents.length === 0) return { error: 'Choose at least one tent.' };
  const seen = new Set();
  const units = new Map(ACCOMMODATION_UNITS.map((u) => [u.id, u]));
  const tents = [];
  const names = new Set();
  const usedMembers = new Set();
  let guestCount = 0;
  for (const t of body.tents) {
    const unit = units.get(t?.tentId);
    if (!unit) return { error: 'One of the tents is not one we have.' };
    if (seen.has(unit.id)) return { error: `${unit.label} was chosen twice.` };
    seen.add(unit.id);
    const people = Array.isArray(t.guests) ? t.guests : [];
    if (people.length === 0) return { error: `Say who is staying in ${unit.label}.` };
    if (people.length > unit.capacity) return { error: `${unit.label} holds at most ${unit.capacity}.` };
    const guests = [];
    for (const p of people) {
      if (p?.memberId !== undefined) {
        const known = family.get(p.memberId);
        if (!known) return { error: 'One of the family members is not in your unit.' };
        if (usedMembers.has(p.memberId)) return { error: `${known.name} is listed twice.` };
        usedMembers.add(p.memberId);
        names.add(known.name.trim().toLowerCase());
        const guest = { name: known.name.trim(), ageGroup: 'Adult', gender: 'NA' };
        const phone = known.phone ? normalizeMobileNumber(known.phone) : null;
        if (phone) guest.mobileNumber = phone;
        if (known.email) guest.email = known.email;
        guests.push(guest);
        continue;
      }
      const name = typeof p?.name === 'string' ? p.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 80) return { error: 'Each person needs a name.' };
      if (!AGE_GROUPS.includes(p.ageGroup)) return { error: `Say whether ${name} is an adult or a child.` };
      if (!GENDERS.includes(p.gender)) return { error: `Choose a gender for ${name}, or "Prefer not to say".` };
      const key = name.toLowerCase();
      if (names.has(key)) return { error: `${name} is listed twice. Add a surname or initial to tell two people apart.` };
      names.add(key);
      const guest = { name, ageGroup: p.ageGroup, gender: p.gender };
      const mobile = typeof p.mobileNumber === 'string' ? p.mobileNumber.trim() : '';
      if (mobile) {
        const normalized = normalizeMobileNumber(mobile);
        if (!normalized) return { error: `"${mobile}" is not a valid mobile number. Use 10 digits, or include a country code.` };
        guest.mobileNumber = normalized;
      }
      if (p.guest === true) guestCount += 1;
      guests.push(guest);
    }
    tents.push({ tentId: unit.id, guests });
  }
  return { tents, guestCount, startDate: body.startDate, nights: body.nights };
}

// Can this stay still be cancelled by the member? Only before check-in; after that the core team handles it.
export function canCancelStay(startDate, today) {
  return dayNumber(startDate) > dayNumber(today);
}
