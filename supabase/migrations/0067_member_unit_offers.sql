-- A member offers their unit to Linger; the super admin enables it once the contract is signed. Step 3a of
-- docs/plans/accommodation-calendar.md (plan: docs/plans/accommodation-member-units.md).
--
--   * member_unit_offers records an offer before any unit exists. Enabling an offer creates the accommodation_units
--     row (id = the household's farm unit, e.g. F-12) and marks the offer `enabled`.
--   * accommodation_units.request_mode is how a unit its member manages treats a request: auto-reject (the default,
--     so a newly enabled unit is not offered until the member chooses otherwise), ask each time, or auto-accept.
--   * A household has at most one unit: owner_farm_unit becomes unique.
--
-- Backwards compatible with the running app: only additive. Not auto-applied on merge; apply before merging the code
-- that reads these.
--
-- Rollback: drop the index and the column on accommodation_units, then drop table member_unit_offers.

alter table accommodation_units
  add column request_mode text not null default 'reject' check (request_mode in ('reject', 'ask', 'auto'));

create unique index accommodation_units_one_per_household on accommodation_units (owner_farm_unit) where owner_farm_unit is not null;

create table member_unit_offers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  requested_by uuid references member_people (id) on delete set null,
  -- Whole unit, or a single room of a home the member lives in. Fixed once the unit is enabled.
  shape text not null check (shape in ('whole', 'room')),
  -- The member type asked for (the admin may change it when enabling): a room is "1 bedroom", a whole unit is 1 to 3 BHK.
  type_id text not null references accommodation_unit_pools (id),
  -- Whether the member wants TVC to manage the unit for them. Only a whole unit can be delegated.
  delegate_to_tvc boolean not null default false,
  status text not null default 'interested' check (status in ('interested', 'enabled', 'withdrawn', 'declined')),
  decided_by uuid references staff_users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_unit_offers_room_type check (shape <> 'room' or type_id = '1br'),
  constraint member_unit_offers_whole_type check (shape <> 'whole' or type_id in ('1bhk', '2bhk', '3bhk')),
  constraint member_unit_offers_room_not_delegated check (shape <> 'room' or not delegate_to_tvc)
);

-- One open offer per household at a time.
create unique index member_unit_offers_one_open on member_unit_offers (household_id) where status = 'interested';
create index member_unit_offers_status_idx on member_unit_offers (status, created_at);

-- Server-side only, like the rest of the member register: row level security on, no policies, no direct grants.
alter table member_unit_offers enable row level security;
revoke all on member_unit_offers from anon, authenticated;
