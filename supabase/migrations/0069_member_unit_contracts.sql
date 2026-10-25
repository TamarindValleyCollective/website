-- The three-way contract (Linger, TVC, the member) behind a member's unit offer. Step 3c of
-- docs/plans/accommodation-calendar.md (plan: docs/plans/accommodation-member-units.md).
--
-- Flow: the admin shares the electronic copy (a PDF kept in the private R2 bucket) -> the member reads it in the portal
-- and uploads the signed copy -> the admin records the dates and Linger's references and enables the unit, which needs
-- the signed copy. Digital signing may replace the upload later; nothing here assumes how it was signed.
--
-- The row is also what settlement will be built from. TVC collects the money and pays Linger and the member; a
-- member's payout may be set against their maintenance instead of paid out. The split is fixed by unit type (the
-- percentages are copied onto the contract so a later change to a type's terms never rewrites a signed contract) and a
-- stay counts on the day it ends (check-out). Bank, UPI and tax details are NOT held here: payouts are not automated
-- yet, and they will go in their own restricted table when they are.
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: drop table member_unit_contracts.

create table member_unit_contracts (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null unique references member_unit_offers (id) on delete cascade,
  household_id uuid not null references member_households (id) on delete cascade,
  farm_unit text not null,
  partner_id text not null default 'linger',
  -- shared: waiting for the member's signed copy; signed: the signed copy is in; active: the unit is enabled on it;
  -- ended / cancelled: no longer in force.
  status text not null default 'shared' check (status in ('shared', 'signed', 'active', 'ended', 'cancelled')),
  terms_version text not null,
  -- What was agreed, copied from the offer when the contract is shared.
  type_id text not null references accommodation_unit_pools (id),
  shape text not null check (shape in ('whole', 'room')),
  manager text not null check (manager in ('tvc', 'member')),
  -- Each party's share of a stay's revenue, in percent: fixed by unit type, entered from the type's terms. All three or none.
  member_pct numeric(5, 2) check (member_pct between 0 and 100),
  tvc_pct numeric(5, 2) check (tvc_pct between 0 and 100),
  linger_pct numeric(5, 2) check (linger_pct between 0 and 100),
  constraint member_unit_contracts_split check (
    (member_pct is null and tvc_pct is null and linger_pct is null)
    or (member_pct is not null and tvc_pct is not null and linger_pct is not null and member_pct + tvc_pct + linger_pct = 100)
  ),
  -- Settlement: TVC collects and pays out. A stay counts in the cycle it ends in.
  collector text not null default 'tvc' check (collector in ('tvc')),
  settlement_cycle text not null default 'monthly' check (settlement_cycle in ('monthly', 'per_stay')),
  counts_on text not null default 'check_out' check (counts_on in ('check_out')),
  member_payout text not null default 'bank_transfer' check (member_payout in ('bank_transfer', 'maintenance_adjustment')),
  -- The same unit and room in Linger's own system, for the API integration and for matching their statements.
  linger_contract_ref text,
  linger_property_ref text,
  linger_room_ref text,
  signed_on date,
  effective_from date,
  ends_on date,
  notice_days integer check (notice_days is null or notice_days >= 0),
  -- Object keys in the private bucket, never links.
  contract_doc text not null,
  signed_doc text,
  shared_by uuid references staff_users (id) on delete set null,
  shared_at timestamptz not null default now(),
  signed_uploaded_by uuid references member_people (id) on delete set null,
  signed_uploaded_at timestamptz,
  activated_by uuid references staff_users (id) on delete set null,
  activated_at timestamptz,
  updated_at timestamptz not null default now()
);

create index member_unit_contracts_household_idx on member_unit_contracts (household_id);

alter table member_unit_contracts enable row level security;
revoke all on member_unit_contracts from anon, authenticated;
