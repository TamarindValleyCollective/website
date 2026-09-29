-- 0010's "no double booking" guest-uniqueness constraint (person_id +
-- overlapping stay_range) was built to catch an admin accidentally entering
-- the same guest into two tents by mistake. Sharath (2026-09-29): a real
-- family of 4 booked across two tents, with only one contact number/name
-- available for the whole family - accommodation_resolve_person's
-- (mobile_number, lower(name)) match key resolves every tent's guest entry
-- to the exact same person row in that case, so the same-person-twice guard
-- built for a data-entry mistake was blocking a genuinely intentional,
-- ordinary booking. There's no way to tell "duplicate by mistake" apart
-- from "duplicate on purpose" from the data alone, and false positives on a
-- routine booking shape are worse than losing the guard - so this drops it
-- outright rather than adding an override flag for what turns out to be the
-- common case, not the edge case.
--
-- The tent-level equivalent (accommodation_tent_assignments_no_overlap,
-- 0005) stays untouched - that one's a real physical constraint (a tent
-- can't hold two different bookings on the same night), not a heuristic.

alter table accommodation_guests
  drop constraint accommodation_guests_no_double_booking;

-- Byte-identical to 0017's version except dropping the
-- accommodation_find_guest_conflict check/raise - the guest-level conflict
-- is no longer treated as an error at all, per the constraint drop above.
create or replace function accommodation_replace_tents(p_booking_id uuid, p_tents jsonb)
returns void language plpgsql as $$
declare
  tent jsonb;
  guest jsonb;
  new_tent_id uuid;
  resolved_person_id uuid;
  guest_seq integer;
begin
  delete from accommodation_tent_assignments where booking_id = p_booking_id;
  for tent in select * from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb)) loop
    insert into accommodation_tent_assignments (booking_id, tent_id, solo)
    values (p_booking_id, tent ->> 'tentId', coalesce((tent ->> 'solo')::boolean, false))
    returning id into new_tent_id;

    guest_seq := 0;
    for guest in select * from jsonb_array_elements(coalesce(tent -> 'guests', '[]'::jsonb)) loop
      resolved_person_id := accommodation_resolve_person(
        nullif(guest ->> 'personId', '')::uuid,
        guest ->> 'name',
        nullif(guest ->> 'mobileNumber', ''),
        nullif(guest ->> 'gender', ''),
        nullif(guest ->> 'preferences', ''),
        nullif(guest ->> 'email', '')
      );

      insert into accommodation_guests (tent_assignment_id, person_id, seq, age_group)
      values (new_tent_id, resolved_person_id, guest_seq, guest ->> 'ageGroup');
      guest_seq := guest_seq + 1;
    end loop;
  end loop;
end;
$$;

-- Byte-identical to 0016's versions except the exclusion_violation handler:
-- the tent-level EXCLUDE constraint is now the only one that can raise it
-- (the guest-level one is gone), so the constraint-name branch it used to
-- pick between is dead - simplified down to the one case left.
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
  if p_type = 'farm-closure' then
    v_tent_ids := array['Tent01', 'Tent02', 'Tent03', 'Tent04', 'Tent05', 'Tent06', 'Tent07', 'Tent08', 'Tent09', 'BYOT01', 'BYOT02', 'BYOT03', 'BYOT04', 'BYOT05'];
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
    v_conflict_name := accommodation_find_conflict(v_booking.id, v_tent_ids, v_range);
    raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
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
begin
  select * into v_booking from accommodation_bookings where id = p_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'PT404';
  end if;

  if upper(v_booking.stay_range) <= (now() at time zone 'Asia/Kolkata')::date and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'A reason is required to edit a past booking' using errcode = 'PT422';
  end if;

  if p_type = 'farm-closure' then
    v_tent_ids := array['Tent01', 'Tent02', 'Tent03', 'Tent04', 'Tent05', 'Tent06', 'Tent07', 'Tent08', 'Tent09', 'BYOT01', 'BYOT02', 'BYOT03', 'BYOT04', 'BYOT05'];
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
    v_conflict_name := accommodation_find_conflict(p_id, v_tent_ids, v_range);
    raise exception 'Conflicts with an existing booking (%) on a shared tent/night', coalesce(v_conflict_name, 'another booking') using errcode = 'PT409';
  end;

  return v_booking;
end;
$$;

-- accommodation_find_guest_conflict (0010) has no remaining callers now
-- that accommodation_replace_tents no longer uses it.
drop function accommodation_find_guest_conflict(uuid, uuid, daterange);

alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
alter function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) set search_path = public, pg_temp;
alter function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb, text, text) set search_path = public, pg_temp;
