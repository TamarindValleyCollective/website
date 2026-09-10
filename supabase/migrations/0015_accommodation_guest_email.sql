-- Adds an optional email address per guest (accommodation_people.email) -
-- Sharath asked for this so a future confirmation-email feature has
-- somewhere to read an address from; no sender/template exists yet, this
-- migration only captures the data. Same treatment as mobile_number/gender/
-- preferences: a person-level attribute, not part of the resolve-match key
-- (mobile_number + name stays the sole auto-match key, see 0011) - email is
-- pure passthrough, coalesced on update like gender/preferences already are.

alter table accommodation_people add column email text;

alter table accommodation_people
  add constraint accommodation_people_email_format
  check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Purely additive trailing parameter with a default - CREATE OR REPLACE is
-- safe here (unlike 0011's mobile_number rename, which needed an explicit
-- DROP first because it changed an existing parameter).
create or replace function accommodation_resolve_person(
  p_person_id uuid, p_name text, p_mobile_number text, p_gender text, p_preferences text, p_email text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_person_id is not null then
    update accommodation_people
    set name = p_name, mobile_number = coalesce(p_mobile_number, mobile_number), gender = coalesce(p_gender, gender),
        preferences = coalesce(p_preferences, preferences), email = coalesce(p_email, email), updated_at = now()
    where id = p_person_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Guest not found' using errcode = 'PT404';
    end if;
    return v_id;
  end if;

  if p_mobile_number is not null then
    insert into accommodation_people (name, mobile_number, gender, preferences, email)
    values (p_name, p_mobile_number, p_gender, p_preferences, p_email)
    on conflict (mobile_number, (lower(btrim(name)))) where mobile_number is not null
    do update set name = excluded.name, gender = coalesce(excluded.gender, accommodation_people.gender),
      preferences = coalesce(excluded.preferences, accommodation_people.preferences),
      email = coalesce(excluded.email, accommodation_people.email), updated_at = now()
    returning id into v_id;
    return v_id;
  end if;

  insert into accommodation_people (name, gender, preferences, email)
  values (p_name, p_gender, p_preferences, p_email)
  returning id into v_id;
  return v_id;
end;
$$;

-- Reads the client's guest payload field as `email` now, alongside the
-- existing fields - same accommodation-calendar.astro/accommodation-admin.mts
-- contract change this migration ships with.
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
        nullif(guest ->> 'mobileNumber', ''),
        nullif(guest ->> 'gender', ''),
        nullif(guest ->> 'preferences', ''),
        nullif(guest ->> 'email', '')
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

-- Audit snapshots are historical records - only future entries pick up the
-- new key, existing ones keep whatever shape they were written with
-- (harmless, they're immutable).
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
            'personId', g.person_id, 'name', p.name, 'mobileNumber', p.mobile_number,
            'gender', p.gender, 'ageGroup', g.age_group, 'preferences', p.preferences, 'email', p.email
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

alter function accommodation_resolve_person(uuid, text, text, text, text, text) set search_path = public, pg_temp;
alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
alter function accommodation_booking_snapshot(uuid) set search_path = public, pg_temp;
