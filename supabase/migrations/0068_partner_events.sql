-- A log of things a partner should be told, kept so that how they are told can change without losing any of them.
-- Today a member offering a unit (step 3b of docs/plans/accommodation-calendar.md) is told to Linger by email; Linger is
-- expected to want an API integration later. The event is recorded first, with everything a partner would need in
-- `payload`, and each way of delivering it (email now, an API push later) records what happened in `delivery`, so a
-- push can be added without re-deriving past events or missing one.
--
-- `payload` may hold a member's name and sign-in email: the member agrees to Linger being sent them when they press the
-- offer button (the wording says so). It is never sent to a browser, and the table is server-side only.
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: drop table partner_events.

create table partner_events (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null default 'linger',
  -- What happened, in the form noun.verb, for example unit.offered.
  type text not null check (type ~ '^[a-z]+(\.[a-z_]+)+$'),
  -- What it is about, for example the farm unit F-12.
  subject text,
  payload jsonb not null default '{}',
  -- Per delivery channel: { "email": { "status": "sent", "at": "..." } }.
  delivery jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index partner_events_partner_idx on partner_events (partner_id, created_at desc);

alter table partner_events enable row level security;
revoke all on partner_events from anon, authenticated;
