-- Finance module: the registered name behind a UPI ID (docs/finance/FINANCE.md, "UPI ID names").
-- NOT YET APPLIED to TVC ERP. Apply, then check: the table is RLS-on with no anon/authenticated grants, and a row with an upper-case
-- UPI ID or a name on a failed lookup is refused.
--
-- A UPI payment to a person often shows only their UPI ID. Razorpay's validate-VPA call says whose ID it is; each answer is kept here so a
-- UPI ID is asked about once, not on every page load (the call is billed by Razorpay, and its price is not confirmed). The ledger's
-- suggestion engine reads these rows and offers the registered name as the party instead of the bare ID.
--
-- `vpa` is the lowercase UPI ID. `success` is whether it exists; `name` is the bank-registered name and only set when it does (a real ID
-- can come back with no name: no linked bank account). `key_mode` is whether the answer came from Razorpay's live or test keys: only live
-- answers are used (a test-mode answer is not a real person). The UPI IDs and names in this table are personal data and are never in the
-- repository; the table has no policy and no anon/authenticated grant, so only the Netlify Functions (service role) can read it.

create table fin_vpa_names (
  vpa text primary key check (vpa = lower(vpa) and length(vpa) between 5 and 320),
  success boolean not null,
  name text check (name is null or (success and length(name) between 1 and 200)),
  key_mode text not null check (key_mode in ('live', 'test')),
  checked_by uuid references staff_users (id),
  checked_at timestamptz not null default now()
);
alter table fin_vpa_names enable row level security;
revoke all on fin_vpa_names from anon, authenticated;
