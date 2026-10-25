-- Accommodation: the bookable units become data. Step 2 of docs/plans/accommodation-calendar.md; the reasoning,
-- test plan and rollout are in docs/plans/accommodation-units-as-data.md.
--
-- Until now the unit list lived in code (ACCOMMODATION_UNITS) and in two places in the database: a CHECK on
-- accommodation_tent_assignments.tent_id and the farm-closure branch of accommodation_create_booking and
-- accommodation_update_booking, which spelled out every unit id. This migration:
--   * makes a unit's TYPE its pool (accommodation_unit_pools): Tents, Bamboo huts, Bring your own tent, and the four
--     member types (1 bedroom, 1 BHK, 2 BHK, 3 BHK);
--   * replaces `active` with a status (rentable, paused, offboarded) and adds who manages a unit, a member unit's
--     shape (whole or room), tags, a private note for the farm manager, and whether a whole-farm closure applies to it;
--   * turns the tent_id CHECK into a foreign key to accommodation_units;
--   * has the two booking functions read the closure's unit list from the table.
--
-- Safe to apply before the app change that reads these columns: the current app only ever sends the 14 existing unit
-- ids, which the foreign key accepts, and the closure list is the same 14 ids until a unit is added. Not auto-applied
-- on merge: apply this first, then merge the app change.
--
-- Rollback (kept here because it needs the pre-migration function bodies): see the block at the end of this file.

-- ------------------------------------------------------------------ types are pools
alter table accommodation_unit_pools
  add column owner_type text not null default 'tvc' check (owner_type in ('tvc', 'member')),
  add column sort_order integer not null default 0;

insert into accommodation_unit_pools (id, name, owner_type, sort_order) values
  ('tent', 'Tents', 'tvc', 1),
  ('hut', 'Bamboo huts', 'tvc', 2),
  ('byot', 'Bring your own tent', 'tvc', 3),
  ('1br', '1 bedroom', 'member', 4),
  ('1bhk', '1 BHK', 'member', 5),
  ('2bhk', '2 BHK', 'member', 6),
  ('3bhk', '3 BHK', 'member', 7)
on conflict (id) do update set owner_type = excluded.owner_type, sort_order = excluded.sort_order;

update accommodation_units
set pool_id = case when group_name = 'Bamboo Huts' then 'hut' when kind = 'byot' then 'byot' else 'tent' end
where pool_id is null and owner_type = 'tvc';

-- ------------------------------------------------------------------ unit fields
alter table accommodation_units
  add column status text not null default 'rentable' check (status in ('rentable', 'paused', 'offboarded')),
  -- Who runs the unit: TVC (the farm manager edits it) or the member who owns it. The farm manager only views
  -- a unit a member manages.
  add column manager text not null default 'tvc' check (manager in ('tvc', 'member')),
  -- A member unit is offered whole or as a single room; a TVC unit has no shape.
  add column listing_shape text check (listing_shape in ('whole', 'room')),
  add column cluster text,
  add column tags text[] not null default '{}',
  -- Private to the farm manager and admins; never sent to a member or a partner.
  add column note text,
  -- A whole-farm closure (and an exclusive booking) blocks every unit unless its member sets it to stay open:
  -- the common kitchen may be closed while a member's own kitchen is not.
  add column ignores_farm_closure boolean not null default false;

update accommodation_units set status = case when active then 'rentable' else 'offboarded' end;
alter table accommodation_units drop column active;
-- Kept as a generated column so the partner API's reads of `active` keep working: "not offboarded".
alter table accommodation_units add column active boolean generated always as (status <> 'offboarded') stored;

alter table accommodation_units
  add constraint accommodation_units_member_shape check ((owner_type = 'member') = (listing_shape is not null)),
  add constraint accommodation_units_member_manages check (manager = 'tvc' or owner_type = 'member');

-- ------------------------------------------------------------------ tent_id: CHECK -> foreign key
alter table accommodation_tent_assignments drop constraint accommodation_tent_assignments_tent_id_check;
alter table accommodation_tent_assignments
  add constraint accommodation_tent_assignments_unit_fk
  foreign key (tent_id) references accommodation_units (id) on update restrict on delete restrict;

-- ------------------------------------------------------------------ whole-farm closure reads the table
-- The units a new whole-farm closure must not collide with: every unit that has not been offboarded (a paused unit
-- can still hold a booking) and has not been set to stay open. A closure stores no tent rows; this list is only
-- used to refuse one that would overlap an existing booking.
create or replace function accommodation_farm_closure_unit_ids() returns text[]
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(array_agg(id order by sort_order, id), '{}'::text[])
  from accommodation_units
  where status <> 'offboarded' and not ignores_farm_closure
$$;
revoke execute on function accommodation_farm_closure_unit_ids() from public;
grant execute on function accommodation_farm_closure_unit_ids() to service_role;

-- Same bodies as the live functions, with the hardcoded id list replaced by the helper above.
create or replace function public.accommodation_create_booking(p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean, p_start_date date, p_nights integer, p_note text, p_created_by text, p_tents jsonb)
 returns accommodation_bookings
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
begin
  if p_type = 'farm-closure' then
    v_tent_ids := accommodation_farm_closure_unit_ids();
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
$function$;

create or replace function public.accommodation_update_booking(p_id uuid, p_type text, p_event_slug text, p_event_title text, p_label text, p_exclusive boolean, p_start_date date, p_nights integer, p_note text, p_tents jsonb, p_updated_by text, p_reason text default null::text)
 returns accommodation_bookings
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
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
    v_tent_ids := accommodation_farm_closure_unit_ids();
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
$function$;

-- ------------------------------------------------------------------ rollback
-- Run in this order if the migration has to be undone. Nothing the old app needs is removed, so this is rarely
-- necessary; it only matters if units beyond the original 14 have been added, which must be removed first.
--
--   1. Restore the two functions' closure branch to the literal list:
--        v_tent_ids := array['Tent01','Tent02','Tent03','Tent04','Tent05','Tent06','Tent07','Tent08','Tent09',
--                            'BYOT01','BYOT02','BYOT03','BYOT04','BYOT05'];
--      (re-run both create or replace statements above with that line in place of the call, then
--       drop function accommodation_farm_closure_unit_ids();)
--   2. alter table accommodation_tent_assignments drop constraint accommodation_tent_assignments_unit_fk;
--      alter table accommodation_tent_assignments add constraint accommodation_tent_assignments_tent_id_check
--        check (tent_id = any (array['Tent01','Tent02','Tent03','Tent04','Tent05','Tent06','Tent07','Tent08','Tent09',
--                                    'BYOT01','BYOT02','BYOT03','BYOT04','BYOT05']));
--   3. alter table accommodation_units drop constraint accommodation_units_member_shape,
--        drop constraint accommodation_units_member_manages;
--      alter table accommodation_units drop column active;
--      alter table accommodation_units add column active boolean not null default true;
--      update accommodation_units set active = (status <> 'offboarded');
--      alter table accommodation_units drop column status, drop column manager, drop column listing_shape,
--        drop column cluster, drop column tags, drop column note, drop column ignores_farm_closure;
--   4. update accommodation_units set pool_id = null where owner_type = 'tvc';
--      delete from accommodation_unit_pools where id in ('tent','hut','byot','1br','1bhk','2bhk','3bhk');
--      alter table accommodation_unit_pools drop column owner_type, drop column sort_order;
