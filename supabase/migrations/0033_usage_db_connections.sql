-- Free-tier usage dashboard: how many database connections are open right now.
--
-- The free plan allows 60 direct connections; every Netlify function that talks to
-- Supabase over REST goes through PostgREST's own small pool, so this is an early
-- warning, not a precise bill. usage-collect.mts records it next to the database size
-- every 6 hours as a 'supabase'/'db_connections' snapshot (limit_value = max_connections).
--
-- SECURITY DEFINER so it can count every backend (pg_stat_activity hides other roles'
-- rows from a plain caller); it returns two numbers and nothing else (no queries, users
-- or addresses), and only the service role can call it.
create function usage_db_connections()
returns table (in_use integer, max_allowed integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::integer from pg_stat_activity where datname = current_database()),
    current_setting('max_connections')::integer;
$$;

revoke all on function usage_db_connections() from public, anon, authenticated;
grant execute on function usage_db_connections() to service_role;
