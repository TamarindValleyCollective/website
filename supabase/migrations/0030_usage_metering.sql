-- Usage metering for the free-tier / credits dashboard (a future /internal/usage
-- admin module). Two small tables, both server-side only:
--
--   * usage_daily     — per-day running totals per service/metric, e.g.
--                       ('2026-10-05', 'anthropic', 'input_tokens', 18342).
--                       Written by the Netlify Functions that call paid or
--                       quota-limited APIs, via usage_record() so a burst of
--                       concurrent requests adds up atomically instead of
--                       racing a read-then-write. Bounded growth: one row per
--                       day per metric, never one per request.
--   * usage_snapshots — point-in-time readings of things we can *read* rather
--                       than count ourselves (e.g. database size), appended
--                       by a scheduled function.
--
-- Contains no personal data: only counts and sizes, never message content,
-- IPs or emails.
--
-- Access is service_role only (Netlify Functions). RLS is on with no policies
-- and anon/authenticated are revoked, matching staff_* (0028): the public
-- PostgREST API can read and write none of it.

create table usage_daily (
  day date not null,
  service text not null check (service ~ '^[a-z][a-z0-9_-]*$'),
  metric text not null check (metric ~ '^[a-z][a-z0-9_]*$'),
  value numeric not null default 0 check (value >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, service, metric)
);

create table usage_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  service text not null check (service ~ '^[a-z][a-z0-9_-]*$'),
  metric text not null check (metric ~ '^[a-z][a-z0-9_]*$'),
  value numeric not null,
  unit text not null,
  limit_value numeric,
  detail jsonb
);

create index usage_snapshots_lookup on usage_snapshots (service, metric, captured_at desc);

alter table usage_daily enable row level security;
alter table usage_snapshots enable row level security;
revoke all on usage_daily, usage_snapshots from anon, authenticated;

-- Adds each metric in p_metrics (a flat {"name": number} object) to today's
-- (UTC) total for p_service. One call per metered request, however many
-- metrics it carries. Ignores non-numeric or negative values rather than
-- failing: metering must never be the reason a request errors.
create function usage_record(p_service text, p_metrics jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  m record;
  v numeric;
begin
  if jsonb_typeof(p_metrics) is distinct from 'object' then
    return;
  end if;
  for m in select key, value from jsonb_each_text(p_metrics) loop
    begin
      v := m.value::numeric;
    exception when others then
      continue;
    end;
    if v is null or v <= 0 or m.key !~ '^[a-z][a-z0-9_]*$' then
      continue;
    end if;
    insert into usage_daily (day, service, metric, value)
    values ((now() at time zone 'utc')::date, p_service, m.key, v)
    on conflict (day, service, metric)
    do update set value = usage_daily.value + excluded.value, updated_at = now();
  end loop;
end;
$$;

-- Size of this project's database in bytes — what the free plan's 500 MB
-- database limit is measured against (approximately; the Supabase dashboard
-- is the authority).
create function usage_db_size()
returns bigint
language sql
stable
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

revoke all on function usage_record(text, jsonb) from public, anon, authenticated;
revoke all on function usage_db_size() from public, anon, authenticated;
grant execute on function usage_record(text, jsonb) to service_role;
grant execute on function usage_db_size() to service_role;
