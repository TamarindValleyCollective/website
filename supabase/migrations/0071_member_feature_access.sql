-- Which households may use a feature that is not switched on for everyone yet (early access, a pilot, a staged rollout).
-- A feature is on for a household when its Netlify flag is "true" (everyone), or when a row here names the household and
-- the feature. Written by super admins on the Units screen (Early access tab), behind the step-up, and audited. Used first
-- by "My rental" (MEMBER_RENTAL_ENABLED); a later feature adds its name to the check below and to
-- scripts/lib/member-features.mjs, with no new table.
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: drop table member_feature_access.

create table member_feature_access (
  household_id uuid not null references member_households (id) on delete cascade,
  feature text not null check (feature in ('rental')),
  granted_by uuid references staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, feature)
);

alter table member_feature_access enable row level security;
revoke all on member_feature_access from anon, authenticated;
