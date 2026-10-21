// Rules for a member booking their own stay in the portal. Pure functions: the endpoint
// (netlify/functions/members-me.mts) supplies the data and does the writing.
//
// A member picks check-in and nights, is told how many fixed and portable tents are free, and says who is
// coming. They do NOT choose tents: the booking goes onto the accommodation calendar as a `member-stay`
// with no tents, and Madhavan allocates them there. Until he does, the people are waiting for a place, and
// those waiting beds are taken off what the next member is told is free.
import { ACCOMMODATION_UNITS, isValidEmail, normalizeMobileNumber } from './accommodation.mjs';

export const MAX_NIGHTS = 30;
export const MAX_AHEAD_DAYS = 400;
export const MAX_PARTY = 22;
const AGE_GROUPS = ['Adult', 'Child'];
const DAY_MS = 86_400_000;

const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayNumber = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
const dayString = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

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
  return dayString(dayNumber(startDate) + nights);
}

// Beds already asked for by member stays that have no tents yet, at the busiest night of this stay.
// `waiting` is [{ startDate, nights, people }].
export function waitingBeds(waiting, startDate, nights) {
  const first = dayNumber(startDate);
  let busiest = 0;
  for (let n = first; n < first + nights; n++) {
    const day = waiting.filter((w) => dayNumber(w.startDate) <= n && n < dayNumber(w.startDate) + w.nights).reduce((sum, w) => sum + w.people, 0);
    busiest = Math.max(busiest, day);
  }
  return busiest;
}

// What the member is told. Only the farm's own tents count (bring-your-own-tent pitches are not offered
// here). Fixed and portable are shown apart, each as how many tents and how many people they sleep.
// `occupiedTentIds` have a booking on any night; `wholeFarmBlocked` is a closure or an exclusive private
// event, which the database does not record per tent; `waiting` is the people already asked for and not yet
// given tents. `maxParty` is the most people one more booking may name.
export function availabilityFor({ occupiedTentIds, wholeFarmBlocked, waiting = 0 }) {
  const taken = new Set(occupiedTentIds);
  const kinds = { fixed: { tents: 0, beds: 0 }, portable: { tents: 0, beds: 0 } };
  for (const u of ACCOMMODATION_UNITS) {
    if (u.kind === 'byot' || wholeFarmBlocked || taken.has(u.id)) continue;
    const k = u.kind === 'fixed' ? kinds.fixed : kinds.portable;
    k.tents += 1;
    k.beds += u.capacity;
  }
  const bedsFree = kinds.fixed.beds + kinds.portable.beds;
  return { fixed: kinds.fixed, portable: kinds.portable, bedsFree, waiting, maxParty: Math.max(0, Math.min(MAX_PARTY, bedsFree - waiting)), wholeFarmBlocked: Boolean(wholeFarmBlocked) };
}

// The request to book. Returns { error } or the people and note to record. Each person is either someone
// on the register (`memberId`, looked up in `family`: the unit's own people and other listed members, id -> name) or typed
// (name and adult or child). Anyone typed is a paying guest, always: a family member who should stay free has
// to be on the register (the core team adds them). Registered people are never charged. `available` is what availabilityFor said is free, checked again here.
export function validateStayRequest(body, today, family = new Map(), available = MAX_PARTY) {
  const dateError = validateStayDates({ startDate: body?.startDate, nights: body?.nights }, today);
  if (dateError) return { error: dateError };
  const people = Array.isArray(body.people) ? body.people : [];
  if (people.length === 0) return { error: 'Say who is coming.' };
  if (people.length > MAX_PARTY) return { error: `At most ${MAX_PARTY} people in one booking.` };
  const names = new Set();
  const usedMembers = new Set();
  const party = [];
  let guestCount = 0;
  for (const p of people) {
    let entry;
    if (p?.memberId !== undefined) {
      const known = family.get(p.memberId);
      if (!known) return { error: 'One of the members you named is not available to book for.' };
      if (usedMembers.has(p.memberId)) return { error: `${known.name} is listed twice.` };
      usedMembers.add(p.memberId);
      entry = { name: known.name.trim(), ageGroup: 'Adult', guest: false, memberId: p.memberId };
      // The register's own number and email, so notices reach them without anyone typing them again.
      const phone = known.phone ? normalizeMobileNumber(known.phone) : null;
      if (phone) entry.mobileNumber = phone;
      if (known.email && isValidEmail(known.email)) entry.email = known.email.trim();
    } else {
      const name = typeof p?.name === 'string' ? p.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 80) return { error: 'Each person needs a name.' };
      if (!AGE_GROUPS.includes(p.ageGroup)) return { error: `Say whether ${name} is an adult or a child.` };
      entry = { name, ageGroup: p.ageGroup, guest: true }; // not on the register: a paying guest, always
      // How to reach them with their stay notices. Optional for a child (a parent's details cover them),
      // but an adult needs at least a mobile number or an email.
      const mobile = typeof p.mobileNumber === 'string' ? p.mobileNumber.trim() : '';
      if (mobile) {
        const normalized = normalizeMobileNumber(mobile);
        if (!normalized) return { error: `"${mobile}" is not a valid mobile number. Use 10 digits, or include a country code.` };
        entry.mobileNumber = normalized;
      }
      const email = typeof p.email === 'string' ? p.email.trim() : '';
      if (email) {
        if (!isValidEmail(email)) return { error: `"${email}" is not a valid email address.` };
        entry.email = email;
      }
      if (entry.ageGroup === 'Adult' && !entry.mobileNumber && !entry.email) return { error: `Add a mobile number or an email for ${name}, so we can send them their stay details.` };
    }
    const key = entry.name.toLowerCase();
    if (names.has(key)) return { error: `${entry.name} is listed twice. Add a surname or initial to tell two people apart.` };
    names.add(key);
    if (entry.guest) guestCount += 1;
    party.push(entry);
  }
  if (available <= 0) return { error: 'There is no room on those dates.' };
  if (party.length > available) return { error: `Only ${available} ${available === 1 ? 'place is' : 'places are'} free on those dates, and you named ${party.length}. Choose other dates or fewer people.` };
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  return { startDate: body.startDate, nights: body.nights, party, guestCount, note };
}

// The line Madhavan reads on the calendar card: who is coming, children and paying guests marked, and the
// member's own note. No phone numbers or emails in the text itself: they are saved in the guest directory.
export function partyNote(party, note) {
  const reachable = party.some((p) => p.mobileNumber || p.email);
  const who = party.map((p) => `${p.name}${p.ageGroup === 'Child' ? ' (child)' : ''}${p.guest ? ' (paying guest)' : ''}`).join(', ');
  return `Needs tents. Party of ${party.length}: ${who}.${reachable ? ' Their mobile numbers and emails are in the guest directory: search by name when you add them to a tent.' : ''}${note ? ` Note: ${note}` : ''}`;
}

// Can this stay still be cancelled by the member? Only before check-in; after that the core team handles it.
export function canCancelStay(startDate, today) {
  return dayNumber(startDate) > dayNumber(today);
}
