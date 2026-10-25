// The accommodation_units and accommodation_unit_pools rows (migration 0065) as the shapes the admin calendar, the
// stay notices and the WhatsApp guest panel use. Pure, so it is tested directly (accommodation-units.test.mjs);
// accommodation-db.mjs fetches the rows. The unit constant in accommodation.mjs is now only the fallback used before
// the first load and the seed the tests compare against.

export const UNIT_SELECT =
  'id,name,short_name,group_name,kind,capacity,owner_type,owner_farm_unit,pool_id,status,manager,listing_shape,cluster,tags,note,ignores_farm_closure,sort_order';
export const TYPE_SELECT = 'id,name,owner_type,sort_order,active';

// A unit row as the calendar sees it. `note` is the farm manager's private note, so it is only included for people who
// may see it (never for a read-only role, a member or a partner).
export function unitFromRow(row, { includeNote = false } = {}) {
  const unit = {
    id: row.id,
    label: row.name,
    shortLabel: row.short_name || row.name,
    capacity: row.capacity,
    kind: row.kind,
    group: row.group_name ?? '',
    type: row.pool_id ?? '',
    status: row.status ?? 'rentable',
    manager: row.manager ?? 'tvc',
    ownerFarmUnit: row.owner_farm_unit ?? null,
    listingShape: row.listing_shape ?? null,
    cluster: row.cluster ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    ignoresFarmClosure: Boolean(row.ignores_farm_closure),
  };
  if (includeNote && row.note) unit.note = row.note;
  return unit;
}

export function typeFromRow(row) {
  return { id: row.id, label: row.name, ownerType: row.owner_type ?? 'tvc' };
}

// The built-in list, in the same shape, for use before the database has answered or when it cannot (for example the
// app is deployed before migration 0065 is applied). Everything in it is TVC-managed and rentable.
export function unitFromSeed(seed) {
  return {
    id: seed.id,
    label: seed.label,
    shortLabel: seed.shortLabel,
    capacity: seed.capacity,
    kind: seed.kind,
    group: seed.group,
    type: seed.type ?? '',
    status: 'rentable',
    manager: 'tvc',
    ownerFarmUnit: null,
    listingShape: null,
    cluster: null,
    tags: [],
    ignoresFarmClosure: false,
  };
}

// Why staff may not write to a unit, or null when they may. A unit a member manages is view-only for the farm
// manager; an offboarded unit is no longer in use. `status` is the HTTP status to answer with.
export function writeProblem(unit) {
  if (!unit) return null;
  if (unit.status === 'offboarded') return { status: 400, message: `${unit.label} is no longer in use` };
  if (unit.manager === 'member') {
    return { status: 403, message: `${unit.label} is managed by its member. You can see it here, but only the member can change it.` };
  }
  return null;
}

// Whether a whole-farm closure (or an exclusive booking) applies to a unit on a night: it does unless the unit has
// been set to stay open or has been offboarded.
export function closureApplies(unit) {
  return unit.status !== 'offboarded' && !unit.ignoresFarmClosure;
}
