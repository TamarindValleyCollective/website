-- Fixes a bug caught live-testing 0008: accommodation_bookings_audit_write
-- wrote lower(tg_op) as the action ('insert'/'update'), but
-- accommodation_booking_audit_log's action check constraint expects
-- 'create'/'update'/'delete' - every create failed outright.
create or replace function accommodation_bookings_audit_write()
returns trigger language plpgsql as $$
declare
  v_before jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
  else
    v_action := 'update';
    v_before := nullif(current_setting('accommodation.audit_before', true), '')::jsonb;
  end if;

  insert into accommodation_booking_audit_log (booking_id, action, actor, reason, before_snapshot, after_snapshot)
  values (
    new.id,
    v_action,
    coalesce(nullif(current_setting('accommodation.audit_actor', true), ''), 'unknown'),
    nullif(current_setting('accommodation.audit_reason', true), ''),
    v_before,
    accommodation_booking_snapshot(new.id)
  );
  return null;
end;
$$;

alter function accommodation_bookings_audit_write() set search_path = public, pg_temp;
