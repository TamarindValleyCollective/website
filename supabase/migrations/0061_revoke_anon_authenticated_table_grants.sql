-- Defence in depth: every public table already has RLS enabled with no
-- policies (deny-all), but the accommodation, event-payment, WhatsApp and
-- partner-key tables still granted SELECT/INSERT/UPDATE/DELETE to anon and
-- authenticated, so RLS was the only thing between the public Data API and
-- that data. Nothing in the repo talks to Supabase as anon or authenticated
-- (all access is the service-role key from Netlify functions and scripts),
-- so take the grants away. service_role keeps its own grants.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Tables and sequences created from now on start with no anon/authenticated
-- access; a future migration that really needs it must grant it explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
