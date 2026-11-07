-- Finance: the badges shown on a ledger line to say which records vouch for it (the bank statement, a BHIM or Paytm record,
-- a Razorpay settlement, a Paypro batch). A table, so a logo can be swapped or a new bank added without a code change:
-- set `logo_url` (a path on this site or a full URL) and the badge shows the logo; until then it shows `short_label` as text.
-- A bank account says which bank badge it carries, so a second bank shows its own.

create table fin_source_badges (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null,
  short_label text not null,
  kind text not null check (kind in ('bank', 'upi_app', 'gateway', 'bulk')),
  logo_url text,
  sort integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into fin_source_badges (key, label, short_label, kind, sort) values
  ('axis', 'Axis Bank', 'Axis', 'bank', 10),
  ('bank', 'Bank statement', 'Bank', 'bank', 90),
  ('bhim', 'BHIM UPI', 'BHIM', 'upi_app', 20),
  ('paytm', 'Paytm UPI', 'Paytm', 'upi_app', 30),
  ('razorpay', 'Razorpay', 'Razorpay', 'gateway', 40),
  ('paypro', 'Paypro (bulk payments)', 'Paypro', 'bulk', 50);

alter table fin_bank_accounts add column badge_key text references fin_source_badges (key);
update fin_bank_accounts set badge_key = 'axis' where kind = 'bank' and label ilike '%axis%';

alter table fin_source_badges enable row level security;
revoke all on fin_source_badges from anon, authenticated;
