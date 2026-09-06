-- Renames accommodation_people.phone -> mobile_number and adds real format
-- validation (see normalizeMobileNumber() in scripts/lib/accommodation.mjs,
-- the single source of truth for the actual validation/normalization logic
-- - this migration only adds a CHECK constraint asserting the *stored*
-- value already looks normalized, as a defense-in-depth backstop; the
-- "assume +91 when no country code is given" business logic lives in JS,
-- not SQL, and runs before a value ever reaches this table).
--
-- Also fixes a real bug found by Sharath asking "what happens when two
-- people share a mobile number?" (common for families/couples in India):
-- the old single-column unique index on phone meant the SECOND person
-- entered with that number silently overwrote the FIRST person's name
-- (upsert-by-phone treated one shared phone as one identity), and if both
-- were guests in the same booking, the guest-uniqueness constraint added
-- in 0010 would then reject the save entirely as a false "already booked"
-- conflict. Fix: the auto-match key becomes (mobile_number, name) together,
-- not mobile_number alone - two different-named people sharing a number
-- now become two separate person records; the true repeat-guest case (same
-- name, same number) still auto-resolves to the same row.

alter table accommodation_people rename column phone to mobile_number;

-- Existing rows predate normalization and were stored as raw client input
-- (e.g. "9886012670", not "+919886012670") - bring them in line with the
-- CHECK constraint being added below before it's added, not after.
update accommodation_people
set mobile_number = '+91' || regexp_replace(mobile_number, '\D', '', 'g')
where mobile_number is not null and mobile_number not like '+%';

alter table accommodation_people
  add constraint accommodation_people_mobile_number_format
  check (mobile_number is null or mobile_number ~ '^\+[1-9]\d{7,14}$');

drop index accommodation_people_phone_key;

create unique index accommodation_people_mobile_name_key
  on accommodation_people (mobile_number, (lower(btrim(name))))
  where mobile_number is not null;

-- CREATE OR REPLACE cannot rename a parameter even when its type is
-- unchanged (unlike 0008/0010's edits to accommodation_update_booking,
-- which only ever added new trailing parameters) - Postgres requires an
-- explicit drop first.
drop function accommodation_resolve_person(uuid, text, text, text, text);

create function accommodation_resolve_person(
  p_person_id uuid, p_name text, p_mobile_number text, p_gender text, p_preferences text
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_person_id is not null then
    update accommodation_people
    set name = p_name, mobile_number = coalesce(p_mobile_number, mobile_number), gender = coalesce(p_gender, gender),
        preferences = coalesce(p_preferences, preferences), updated_at = now()
    where id = p_person_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Guest not found' using errcode = 'PT404';
    end if;
    return v_id;
  end if;

  if p_mobile_number is not null then
    insert into accommodation_people (name, mobile_number, gender, preferences)
    values (p_name, p_mobile_number, p_gender, p_preferences)
    on conflict (mobile_number, (lower(btrim(name)))) where mobile_number is not null
    do update set name = excluded.name, gender = coalesce(excluded.gender, accommodation_people.gender),
      preferences = coalesce(excluded.preferences, accommodation_people.preferences), updated_at = now()
    returning id into v_id;
    return v_id;
  end if;

  insert into accommodation_people (name, gender, preferences)
  values (p_name, p_gender, p_preferences)
  returning id into v_id;
  return v_id;
end;
$$;

-- Reads the client's guest payload field as `mobileNumber` now, matching
-- the renamed column and the client/API contract change alongside this
-- migration (accommodation-calendar.astro, accommodation-admin.mts).
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

-- Audit snapshots are historical records - only future entries pick up the
-- renamed key, existing ones keep whatever field name they were written
-- with (harmless, they're immutable).
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

-- DROP FUNCTION above removed the grants 0007 set on this function
-- (anon/authenticated revoked, service_role granted) along with it - redo
-- them on the freshly-created function.
revoke execute on function accommodation_resolve_person(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function accommodation_resolve_person(uuid, text, text, text, text) to service_role;
alter function accommodation_resolve_person(uuid, text, text, text, text) set search_path = public, pg_temp;
alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
alter function accommodation_booking_snapshot(uuid) set search_path = public, pg_temp;
