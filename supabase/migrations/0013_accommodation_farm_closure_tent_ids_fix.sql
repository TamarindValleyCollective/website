-- 0012 renamed every tent id (malabar-1/banyan/portable-N -> Tent01..Tent09)
-- but missed the hardcoded farm-closure tent-id array inside
-- accommodation_create_booking/accommodation_update_booking (added in 0010),
-- which conflict-checks a farm-closure booking against every tent since it
-- has no tents of its own. Left stale, this array never matches any real
-- tent_id (all now Tent01..Tent09) and is also missing Tent09 - a
-- farm-closure booking would silently skip conflict-checking against
-- existing per-tent bookings entirely. Only the `v_tent_ids := array[...]`
-- literal changes; everything else is byte-identical to 0010's definitions.

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
    v_tent_ids := array['Tent01', 'Tent02', 'Tent03', 'Tent04', 'Tent05', 'Tent06', 'Tent07', 'Tent08', 'Tent09'];
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
    v_tent_ids := array['Tent01', 'Tent02', 'Tent03', 'Tent04', 'Tent05', 'Tent06', 'Tent07', 'Tent08', 'Tent09'];
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
