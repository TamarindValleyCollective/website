// The rules for members' units: what an offer may contain, what enabling one creates, when a unit may be offboarded,
// and what an admin may edit on it. Pure, so they are tested directly (member-units.test.mjs); the Units function
// (netlify/functions/units-admin.mts) does the reading and writing. Plan: docs/plans/accommodation-member-units.md.

export const MEMBER_TYPES = ['1br', '1bhk', '2bhk', '3bhk'];
export const WHOLE_TYPES = ['1bhk', '2bhk', '3bhk'];
export const REQUEST_MODES = ['reject', 'ask', 'auto'];
export const CLUSTERS = ['H1-A', 'H1-B', 'H2'];

// How many a member type sleeps, until the admin sets it for a particular unit.
export const DEFAULT_CAPACITY = { '1br': 2, '1bhk': 3, '2bhk': 4, '3bhk': 6 };

const FARM_UNIT = /^F-[0-9]{2}$/;
const TAG_MAX = 12;
const TAG_LENGTH = 30;
const NOTE_MAX = 500;

// An offer: a whole unit (1 to 3 BHK, optionally managed by TVC) or a single room (always "1 bedroom", managed by
// the member). Returns a message, or null when it is fine.
export function offerProblem({ shape, typeId, delegateToTvc }) {
  if (shape !== 'whole' && shape !== 'room') return 'Choose whether you are offering the whole unit or a single room.';
  if (shape === 'room') {
    if (typeId !== '1br') return 'A single room is offered as "1 bedroom".';
    if (delegateToTvc) return 'You accept requests for a single room yourself.';
    return null;
  }
  if (!WHOLE_TYPES.includes(typeId)) return 'Choose the size of the unit: 1, 2 or 3 BHK.';
  return null;
}

// What enabling an offer does. `existing` is any unit already stored for this household (an offboarded one is reused so
// the unit's history stays on one row). Returns { error } or { unit, reuse }, where `unit` is the row to write.
export function enablePlan({ offer, household, existing, typeId, delegateToTvc, nextSortOrder }) {
  if (!offer || offer.status !== 'interested') return { error: 'This offer is not waiting to be enabled.' };
  if (!household || !FARM_UNIT.test(household.farm_unit ?? '')) return { error: 'The household has no farm unit.' };
  // A unit is a home: it is known by its house number (H-10) to the member, the admins, Madhavan and Linger alike.
  // The farm number (F-12) stays its id, but it is the plot, not the name anyone sees.
  if (!household.house_no) return { error: 'This household has no home (no house number) yet.' };
  const problem = offerProblem({ shape: offer.shape, typeId, delegateToTvc });
  if (problem) return { error: problem };
  if (existing && existing.status !== 'offboarded') return { error: `${household.farm_unit} already has a unit.` };
  const unit = {
    id: household.farm_unit,
    // Neutral on purpose: a unit's name can reach a partner, and must not name the member.
    name: `Home ${household.house_no}`,
    short_name: `Home ${household.house_no}`,
    group_name: null,
    kind: 'member-home',
    capacity: DEFAULT_CAPACITY[typeId],
    owner_type: 'member',
    owner_farm_unit: household.farm_unit,
    pool_id: typeId,
    status: 'rentable',
    // TVC manages a whole unit only when the member delegated it; a room is always the member's.
    manager: offer.shape === 'whole' && delegateToTvc ? 'tvc' : 'member',
    listing_shape: offer.shape,
    cluster: household.cluster ?? null,
    request_mode: 'reject',
    ignores_farm_closure: false,
    sort_order: nextSortOrder,
  };
  return existing ? { unit, reuse: true } : { unit, reuse: false };
}

// A unit with a booking that has not ended cannot be offboarded: reallocate or cancel those first.
export function offboardProblem(futureBookings) {
  if (!futureBookings?.length) return null;
  const n = futureBookings.length;
  return `It has ${n} future booking${n === 1 ? '' : 's'}. Reallocate or cancel ${n === 1 ? 'it' : 'them'} first.`;
}

// What an admin may edit on a unit: its tags, cluster, capacity and the farm manager's private note. Returns
// { error } or { patch } with only the fields that were given, cleaned up.
export function editPatch(body) {
  const patch = {};
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > TAG_MAX) return { error: `Give at most ${TAG_MAX} tags.` };
    const tags = [];
    for (const raw of body.tags) {
      if (typeof raw !== 'string') return { error: 'Tags must be words.' };
      const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!tag) continue;
      if (tag.length > TAG_LENGTH) return { error: `A tag can be at most ${TAG_LENGTH} characters.` };
      if (!tags.includes(tag)) tags.push(tag);
    }
    patch.tags = tags;
  }
  if (body.cluster !== undefined) {
    if (body.cluster !== null && !CLUSTERS.includes(body.cluster)) return { error: `The cluster must be one of ${CLUSTERS.join(', ')}.` };
    patch.cluster = body.cluster;
  }
  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== 'string') return { error: 'The note must be text.' };
    const note = body.note === null ? null : body.note.trim();
    if (note && note.length > NOTE_MAX) return { error: `The note can be at most ${NOTE_MAX} characters.` };
    patch.note = note || null;
  }
  if (body.capacity !== undefined) {
    if (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 12) return { error: 'Capacity must be a whole number from 1 to 12.' };
    patch.capacity = body.capacity;
  }
  if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
  return { patch };
}

// Only these may be set on a unit's status from the Units screen.
export function statusChange(unit, to) {
  if (!unit) return { error: 'Unit not found.' };
  if (unit.status === 'offboarded') return { error: 'This unit has been offboarded.' };
  if (to !== 'rentable' && to !== 'paused') return { error: 'A unit can be paused or resumed.' };
  if (unit.status === to) return { error: `It is already ${to === 'paused' ? 'paused' : 'rentable'}.` };
  return { status: to };
}
