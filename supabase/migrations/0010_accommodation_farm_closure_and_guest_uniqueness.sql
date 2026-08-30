-- Two gaps found in live testing, both fixed the same way as the original
-- double-booking bug: a real DB constraint instead of an app-level check.
--
-- 1. farm-closure conflict check: a farm-closure booking has zero tents
--    assigned (it blocks the whole farm conceptually, not any specific
--    tent), so it never populated v_tent_ids and skipped the conflict
--    check entirely - a farm-wide closure could be created over dates that
--    already had real bookings occupying specific tents. tent-closure
--    (unit-closure) has no equivalent gap: it does assign a specific tent,
--    so it already goes through the same accommodation_tent_assignments
--    EXCLUDE constraint as any other booking type.
--
-- 2. Guest uniqueness: nothing stopped the same person (accommodation_
--    people row) from being booked into two different tents - even two
--    different tents in the very same booking - on overlapping nights.
--    Mirrors the tent-level fix exactly: a stay_range column on
--    accommodation_guests (populated by trigger from its parent tent
--    assignment, same pattern as accommodation_tent_assignments' own
--    stay_range), plus an EXCLUDE constraint keyed on person_id.

-- ---- Guest uniqueness schema ----

alter table accommodation_guests add column stay_range daterange;

update accommodation_guests g
set stay_range = ta.stay_range
from accommodation_tent_assignments ta
where ta.id = g.tent_assignment_id;

alter table accommodation_guests alter column stay_range set not null;

create or replace function accommodation_set_guest_stay_range()
returns trigger language plpgsql as $$
begin
  select stay_range into new.stay_range from accommodation_tent_assignments where id = new.tent_assignment_id;
  return new;
end;
$$;

create trigger accommodation_guests_set_stay_range
  before insert on accommodation_guests
  for each row execute function accommodation_set_guest_stay_range();

-- The actual fix: two rows can't share a person_id with an overlapping
-- stay_range, checked atomically on every insert - no window for two
-- concurrent bookings (or two tents in one booking) to both claim the same
-- guest on the same night.
alter table accommodation_guests
  add constraint accommodation_guests_no_double_booking
  exclude using gist (person_id with =, stay_range with &&);

revoke execute on function accommodation_set_guest_stay_range() from public, anon, authenticated;
alter function accommodation_set_guest_stay_range() set search_path = public, pg_temp;

-- Names the other booking a person is already in on an overlapping night,
-- if any - the guest-level equivalent of accommodation_find_conflict.
-- Excludes the candidate's own booking so replacing a booking's own
-- tents/guests (delete-then-reinsert, same pattern as tent conflicts)
-- doesn't flag itself; a same-booking duplicate (this same guest assigned
-- to two different tents at once) still isn't caught by this lookup, since
-- both rows belong to the excluded booking - the EXCLUDE constraint itself
-- is what catches that case, as a backstop (see the updated exception
-- handling in accommodation_create_booking/accommodation_update_booking).
create or replace function accommodation_find_guest_conflict(p_exclude_booking_id uuid, p_person_id uuid, p_range daterange)
returns text language sql stable as $$
  select coalesce(b.label, b.event_title, b.type)
  from accommodation_guests g
  join accommodation_tent_assignments ta on ta.id = g.tent_assignment_id
  join accommodation_bookings b on b.id = ta.booking_id
  where (p_exclude_booking_id is null or ta.booking_id <> p_exclude_booking_id)
    and g.person_id = p_person_id
    and g.stay_range && p_range
  order by b.created_at
  limit 1;
$$;

revoke execute on function accommodation_find_guest_conflict(uuid, uuid, daterange) from public, anon, authenticated;
grant execute on function accommodation_find_guest_conflict(uuid, uuid, daterange) to service_role;
alter function accommodation_find_guest_conflict(uuid, uuid, daterange) set search_path = public, pg_temp;

-- Pre-checks each guest against accommodation_find_guest_conflict before
-- inserting (fast, correctly-named error in the common cross-booking
-- case), with the EXCLUDE constraint above as the race-proof backstop.
create or replace function accommodation_replace_tents(p_booking_id uuid, p_tents jsonb)
returns void language plpgsql as $$
declare
  tent jsonb;
  guest jsonb;
  new_tent_id uuid;
  resolved_person_id uuid;
  guest_seq integer;
  v_range daterange;
  v_guest_conflict_name text;
begin
  select stay_range into v_range from accommodation_bookings where id = p_booking_id;

  delete from accommodation_tent_assignments where booking_id = p_booking_id;
  for tent in select * from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb)) loop
    insert into accommodation_tent_assignments (booking_id, tent_id)
    values (p_booking_id, tent ->> 'tentId')
    returning id into new_tent_id;

    guest_seq := 0;
    for guest in select * from jsonb_array_elements(coalesce(tent -> 'guests', '[]'::jsonb)) loop
      resolved_person_id := accommodation_resolve_person(
        nullif(guest ->> 'personId', '')::uuid,
        guest ->> 'name',
        nullif(guest ->> 'phone', ''),
        nullif(guest ->> 'gender', ''),
        nullif(guest ->> 'preferences', '')
      );

      v_guest_conflict_name := accommodation_find_guest_conflict(p_booking_id, resolved_person_id, v_range);
      if v_guest_conflict_name is not null then
        raise exception 'This guest is already booked (%) on an overlapping night', v_guest_conflict_name using errcode = 'PT409';
      end if;

      insert into accommodation_guests (tent_assignment_id, person_id, seq, age_group)
      values (new_tent_id, resolved_person_id, guest_seq, guest ->> 'ageGroup');
      guest_seq := guest_seq + 1;
    end loop;
  end loop;
end;
$$;

alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;

-- ---- farm-closure conflict check + guest-conflict-aware exception
--      handling (both create/update_booking need the same two changes) ----

create or replace function accommodation_create_booking(
  p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean,
  p_start_date date, p_nights integer, p_note text, p_created_by text, p_tents jsonb
) returns accommodation_bookings language plpgsql as $$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
  v_constraint_name text;
begin
  if p_type = 'farm-closure' then
    v_tent_ids := array['malabar-1', 'malabar-2', 'banyan', 'portable-1', 'portable-2', 'portable-3', 'portable-4', 'portable-5'];
  else
    select array_agg(value ->> 'tentId') into v_tent_ids from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb));
  end if;

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
    get stacked diagnostics v_constraint_name = constraint_name;
    if v_constraint_name = 'accommodation_guests_no_double_booking' then
      raise exception 'This guest is assigned to more than one tent on an overlapping night' using errcode = 'PT409';
    else
      v_conflict_name := accommodation_find_conflict(v_booking.id, v_tent_ids, v_range);
      raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
    end if;
  end;

  return v_booking;
end;
$$;

create or replace function accommodation_update_booking(
  p_id uuid, p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean,
  p_start_date date, p_nights integer, p_note text, p_tents jsonb, p_updated_by text, p_reason text default null
) returns accommodation_bookings language plpgsql as $$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
  v_constraint_name text;
begin
  select * into v_booking from accommodation_bookings where id = p_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'PT404';
  end if;

  if upper(v_booking.stay_range) <= (now() at time zone 'Asia/Kolkata')::date and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'A reason is required to edit a past booking' using errcode = 'PT422';
  end if;

  if p_type = 'farm-closure' then
    v_tent_ids := array['malabar-1', 'malabar-2', 'banyan', 'portable-1', 'portable-2', 'portable-3', 'portable-4', 'portable-5'];
  else
    select array_agg(value ->> 'tentId') into v_tent_ids from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb));
  end if;

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
    get stacked diagnostics v_constraint_name = constraint_name;
    if v_constraint_name = 'accommodation_guests_no_double_booking' then
      raise exception 'This guest is assigned to more than one tent on an overlapping night' using errcode = 'PT409';
    else
      v_conflict_name := accommodation_find_conflict(p_id, v_tent_ids, v_range);
      raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
    end if;
  end;

  return v_booking;
end;
$$;

alter function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) set search_path = public, pg_temp;
alter function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb, text, text) set search_path = public, pg_temp;
