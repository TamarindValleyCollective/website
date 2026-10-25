// Data access for the partner API (see supabase/migrations/0060_partner_api_foundation.sql)
// in the "TVC ERP" Supabase project: key lookup, a partner's unit/pool grants,
// and the booking rows availability is computed from. Same hand-rolled
// PostgREST style as accommodation-db.mjs, service_role only, server-side only.
//
// Availability reads accommodation_tent_assignments and accommodation_bookings
// but never guest tables: nothing in this file can return a name, mobile or
// email, which is what keeps the partner API PII-free by construction.
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

const inList = (values) => `in.(${values.map((v) => encodeURIComponent(v)).join(',')})`;
const overlap = (from, to) => `ov.${encodeURIComponent(`[${from},${to})`)}`;
const UNIT_FIELDS = 'id,name,short_name,group_name,kind,capacity,owner_type,owner_farm_unit,pool_id,active,status,ignores_farm_closure,sort_order';

// ---- Read path (used by the Function) ----

export async function findKeyByHash(hash) {
  const res = await restFetch(`/partner_api_keys?key_hash=eq.${hash}&select=id,partner_id,expires_at,revoked_at,last_used_at`);
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function touchKey(id) {
  await restFetch(`/partner_api_keys?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  });
}

// The units a partner may sell: those granted one by one, plus every unit of
// each pool it is granted (reported as the pool, never as separate units).
export async function getPartnerAccess(partnerId) {
  const [unitGrants, poolGrants] = await Promise.all([
    restFetch(`/partner_unit_access?partner_id=eq.${encodeURIComponent(partnerId)}&select=unit_id`).then((r) => r.json()),
    restFetch(`/partner_pool_access?partner_id=eq.${encodeURIComponent(partnerId)}&select=pool_id`).then((r) => r.json()),
  ]);
  const unitIds = unitGrants.map((g) => g.unit_id);
  const poolIds = poolGrants.map((g) => g.pool_id);

  const [units, pools, poolUnits] = await Promise.all([
    unitIds.length ? restFetch(`/accommodation_units?id=${inList(unitIds)}&select=${UNIT_FIELDS}&order=sort_order.asc`).then((r) => r.json()) : [],
    poolIds.length ? restFetch(`/accommodation_unit_pools?id=${inList(poolIds)}&select=id,name,active&order=id.asc`).then((r) => r.json()) : [],
    poolIds.length ? restFetch(`/accommodation_units?pool_id=${inList(poolIds)}&select=${UNIT_FIELDS}&order=sort_order.asc`).then((r) => r.json()) : [],
  ]);

  return {
    units,
    pools: pools.map((p) => ({ ...p, units: poolUnits.filter((u) => u.pool_id === p.id) })),
  };
}

// Tent assignments (any booking type) that overlap [from, to) for these units.
export async function listAssignments(unitIds, from, to) {
  if (unitIds.length === 0) return [];
  const res = await restFetch(
    `/accommodation_tent_assignments?tent_id=${inList(unitIds)}&stay_range=${overlap(from, to)}&select=tent_id,stay_range&limit=5000`,
  );
  return res.json();
}

// Bookings that close every unit although they hold no tent rows: farm
// closures, and exclusive bookings (see partner-availability.mjs).
export async function listBlockingBookings(from, to) {
  const res = await restFetch(
    `/accommodation_bookings?stay_range=${overlap(from, to)}&or=(type.eq.farm-closure,exclusive.is.true)&select=start_date,nights&limit=1000`,
  );
  return res.json();
}

// ---- Admin path (used only by scripts/partner-key.mjs) ----

export async function insertKey({ partnerId, name, prefix, hash, createdBy, expiresAt }) {
  const res = await restFetch('/partner_api_keys', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ partner_id: partnerId, name, key_prefix: prefix, key_hash: hash, created_by: createdBy, expires_at: expiresAt ?? null }),
  });
  return (await res.json())[0];
}

export async function listKeys(partnerId) {
  const filter = partnerId ? `partner_id=eq.${encodeURIComponent(partnerId)}&` : '';
  const res = await restFetch(`/partner_api_keys?${filter}select=id,partner_id,name,key_prefix,created_by,created_at,last_used_at,expires_at,revoked_at&order=created_at.desc`);
  return res.json();
}

export async function revokeKey(id) {
  const res = await restFetch(`/partner_api_keys?id=eq.${id}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  return (await res.json())[0] ?? null;
}

export async function listUnits() {
  const res = await restFetch(`/accommodation_units?select=${UNIT_FIELDS}&order=sort_order.asc`);
  return res.json();
}

async function upsert(table, onConflict, rows) {
  await restFetch(`/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

export const createPool = (id, name) => upsert('accommodation_unit_pools', 'id', [{ id, name }]);
export const grantUnits = (partnerId, unitIds) => upsert('partner_unit_access', 'partner_id,unit_id', unitIds.map((u) => ({ partner_id: partnerId, unit_id: u })));
export const grantPool = (partnerId, poolId) => upsert('partner_pool_access', 'partner_id,pool_id', [{ partner_id: partnerId, pool_id: poolId }]);

export async function revokeUnitGrant(partnerId, unitId) {
  await restFetch(`/partner_unit_access?partner_id=eq.${encodeURIComponent(partnerId)}&unit_id=eq.${encodeURIComponent(unitId)}`, { method: 'DELETE' });
}

export async function revokePoolGrant(partnerId, poolId) {
  await restFetch(`/partner_pool_access?partner_id=eq.${encodeURIComponent(partnerId)}&pool_id=eq.${encodeURIComponent(poolId)}`, { method: 'DELETE' });
}

export async function setUnitPool(unitIds, poolId) {
  await restFetch(`/accommodation_units?id=${inList(unitIds)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ pool_id: poolId }),
  });
}
