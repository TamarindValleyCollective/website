-- Persists the booking form's "Family Booking" checkbox (added 2026-09-10,
-- see 0005's accommodation_tent_assignments and accommodation-calendar.astro's
-- effectiveCapacity) instead of always resetting it to unchecked on load.
-- Originally deliberately non-persisted - the reasoning was "a booking that
-- ends up with exactly 1 guest already fully captures the outcome" - but
-- Sharath reported that as a bug (2026-09-15): reopening a saved solo/family
-- booking silently reopens the tent back up to its full physical capacity,
-- which reads as the checkbox itself failing to save rather than "working as
-- intended." A real column removes the ambiguity.

alter table accommodation_tent_assignments add column solo boolean not null default false;

-- Reads the client's guest payload's new `solo` key alongside the existing
-- ones - same accommodation-calendar.astro/accommodation-admin.mts contract
-- change this migration ships with. Byte-identical to 0015's version except
-- the `solo` column on the insert.
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

-- Audit snapshots gain the new key going forward - existing rows keep
-- whatever shape they were written with (harmless, they're immutable).
create or replace function accommodation_booking_snapshot(p_booking_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', b.id, 'type', b.type, 'eventSlug', b.event_slug, 'eventTitle', b.event_title,
    'label', b.label, 'exclusive', b.exclusive, 'startDate', b.start_date, 'nights', b.nights,
    'note', b.note, 'createdBy', b.created_by, 'updatedBy', b.updated_by,
    'tents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tentId', ta.tent_id,
        'solo', ta.solo,
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

alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
alter function accommodation_booking_snapshot(uuid) set search_path = public, pg_temp;
