-- Settings and alert memory for the /internal/usage dashboard (builds on
-- 0030_usage_metering.sql, which holds the measurements themselves).
--
--   * usage_settings    — a few admin-editable numbers the rules need, e.g. the
--                         token prices used to turn Anthropic usage into dollars
--                         (typed in rather than hard-coded, since prices change)
--                         and Gemini's daily request limit. Values only; no
--                         personal data. updated_by is the staff id, never an
--                         email.
--   * usage_alert_state — which alert conditions have already been emailed, and
--                         at what level, so a condition that stays true does
--                         not email every hour. A row is deleted when the
--                         condition clears, so a recurrence emails again.
--
-- Access is service_role only, like every table in this project: RLS on, no
-- policies, anon/authenticated revoked.

create table usage_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references staff_users (id)
);

create table usage_alert_state (
  alert_key text primary key check (alert_key ~ '^[a-z][a-z0-9_.:-]*$'),
  level text not null check (level in ('warn', 'critical')),
  first_notified_at timestamptz not null default now(),
  last_notified_at timestamptz not null default now()
);

alter table usage_settings enable row level security;
alter table usage_alert_state enable row level security;
revoke all on usage_settings, usage_alert_state from anon, authenticated;
