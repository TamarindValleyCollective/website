-- Partner API, phase 1 (Linger): units as data, plus the keys and access grants
-- the read-only partner API (netlify/functions/partner-api.mts) needs.
--
-- Purely additive: nothing here changes accommodation_tent_assignments, its
-- tent_id CHECK or the accommodation_create_booking/accommodation_update_booking
-- functions, so the admin calendar keeps working exactly as before. Those still
-- hold the tent list in two hardcoded places (the CHECK, plus the farm-closure
-- array in each function - 0010, 0013 and 0016 each had to patch both). Moving
-- them onto this table is deliberately left for phase 2, when the first
-- partner write needs it; until then scripts/lib/accommodation.mjs and the
-- seed below must agree, which scripts/lib/partner-units.test.mjs checks.
--
-- The new tables are RLS-on with no policies, like every other accommodation_*
-- table: only the service_role key (server-side Netlify Functions) reads them.

create table accommodation_unit_pools (
  id text primary key,
  name text not null check (btrim(name) <> ''),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table accommodation_units (
  id text primary key,
  name text not null check (btrim(name) <> ''),
  short_name text,
  -- Display clustering only (the admin tool's "Tents" picker); same meaning as
  -- `group` in ACCOMMODATION_UNITS.
  group_name text,
  kind text not null check (kind in ('fixed', 'removable', 'byot', 'member-home')),
  capacity integer not null check (capacity >= 1),
  owner_type text not null default 'tvc' check (owner_type in ('tvc', 'member')),
  -- The member register's farm unit (F-01..F-53) that owns the home. Null for
  -- TVC's own units. Plain text, not a foreign key: the member tables are
  -- managed by a different feature and this must never block either.
  owner_farm_unit text,
  -- A unit may belong to a pool of interchangeable units (e.g. TVC's tents)
  -- that a partner sells by quantity while TVC assigns the physical unit.
  pool_id text references accommodation_unit_pools (id),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint accommodation_units_member_has_owner
    check ((owner_type = 'member') = (owner_farm_unit is not null))
);

create index accommodation_units_pool_idx on accommodation_units (pool_id);

-- A key identifies a partner (not a person); the partner's access to units and
-- pools is a separate grant so it can change without reissuing the key. The
-- key itself (256 random bits) is never stored, only its SHA-256 hash.
create table partner_api_keys (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null check (partner_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name text not null check (btrim(name) <> ''),
  key_prefix text not null,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index partner_api_keys_partner_idx on partner_api_keys (partner_id);

create table partner_unit_access (
  partner_id text not null,
  unit_id text not null references accommodation_units (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (partner_id, unit_id)
);

create table partner_pool_access (
  partner_id text not null,
  pool_id text not null references accommodation_unit_pools (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (partner_id, pool_id)
);

alter table accommodation_unit_pools enable row level security;
alter table accommodation_units enable row level security;
alter table partner_api_keys enable row level security;
alter table partner_unit_access enable row level security;
alter table partner_pool_access enable row level security;

-- Seed: the farm's current inventory, with the same ids the bookings already
-- use. Nothing is granted to any partner and no pool exists yet; both are
-- decided with Linger and done by hand (scripts/partner-key.mjs).
insert into accommodation_units (id, name, short_name, group_name, kind, capacity, sort_order) values
  ('Tent01', 'Malabar Hut Fixed Tent (N)', 'Fixed Tent (N)', 'Malabar Hut', 'fixed', 3, 1),
  ('Tent02', 'Malabar Hut Fixed Tent (S)', 'Fixed Tent (S)', 'Malabar Hut', 'fixed', 3, 2),
  ('Tent03', 'Malabar Hut Portable Tent', 'Portable Tent', 'Malabar Hut', 'removable', 2, 3),
  ('Tent04', 'Banyan Hut Fixed Tent', 'Fixed Tent', 'Banyan Hut', 'fixed', 3, 4),
  ('Tent05', 'Banyan Hut Portable Tent', 'Portable Tent', 'Banyan Hut', 'removable', 2, 5),
  ('Tent06', 'Upper Bamboo Hut', 'Upper Hut', 'Bamboo Huts', 'fixed', 2, 6),
  ('Tent07', 'Lower Bamboo Hut', 'Lower Hut', 'Bamboo Huts', 'fixed', 2, 7),
  ('Tent08', 'Large Portable Tent', 'Large Tent', 'Portable Tents', 'removable', 3, 8),
  ('Tent09', 'Medium Portable Tent', 'Medium Tent', 'Portable Tents', 'removable', 2, 9),
  ('BYOT01', 'Bring Your Own Tent 1', 'Tent 1', 'Bring Your Own Tent', 'byot', 3, 10),
  ('BYOT02', 'Bring Your Own Tent 2', 'Tent 2', 'Bring Your Own Tent', 'byot', 3, 11),
  ('BYOT03', 'Bring Your Own Tent 3', 'Tent 3', 'Bring Your Own Tent', 'byot', 3, 12),
  ('BYOT04', 'Bring Your Own Tent 4', 'Tent 4', 'Bring Your Own Tent', 'byot', 3, 13),
  ('BYOT05', 'Bring Your Own Tent 5', 'Tent 5', 'Bring Your Own Tent', 'byot', 3, 14);
