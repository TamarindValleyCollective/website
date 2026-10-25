-- Where TVC pays a member for their rental: one payout account per household, entered by the member in the portal.
-- Step 3d of docs/plans/accommodation-calendar.md (plan: docs/plans/accommodation-member-units.md).
--
-- TVC collects the money and pays Linger and the members, so it has to hold these. They are the most sensitive data in
-- the register, so:
--   * the account number / IFSC / UPI id and the PAN are stored ENCRYPTED (AES-256-GCM, a key derived from
--     STAFF_MFA_KEY; see netlify/functions/lib/payout-crypto.ts), never as plain text; only the last four characters
--     are kept in the clear, for showing "ending 4821";
--   * the table is server-side only (RLS on, no grants); no browser ever receives a full value except a super admin
--     who asks to reveal it behind the second-factor step-up, and each reveal is audited;
--   * any change to the details sends the account back to `submitted`: it is paid only once `verified`, after a small
--     test transfer to the account.
-- A member whose contract sets the payout against maintenance needs no row here. Linger sends its own invoices, so
-- nothing about Linger's bank details is held.
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: drop table member_payout_accounts.

create table member_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null unique references member_households (id) on delete cascade,
  -- Name as it appears on the account.
  payee_name text not null,
  method text not null check (method in ('bank', 'upi')),
  -- Encrypted JSON: { account, ifsc } for a bank account, { upi } for UPI.
  details_enc text not null,
  details_last4 text not null,
  -- Encrypted PAN, required for every payout.
  pan_enc text not null,
  pan_last4 text not null,
  -- Set by a super admin when the account is verified: whether TDS is deducted, and at what rate (percent).
  tds_applies boolean,
  tds_rate numeric(5, 2) check (tds_rate is null or tds_rate between 0 and 100),
  constraint member_payout_accounts_tds check (tds_applies is distinct from true or tds_rate is not null),
  status text not null default 'submitted' check (status in ('submitted', 'verified')),
  verified_by uuid references staff_users (id) on delete set null,
  verified_at timestamptz,
  entered_by uuid references member_people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table member_payout_accounts enable row level security;
revoke all on member_payout_accounts from anon, authenticated;
