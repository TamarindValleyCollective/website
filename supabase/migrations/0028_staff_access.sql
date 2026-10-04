-- Staff access model for the consolidated /internal admin (issue #89),
-- replacing the Google Sheets allow-lists (PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID,
-- ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID). Google Sign-In stays the identity
-- proof; these tables hold only *authorization*. See netlify/functions/lib/
-- staff-access.ts (requireStaff) and the design comment on issue #89.
--
--   * super_admin is a global flag on staff_users — manages users/grants,
--     and has NO implicit module access (it must grant itself a role,
--     which is audited).
--   * admin / user / read_only are per-module roles in staff_module_roles.
--     Which capabilities each role carries in each module lives in code,
--     not here — this table only stores who holds which role.
--   * scope narrows a role within a module (e.g. accommodation's old
--     "restricted" role: user + {"allowedTypes": ["casual-stay"]}).
--
-- Privacy: staff emails are PII. staff_users.id is the stable identifier
-- used everywhere except the sign-in lookup — notably staff_audit_log
-- stores ids, never emails.
--
-- Access is server-side only (Netlify Functions using the service_role
-- key). RLS is enabled with no policies and anon/authenticated are revoked,
-- so the public PostgREST API can read none of it.

create table staff_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and email like '%_@_%'),
  name text,
  active boolean not null default true,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references staff_users (id)
);

create table staff_module_roles (
  staff_id uuid not null references staff_users (id) on delete cascade,
  module text not null check (module ~ '^[a-z][a-z0-9-]*$'),
  role text not null check (role in ('admin', 'user', 'read_only')),
  scope jsonb,
  granted_at timestamptz not null default now(),
  granted_by uuid references staff_users (id),
  primary key (staff_id, module)
);

create table staff_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references staff_users (id),
  action text not null,
  module text,
  target_id uuid references staff_users (id),
  -- Free-form context. Must never contain raw PII (emails, phone numbers).
  detail jsonb
);
create index staff_audit_log_at_idx on staff_audit_log (at desc);

-- Append-only: the log is only useful if it can't be quietly edited.
create function staff_audit_log_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'staff_audit_log is append-only';
end;
$$;
create trigger staff_audit_log_no_update_delete
  before update or delete on staff_audit_log
  for each row execute function staff_audit_log_immutable();

alter table staff_users enable row level security;
alter table staff_module_roles enable row level security;
alter table staff_audit_log enable row level security;
revoke all on staff_users, staff_module_roles, staff_audit_log from anon, authenticated;
revoke all on function staff_audit_log_immutable() from public, anon, authenticated;

-- The three initial super admins. Two are personal Gmail accounts, which is
-- why in-app step-up auth (TOTP) is mandatory for super admins rather than
-- relying on Workspace 2-step verification.
insert into staff_users (email, is_super_admin) values
  ('contact@tvc.farm', true),
  ('rajesh.k.thiagarajan@gmail.com', true),
  ('notagarwal@gmail.com', true);
