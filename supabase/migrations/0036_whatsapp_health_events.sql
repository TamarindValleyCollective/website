-- Account-health events Meta sends to whatsapp-webhook.mts: a template
-- approved / rejected / paused / disabled, a template or phone-number quality
-- change, a template recategorised, an account restriction. Each is emailed to
-- core-team once and kept here so /internal/usage can show the recent ones.
--
-- event_key is a hash of the delivery (entry id + time + field + payload), so
-- Meta's at-least-once retries insert nothing the second time and never
-- re-email. Not auto-applied: apply to the "TVC ERP" project before deploying.
create table whatsapp_health_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  field text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  title text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index whatsapp_health_events_created_idx on whatsapp_health_events (created_at desc);

-- Same posture as the other whatsapp_* tables: service-role only.
alter table whatsapp_health_events enable row level security;
