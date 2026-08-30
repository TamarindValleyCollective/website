-- Accommodation-calendar prototype (see accommodation-admin.mts,
-- accommodation-availability.mts, ARCHITECTURE.md's SUPABASE node). Applied
-- to the "TVC ERP" Supabase project (mljavkvkxdejvpzadnrp) — table names are
-- accommodation_-prefixed since that project is shared/multi-purpose, same
-- as whatsapp_* in 0001_whatsapp_reply_admin.sql.
--
-- Replaces a Netlify Blobs-backed read-then-check-then-write conflict check
-- (eventual consistency let two bookings claim the same tent/night 38s
-- apart in live testing) with a real DB guarantee: the EXCLUDE constraint on
-- accommodation_tent_assignments makes an overlapping tent/night booking
-- physically impossible to insert, checked atomically by Postgres itself.
create extension if not exists btree_gist;

create table accommodation_bookings (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('public-event', 'private-event', 'casual-stay', 'member-stay', 'unit-closure', 'farm-closure')),
  event_slug text,
  event_title text,
  label text,
  exclusive boolean not null default false,
  start_date date not null,
  nights integer not null check (nights >= 1),
  -- Half-open range covering exactly what nightsForBooking() computes in
  -- accommodation.mjs: [start_date, start_date + nights). Postgres's two-arg
  -- daterange() already defaults to '[)' bounds.
  stay_range daterange generated always as (daterange(start_date, start_date + nights)) stored,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accommodation_bookings_event_slug_required
    check (type <> 'public-event' or event_slug is not null)
);

create index accommodation_bookings_stay_range_idx on accommodation_bookings using gist (stay_range);

create table accommodation_tent_assignments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references accommodation_bookings (id) on delete cascade,
  tent_id text not null check (
    tent_id in ('malabar-1', 'malabar-2', 'banyan', 'portable-1', 'portable-2', 'portable-3', 'portable-4', 'portable-5')
  ),
  -- Denormalized copy of the parent's stay_range, kept in sync by the
  -- trigger below rather than trusted from callers - EXCLUDE constraints
  -- can only see columns on their own table, so this can't be a join.
  stay_range daterange not null,
  -- The actual fix: two rows can't share a tent_id with an overlapping
  -- stay_range, enforced atomically on every insert/update - no read-then-
  -- write window for two concurrent requests to both slip through.
  constraint accommodation_tent_assignments_no_overlap
    exclude using gist (tent_id with =, stay_range with &&)
);

create index accommodation_tent_assignments_booking_id_idx on accommodation_tent_assignments (booking_id);

create or replace function accommodation_set_tent_assignment_stay_range()
returns trigger language plpgsql as $$
begin
  select daterange(start_date, start_date + nights) into new.stay_range
  from accommodation_bookings where id = new.booking_id;
  return new;
end;
$$;

create trigger accommodation_tent_assignments_set_stay_range
  before insert on accommodation_tent_assignments
  for each row execute function accommodation_set_tent_assignment_stay_range();

create table accommodation_guests (
  id uuid primary key default gen_random_uuid(),
  tent_assignment_id uuid not null references accommodation_tent_assignments (id) on delete cascade,
  seq integer not null default 0, -- preserves the client's original guests[] order on read-back
  name text not null check (btrim(name) <> ''),
  age_group text not null check (age_group in ('Adult', 'Child')),
  gender text not null check (gender in ('Male', 'Female', 'NA'))
);

create index accommodation_guests_tent_assignment_id_idx on accommodation_guests (tent_assignment_id);

alter table accommodation_bookings enable row level security;
alter table accommodation_tent_assignments enable row level security;
alter table accommodation_guests enable row level security;
-- No policies on any of the three tables: RLS enabled with zero policies
-- denies all access to anon/authenticated roles (same as whatsapp_* in
-- 0001). Only the service_role key - used exclusively server-side by
-- Netlify Functions, never shipped to the browser - bypasses RLS.

-- Names the booking a candidate tent/night set conflicts with, if any -
-- shared by both write functions below (pre-check) and their exception
-- handlers (post-race lookup, once the winning row has committed).
-- p_exclude_booking_id lets an update ignore the booking's own existing rows.
create or replace function accommodation_find_conflict(p_exclude_booking_id uuid, p_tent_ids text[], p_range daterange)
returns text language sql stable as $$
  select coalesce(b.label, b.event_title, b.type)
  from accommodation_tent_assignments ta
  join accommodation_bookings b on b.id = ta.booking_id
  where (p_exclude_booking_id is null or ta.booking_id <> p_exclude_booking_id)
    and ta.tent_id = any (p_tent_ids)
    and ta.stay_range && p_range
  order by b.created_at
  limit 1;
$$;

-- Replaces a booking's whole tent+guest set (delete-then-reinsert), matching
-- the client's "send the full tents[] array on every save" contract.
-- p_tents is the exact shape the client sends:
-- [{ tentId, guests: [{ name, ageGroup, gender }] }].
create or replace function accommodation_replace_tents(p_booking_id uuid, p_tents jsonb)
returns void language plpgsql as $$
declare
  tent jsonb;
  new_tent_id uuid;
begin
  delete from accommodation_tent_assignments where booking_id = p_booking_id;
  for tent in select * from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb)) loop
    insert into accommodation_tent_assignments (booking_id, tent_id)
    values (p_booking_id, tent ->> 'tentId')
    returning id into new_tent_id;

    insert into accommodation_guests (tent_assignment_id, seq, name, age_group, gender)
    select new_tent_id, ord - 1, g ->> 'name', g ->> 'ageGroup', g ->> 'gender'
    from jsonb_array_elements(coalesce(tent -> 'guests', '[]'::jsonb)) with ordinality as t (g, ord);
  end loop;
end;
$$;

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
  p_start_date date, p_nights integer, p_note text, p_tents jsonb
) returns accommodation_bookings language plpgsql as $$
declare
  v_booking accommodation_bookings;
  v_tent_ids text[];
  v_range daterange := daterange(p_start_date, p_start_date + p_nights);
  v_conflict_name text;
begin
  if not exists (select 1 from accommodation_bookings where id = p_id) then
    raise exception 'Booking not found' using errcode = 'PT404';
  end if;

  select array_agg(value ->> 'tentId') into v_tent_ids from jsonb_array_elements(coalesce(p_tents, '[]'::jsonb));

  if v_tent_ids is not null then
    v_conflict_name := accommodation_find_conflict(p_id, v_tent_ids, v_range);
    if v_conflict_name is not null then
      raise exception 'Conflicts with an existing booking (%) on a shared tent/night', v_conflict_name using errcode = 'PT409';
    end if;
  end if;

  update accommodation_bookings set
    type = p_type, event_slug = p_event_slug, event_title = p_event_title, label = p_label,
    exclusive = coalesce(p_exclusive, false), start_date = p_start_date, nights = p_nights,
    note = p_note, updated_at = now()
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

-- PostgREST auto-exposes every function in this schema as an rpc/<name>
-- endpoint regardless of intent, so the helpers need PUBLIC's default
-- execute grant revoked explicitly - RLS on the tables would still block
-- anon/authenticated from writing through them, but this closes it at the
-- RPC layer too, and matches the "only service_role touches this" posture
-- the table-level RLS-with-zero-policies already establishes.
revoke execute on function accommodation_find_conflict(uuid, text[], daterange) from public;
revoke execute on function accommodation_replace_tents(uuid, jsonb) from public;
revoke execute on function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) from public;
revoke execute on function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb) from public;

grant execute on function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) to service_role;
grant execute on function accommodation_update_booking(uuid, text, text, text, text, boolean, date, integer, text, jsonb) to service_role;
