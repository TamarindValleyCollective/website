-- Durable audit trail for every booking create/update/delete, plus a
-- required, recorded reason whenever a booking whose stay has already
-- ended is edited or deleted. Applied to the "TVC ERP" Supabase project
-- (mljavkvkxdejvpzadnrp). Depends on 0007 (accommodation_people/person_id).

alter table accommodation_bookings add column updated_by text;

create table accommodation_booking_audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately no FK to accommodation_bookings: an audit row's entire
  -- purpose is to outlive the row it describes, including through a
  -- delete - a FK here would force an impossible choice between blocking
  -- the delete, losing the id, or cascading the audit row away with it.
  booking_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  actor text not null,
  occurred_at timestamptz not null default now(),
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb
);

create index accommodation_booking_audit_log_booking_id_idx on accommodation_booking_audit_log (booking_id);
create index accommodation_booking_audit_log_occurred_at_idx on accommodation_booking_audit_log (occurred_at);

alter table accommodation_booking_audit_log enable row level security;
-- No policies - same posture as every other accommodation_* table.

-- Full nested snapshot of one booking (fields + tents + guests, guests
-- joined through to accommodation_people for name/phone/gender/
-- preferences) - shared by every trigger below so "what did this booking
-- look like" is defined in exactly one place.
create or replace function accommodation_booking_snapshot(p_booking_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', b.id, 'type', b.type, 'eventSlug', b.event_slug, 'eventTitle', b.event_title,
    'label', b.label, 'exclusive', b.exclusive, 'startDate', b.start_date, 'nights', b.nights,
    'note', b.note, 'createdBy', b.created_by, 'updatedBy', b.updated_by,
    'tents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tentId', ta.tent_id,
        'guests', coalesce((
          select jsonb_agg(jsonb_build_object(
            'personId', g.person_id, 'name', p.name, 'phone', p.phone,
            'gender', p.gender, 'ageGroup', g.age_group, 'preferences', p.preferences
          ) order by g.seq)
          from accommodation_guests g
          join accommodation_people p on p.id = g.person_id
          where g.tent_assignment_id = ta.id
        ), '[]'::jsonb)
      ))
      from accommodation_tent_assignments ta where ta.booking_id = b.id
    ), '[]'::jsonb)
  )
  from accommodation_bookings b where b.id = p_booking_id;
$$;

-- accommodation_update_booking calls accommodation_replace_tents *after*
-- its own UPDATE, so a plain AFTER UPDATE trigger would snapshot stale
-- (pre-replace) tents. This BEFORE UPDATE trigger stashes the true "before"
-- state - fields and tents both still untouched at this point - into a
-- transaction-local setting; the deferred AFTER UPDATE trigger below reads
-- it back once replace_tents has actually finished.
create or replace function accommodation_bookings_audit_stash_before()
returns trigger language plpgsql as $$
begin
  perform set_config('accommodation.audit_before', accommodation_booking_snapshot(old.id)::text, true);
  return new;
end;
$$;

create trigger accommodation_bookings_audit_update_before
  before update on accommodation_bookings
  for each row execute function accommodation_bookings_audit_stash_before();

-- Writes the actual audit row for create/update. Fires no matter how the
-- write arrives (any future direct-table code path still gets logged, not
-- just RPC calls) - the same "can't be forgotten or bypassed" reasoning
-- that put the double-booking guard in a table constraint instead of app
-- code. Deferred so it runs at commit time, after accommodation_replace_tents
-- has populated the final tents/guests.
create or replace function accommodation_bookings_audit_write()
returns trigger language plpgsql as $$
declare
  v_before jsonb;
begin
  if tg_op = 'UPDATE' then
    v_before := nullif(current_setting('accommodation.audit_before', true), '')::jsonb;
  end if;

  insert into accommodation_booking_audit_log (booking_id, action, actor, reason, before_snapshot, after_snapshot)
  values (
    new.id,
    lower(tg_op)::text,
    coalesce(nullif(current_setting('accommodation.audit_actor', true), ''), 'unknown'),
    nullif(current_setting('accommodation.audit_reason', true), ''),
    v_before,
    accommodation_booking_snapshot(new.id)
  );
  return null;
end;
$$;

create constraint trigger accommodation_bookings_audit_insert
  after insert on accommodation_bookings
  deferrable initially deferred
  for each row execute function accommodation_bookings_audit_write();

create constraint trigger accommodation_bookings_audit_update
  after update on accommodation_bookings
  deferrable initially deferred
  for each row execute function accommodation_bookings_audit_write();

-- Delete has nothing to wait for (no replace_tents call follows it), and
-- must run *before* the row (and its cascaded tents/guests) disappear -
-- ON DELETE CASCADE fires as a referential-action trigger after this one,
-- so tents/guests are still intact when the snapshot runs.
create or replace function accommodation_bookings_audit_delete()
returns trigger language plpgsql as $$
begin
  insert into accommodation_booking_audit_log (booking_id, action, actor, reason, before_snapshot, after_snapshot)
  values (
    old.id, 'delete',
    coalesce(nullif(current_setting('accommodation.audit_actor', true), ''), 'unknown'),
    nullif(current_setting('accommodation.audit_reason', true), ''),
    accommodation_booking_snapshot(old.id), null
  );
  return old;
end;
$$;

create trigger accommodation_bookings_audit_delete_trigger
  before delete on accommodation_bookings
  for each row execute function accommodation_bookings_audit_delete();

-- Records the actor for a create too (accommodation_create_booking's
-- signature is unchanged, so CREATE OR REPLACE genuinely replaces it here -
-- no DROP needed, unlike accommodation_update_booking below).
create or replace function accommodation_create_booking(
  p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean,
  p_start_date date, p_nights integer, p_note text, p_created_by text, p_tents jsonb
) returns accommodation_bookings language plpgsql as $$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
begin
  select array_agg(value ->> 'tentId') into v_tent_ids from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb));

  if v_tent_ids is not null then
    v_conflict_name := accommodation_find_conflict(null, v_tent_ids, v_range);
    if v_conflict_name is not null then
      raise exception 'Conflicts with an existing booking (%) on a shared tent/night', v_conflict_name using errcode = 'PT409';
    end if;
  end if;

  perform set_config('accommodation.audit_actor', p_created_by, true);

  insert into accommodation_bookings (type, event_slug, event_title, label, exclusive, start_date, nights, note, created_by)
  values (p_type, p_event_slug, p_event_title, p_label, coalesce(p_exclusive, false), p_start_date, p_nights, p_note, p_created_by)
  returning * into v_booking;

  begin
    perform accommodation_replace_tents(v_booking.id, p_tents);
  exception when exclusion_violation then
    v_conflict_name := accommodation_find_conflict(v_booking.id, v_tent_ids, v_range);
    raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
  end;

  return v_booking;
end;
$$;

-- accommodation_update_booking's signature is changing (two new params) -
-- CREATE OR REPLACE does not replace a function whose argument types
-- differ (Postgres identifies functions by name *and* arg types), so
-- without this explicit DROP the old, reason-free 10-arg version would
-- stay live and callable alongside the new one, making the whole
-- justification requirement silently bypassable.
drop function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb);

-- "Past" = the stay has already ended (upper(stay_range) <= today), not
-- "start_date is before today" - a currently-in-progress multi-night stay
-- stays freely editable until its last night has elapsed. Uses IST
-- explicitly rather than bare current_date, since this project's default
-- session timezone is UTC and the farm is a single site in India.
create or replace function accommodation_update_booking(
  p_id uuid, p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean,
  p_start_date date, p_nights integer, p_note text, p_tents jsonb, p_updated_by text, p_reason text default null
) returns accommodation_bookings language plpgsql as $$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
begin
  select * into v_booking from accommodation_bookings where id = p_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'PT404';
  end if;

  if upper(v_booking.stay_range) <= (now() at time zone 'Asia/Kolkata')::date and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'A reason is required to edit a past booking' using errcode = 'PT422';
  end if;

  select array_agg(value ->> 'tentId') into v_tent_ids from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb));

  if v_tent_ids is not null then
    v_conflict_name := accommodation_find_conflict(p_id, v_tent_ids, v_range);
    if v_conflict_name is not null then
      raise exception 'Conflicts with an existing booking (%) on a shared tent/night', v_conflict_name using errcode = 'PT409';
    end if;
  end if;

  perform set_config('accommodation.audit_actor', p_updated_by, true);
  perform set_config('accommodation.audit_reason', coalesce(p_reason, ''), true);

  update accommodation_bookings set
    type = p_type, event_slug = p_event_slug, event_title = p_event_title, label = p_label,
    exclusive = coalesce(p_exclusive, false), start_date = p_start_date, nights = p_nights,
    note = p_note, updated_by = p_updated_by, updated_at = now()
  where id = p_id
  returning * into v_booking;

  begin
    perform accommodation_replace_tents(p_id, p_tents);
  exception when exclusion_violation then
    v_conflict_name := accommodation_find_conflict(p_id, v_tent_ids, v_range);
    raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
  end;

  return v_booking;
end;
$$;

-- Replaces today's raw PostgREST `DELETE .../accommodation_bookings?id=eq.<id>`
-- (scripts/lib/accommodation-db.mjs's deleteBooking) - there was previously
-- nowhere server-side to require or record a delete reason. Known, accepted
-- gap: service_role still has raw table DML privilege that bypasses this
-- RPC's past-check (unlike the audit log above, which the trigger makes
-- bypass-proof regardless of write path) - closing that fully would mean
-- SECURITY DEFINER + revoking direct table DML from service_role, a bigger
-- trust-boundary change deferred as a deliberate later step. For now,
-- enforcement is "nothing in accommodation-db.mjs issues a raw delete
-- against this table anymore" (see the Netlify Function change alongside
-- this migration).
create or replace function accommodation_delete_booking(p_id uuid, p_deleted_by text, p_reason text default null)
returns void language plpgsql as $$
declare
  v_booking accommodation_bookings;
begin
  select * into v_booking from accommodation_bookings where id = p_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'PT404';
  end if;

  if upper(v_booking.stay_range) <= (now() at time zone 'Asia/Kolkata')::date and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'A reason is required to delete a past booking' using errcode = 'PT422';
  end if;

  perform set_config('accommodation.audit_actor', p_deleted_by, true);
  perform set_config('accommodation.audit_reason', coalesce(p_reason, ''), true);

  delete from accommodation_bookings where id = p_id;
end;
$$;

revoke execute on function accommodation_booking_snapshot(uuid) from public, anon, authenticated;
revoke execute on function accommodation_bookings_audit_stash_before() from public, anon, authenticated;
revoke execute on function accommodation_bookings_audit_write() from public, anon, authenticated;
revoke execute on function accommodation_bookings_audit_delete() from public, anon, authenticated;
revoke execute on function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) from anon, authenticated;
revoke execute on function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb, text, text) from public, anon, authenticated;
revoke execute on function accommodation_delete_booking(uuid, text, text) from public, anon, authenticated;

grant execute on function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb, text, text) to service_role;
grant execute on function accommodation_delete_booking(uuid, text, text) to service_role;
-- The audit_* trigger functions themselves need no service_role grant:
-- Postgres doesn't apply an EXECUTE check to a trigger's own firing (only
-- CREATE TRIGGER itself required privilege on the function). But those
-- trigger functions are SECURITY INVOKER (the default) and run as whichever
-- role's DML fired them - service_role, here - so the plain function call
-- to accommodation_booking_snapshot *inside* their bodies is a normal,
-- privilege-checked call and does need its own grant.
grant execute on function accommodation_booking_snapshot(uuid) to service_role;

alter function accommodation_booking_snapshot(uuid) set search_path = public, pg_temp;
alter function accommodation_bookings_audit_stash_before() set search_path = public, pg_temp;
alter function accommodation_bookings_audit_write() set search_path = public, pg_temp;
alter function accommodation_bookings_audit_delete() set search_path = public, pg_temp;
alter function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) set search_path = public, pg_temp;
alter function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb, text, text) set search_path = public, pg_temp;
alter function accommodation_delete_booking(uuid, text, text) set search_path = public, pg_temp;
