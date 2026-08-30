-- Fixes the "Function Search Path Mutable" security advisory raised right
-- after 0005_accommodation_bookings.sql: none of that migration's functions
-- pinned search_path, leaving them resolvable against whatever schema a
-- caller's session search_path happens to include. All five are
-- SECURITY INVOKER (the default) and only reachable by service_role (see
-- 0005's REVOKE/GRANT), so the practical exposure was low, but pinning it
-- is free and removes the warning outright.
alter function accommodation_set_tent_assignment_stay_range() set search_path = public, pg_temp;
alter function accommodation_find_conflict(uuid, text[], daterange) set search_path = public, pg_temp;
alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
alter function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) set search_path = public, pg_temp;
alter function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb) set search_path = public, pg_temp;
