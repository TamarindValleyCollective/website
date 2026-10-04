-- One-time challenges for passkey (WebAuthn) enrolment and step-up (issue #89;
-- see netlify/functions/staff-mfa.mts and lib/staff-webauthn.ts). The passkeys
-- themselves live in staff_mfa_factors (type 'passkey', `credential` jsonb),
-- created in 0029; this table only holds the random challenge the server hands
-- the browser, so a signed response can be accepted once and only once.
--
-- A challenge is consumed by deleting it (a single DELETE ... RETURNING), so two
-- requests racing with the same response can't both win. Rows older than five
-- minutes are ignored by the code and replaced whenever the person asks for a
-- new challenge.
--
-- Like the other staff_* tables: reached only by the server-side service_role
-- key, RLS on with no policies, anon/authenticated revoked.

create table staff_webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users (id) on delete cascade,
  purpose text not null check (purpose in ('register', 'verify')),
  challenge text not null,          -- base64url, as sent to and echoed by the browser
  created_at timestamptz not null default now()
);
create index staff_webauthn_challenges_lookup_idx on staff_webauthn_challenges (staff_id, purpose, challenge);

alter table staff_webauthn_challenges enable row level security;
revoke all on staff_webauthn_challenges from anon, authenticated;
