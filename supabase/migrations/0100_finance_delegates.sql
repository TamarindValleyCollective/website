-- Finance module: delegates of the UPI circle (docs/finance/FINANCE.md, "Delegates").
-- Applied to TVC ERP on 2026-11-15 (recorded as finance_delegates). Checked afterwards: both tables RLS-on with no anon/authenticated
-- grants, the constraint present, no delegate or link rows yet, no existing request row changed. Tested the same day inside a transaction
-- that was rolled back (which caught a NULL-in-CHECK hole in the first draft of the request constraint).
--
-- The UPI exports are in the operator's name, so no file says which delegate paid. A delegate is known by the number the UPI app
-- shows on the receipt ("Paid for <number>"), which an admin types once. A delegated payment is attributed by date (the one
-- delegate active that day), and by an explicit pick when two or more were active. The UPI row itself never changes
-- (fin_upi_lines is link-only), so the picks live in their own table, keyed by the 12-digit UPI reference like payment notes.
--
-- Tables
--   * fin_delegates: the number (unique per entity), an optional name, the dates they were active (end empty = still active) and an
--     optional monthly limit (empty = the circle default).
--   * fin_upi_delegate_links: an explicit "this payment was this delegate's", for payments the dates cannot decide. Written by
--     reference, so it can exist before the UPI row does.
--   * fin_payment_requests.delegate_id: which delegate a logged delegated spend was made by.
-- The number is personal data: it is stored here only, never in the repository, and the tables are service-role only (RLS on, no
-- grants to anon or authenticated). Nothing here is a real name or number.

create table fin_delegates (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  identifier text not null check (identifier ~ '^[0-9]{7,15}$'),
  display_name text check (display_name is null or length(display_name) between 2 and 60),
  active_from date not null,
  active_to date,
  cap_paise bigint check (cap_paise is null or (cap_paise > 0 and cap_paise <= 10000000)),
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, identifier),
  check (active_to is null or active_to >= active_from)
);

create table fin_upi_delegate_links (
  entity_id uuid not null references fin_entities (id),
  upi_ref text not null check (upi_ref ~ '^[0-9]{12}$'),
  delegate_id uuid not null references fin_delegates (id),
  assigned_by uuid references staff_users (id),
  assigned_at timestamptz not null default now(),
  primary key (entity_id, upi_ref)
);

create index fin_upi_delegate_links_delegate on fin_upi_delegate_links (delegate_id);

alter table fin_payment_requests
  add column delegate_id uuid references fin_delegates (id),
  add constraint fin_payment_requests_delegate_only_when_delegated check (delegate_id is null or coalesce(paid_via = 'delegate', false));

alter table fin_delegates enable row level security;
alter table fin_upi_delegate_links enable row level security;
revoke all on fin_delegates, fin_upi_delegate_links from anon, authenticated;
