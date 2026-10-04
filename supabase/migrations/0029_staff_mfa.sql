-- Second factors for super-admin step-up authentication (issue #89; see
-- netlify/functions/staff-mfa.mts and lib/staff-mfa-crypto.ts). A person can
-- hold several methods at once: an authenticator app (TOTP) and a set of
-- single-use recovery codes today, passkeys later (the `passkey` type and
-- `credential` column are reserved so adding them needs no table change).
-- Step-up is required before the Access module is usable, and only once a
-- person has at least two different methods enrolled.
--
-- Secrets are never stored readable: TOTP secrets are AES-256-GCM encrypted
-- with a key derived from STAFF_MFA_KEY (a Netlify environment variable), and
-- recovery codes are stored only as an HMAC. Like the other staff_* tables,
-- these are reached only by the server-side service_role key — RLS is on with
-- no policies and anon/authenticated are revoked.
--
-- Every table has exactly one foreign key to staff_users (staff_id), so an
-- embedded PostgREST select would be unambiguous, though the code uses plain
-- queries regardless (see the 2026-10-04 staff lookup hotfix).

create table staff_mfa_factors (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users (id) on delete cascade,
  type text not null check (type in ('totp', 'passkey')),
  label text,
  secret_encrypted text,            -- totp: v1.<iv>.<tag>.<ciphertext>
  credential jsonb,                 -- passkey: reserved
  confirmed_at timestamptz,         -- null until a first valid code proves the app is set up
  last_used_step bigint,            -- totp: last accepted 30s time step (replay protection)
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index staff_mfa_factors_staff_idx on staff_mfa_factors (staff_id);

create table staff_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users (id) on delete cascade,
  code_hash text not null,          -- HMAC-SHA256 hex of the normalized code
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index staff_recovery_codes_staff_idx on staff_recovery_codes (staff_id);

-- Failed-attempt counter and lockout, so a 6-digit code can't be brute forced.
create table staff_mfa_state (
  staff_id uuid primary key references staff_users (id) on delete cascade,
  failed_attempts integer not null default 0,
  locked_until timestamptz
);

alter table staff_mfa_factors enable row level security;
alter table staff_recovery_codes enable row level security;
alter table staff_mfa_state enable row level security;
revoke all on staff_mfa_factors, staff_recovery_codes, staff_mfa_state from anon, authenticated;
