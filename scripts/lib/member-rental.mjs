// The member's side of renting out a unit (the "My rental" page in the member portal): what they may send when they
// offer a unit, change on it, or block dates, what the portal is shown, and what Linger is told. Pure, so it is tested
// directly (member-rental.test.mjs); netlify/functions/members-rental.mts does the reading and writing.
// Plan: docs/plans/accommodation-member-units.md. The admin side of the same unit is member-units.mjs.
import { offerProblem, REQUEST_MODES, WHOLE_TYPES } from './member-units.mjs';

export const MAX_BLOCK_NIGHTS = 90;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const utc = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};
const isRealDate = (d) => typeof d === 'string' && DATE.test(d) && new Date(utc(d)).toISOString().slice(0, 10) === d;

// What a member sends to offer a unit: whole or a room, the size of a whole unit, and whether they want TVC to manage it.
export function validateOffer(body) {
  if (!body || typeof body !== 'object') return { error: 'Choose whether you are offering the whole unit or a single room.' };
  const shape = body.shape;
  const delegateToTvc = body.delegateToTvc === true;
  const typeId = shape === 'room' ? '1br' : body.size;
  const problem = offerProblem({ shape, typeId, delegateToTvc: shape === 'room' ? delegateToTvc : delegateToTvc });
  if (problem) return { error: problem };
  if (shape === 'whole' && !WHOLE_TYPES.includes(typeId)) return { error: 'Choose the size of the unit: 1, 2 or 3 BHK.' };
  return { offer: { shape, typeId, delegateToTvc: shape === 'whole' && delegateToTvc } };
}

// What a member may change on their unit once it is enabled. How requests are answered is theirs only when they manage
// the unit; when TVC manages it (a whole unit they delegated) Madhavan answers, so the mode is not theirs to set.
// Whether a whole-farm closure applies to the unit is theirs either way.
export function validateSettings(body, unit) {
  if (!unit) return { error: 'You have no unit that is rentable yet.' };
  if (unit.status === 'offboarded') return { error: 'This unit is no longer offered.' };
  const patch = {};
  if (body?.requestMode !== undefined) {
    if (!REQUEST_MODES.includes(body.requestMode)) return { error: 'Choose auto-reject, ask me each time, or auto-accept.' };
    if (unit.manager !== 'member') return { error: 'TVC answers requests for your unit, so there is nothing to set.' };
    patch.request_mode = body.requestMode;
  }
  if (body?.ignoresFarmClosure !== undefined) {
    if (typeof body.ignoresFarmClosure !== 'boolean') return { error: 'Say whether your unit stays open when the farm is closed.' };
    patch.ignores_farm_closure = body.ignoresFarmClosure;
  }
  if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
  return { patch };
}

// Dates to mark unavailable: first and last night, today or later, at most MAX_BLOCK_NIGHTS in all.
export function validateBlock(body, today) {
  const from = body?.from;
  const to = body?.to;
  if (!isRealDate(from) || !isRealDate(to)) return { error: 'Choose the first and the last night.' };
  if (from < today) return { error: 'You can only block nights from today on.' };
  if (to < from) return { error: 'The last night cannot be before the first.' };
  const nights = (utc(to) - utc(from)) / DAY_MS + 1;
  if (nights > MAX_BLOCK_NIGHTS) return { error: `You can block at most ${MAX_BLOCK_NIGHTS} nights at a time.` };
  return { from, nights };
}

// A member may take back a block they made themselves, and only one that has not ended: it is a `unit-closure` booking
// on their unit alone, recorded as made by a member. TVC's own closures (a repair) are not theirs to remove.
export function canRemoveBlock(booking, unitId, today) {
  if (!booking || booking.type !== 'unit-closure') return false;
  if (!String(booking.createdBy ?? '').startsWith('member:')) return false;
  const tents = booking.tents ?? [];
  if (tents.length !== 1 || tents[0].tentId !== unitId) return false;
  const end = new Date(utc(booking.startDate) + booking.nights * DAY_MS).toISOString().slice(0, 10);
  return end > today;
}

// Where the member's rental stands: not offered, waiting for the contract, rentable, paused or no longer offered.
export function rentalState({ offer, unit }) {
  if (unit && unit.status === 'rentable') return 'rentable';
  if (unit && unit.status === 'paused') return 'paused';
  if (offer && offer.status === 'interested') return 'interested';
  return 'none';
}

const GUEST = (g) => ({ name: g.name, ageGroup: g.ageGroup, gender: g.gender, preferences: g.preferences ?? '' });

// Bookings on the member's unit as the portal shows them. A stay shows each guest's name, age group, gender and
// preferences, never a phone number or an email. A block shows its dates and whether it is theirs to remove; a block
// TVC made says only that the unit is unavailable, not why.
export function shapeUnitBookings(bookings, unitId, today) {
  const stays = [];
  const blocks = [];
  for (const b of bookings) {
    const tents = b.tents ?? [];
    if (b.type === 'unit-closure' || b.type === 'farm-closure') {
      blocks.push({ id: b.id, startDate: b.startDate, nights: b.nights, mine: canRemoveBlock(b, unitId, today), farm: b.type === 'farm-closure' });
      continue;
    }
    const mine = tents.find((t) => t.tentId === unitId);
    if (!mine) continue;
    stays.push({ id: b.id, startDate: b.startDate, nights: b.nights, label: b.label ?? null, guests: (mine.guests ?? []).map(GUEST) });
  }
  const bySoonest = (a, c) => a.startDate.localeCompare(c.startDate);
  return { stays: stays.sort(bySoonest), blocks: blocks.sort(bySoonest) };
}

// The two lines TVC and Linger are sent when a member offers a unit. Contact details go because Linger needs them to get
// in touch, and the member agreed to that when they pressed the button; they are not shown anywhere else.
export function offerNotice({ houseNo, farmUnit, cluster, shape, typeLabel, delegateToTvc, memberName, memberEmail }) {
  const rows = [
    ['Home', `${houseNo}${cluster ? ` (cluster ${cluster})` : ''}`],
    ['Plot (reference)', farmUnit],
    ['Offered as', `${shape === 'whole' ? 'Whole unit' : 'A single room'}, ${typeLabel}`],
    ['Managed by', shape === 'whole' && delegateToTvc ? 'TVC for the member (the member asked for this)' : 'The member'],
    ['Member', memberName],
    ['Sign-in email', memberEmail],
    ['Next', 'Linger to get in touch with the member about terms. Once the contract is signed, the admin team enables the unit.'],
  ];
  return { subject: `A member is offering a home: ${houseNo} (${typeLabel})`, rows };
}
