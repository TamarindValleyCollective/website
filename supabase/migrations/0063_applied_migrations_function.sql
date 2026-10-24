-- CI check: has the migration a PR adds actually been applied to this project?
--
-- supabase_migrations.schema_migrations (where apply_migration and `supabase db push` record
-- what ran) is not exposed through the Data API, so the "Migrations applied" GitHub Action
-- (.github/workflows/check-migrations-applied.yml) reads it through this function with the
-- service_role key it already has as a repo secret. Returns version and name only, never the
-- statements. SECURITY DEFINER so it can read the supabase_migrations schema; only the
-- service role can call it.
create function applied_migrations()
returns table (version text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.version, m.name
  from supabase_migrations.schema_migrations m
  order by m.version;
$$;

revoke all on function applied_migrations() from public, anon, authenticated;
grant execute on function applied_migrations() to service_role;
