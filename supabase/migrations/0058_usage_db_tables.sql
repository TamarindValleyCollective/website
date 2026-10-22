-- Free-tier usage dashboard: which tables take up the database.
--
-- The free plan allows 500 MB. usage-collect.mts already records the total every 6 hours;
-- this says *what* is filling it, so a rising size can be traced to a table (and a cleanup
-- or retention rule) instead of guessed at. It is recorded next to the total as a
-- 'supabase'/'db_tables' snapshot, with the list in `detail`.
--
-- Returns the 8 biggest tables in the public schema: name, size including indexes, and the
-- planner's row estimate (approximate, from the last analyze). Names and numbers only,
-- never row contents. SECURITY DEFINER so it can size every table whatever the caller's
-- rights; only the service role can call it.
create function usage_db_tables()
returns table (table_name text, total_bytes bigint, row_estimate bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.relname::text,
    pg_total_relation_size(c.oid),
    greatest(c.reltuples, 0)::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
  limit 8;
$$;

revoke all on function usage_db_tables() from public, anon, authenticated;
grant execute on function usage_db_tables() to service_role;
