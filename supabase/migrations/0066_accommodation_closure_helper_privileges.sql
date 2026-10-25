-- The helper added in 0065, accommodation_farm_closure_unit_ids(), was created with Supabase's default function
-- privileges, which let the anon and authenticated roles execute it. Like every other accommodation_* function it
-- should be callable by the service role only (the app's server code). 0065 revoked it from `public`, which does not
-- remove a grant made directly to a role; this removes those two. On a plain Postgres these roles hold no grant, so
-- the statement is then a no-op.
revoke execute on function accommodation_farm_closure_unit_ids() from anon, authenticated;
