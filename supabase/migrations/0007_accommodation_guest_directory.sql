-- Turns per-stay guests into a real, reusable directory (see
-- accommodation-admin.mts's guest-search/past-stays routes and
-- accommodation-calendar.astro's typeahead). Applied to the "TVC ERP"
-- Supabase project (mljavkvkxdejvpzadnrp).
--
-- gender moves onto the person record (stable per person, and phone-less
-- matching needs it on the identity being matched against); age_group stays
-- per-stay (a "Child" becomes an "Adult" over years - that's a fact about
-- the stay, not the person). name is dropped from accommodation_guests
-- entirely - display always joins through to accommodation_people.name, so
-- fixing a typo on the person record fixes every past-and-future display.
-- Corrective: 0005/0006 revoked these functions' EXECUTE "from public",
-- believing that closed access for anon/authenticated too. It didn't -
-- Supabase's default privileges grant EXECUTE on new public-schema
-- functions directly to anon/authenticated/service_role (not to the PUBLIC
-- pseudo-role), so `revoke ... from public` was a no-op for those three.
-- Verified this was never an actual authorization bypass (accommodation_*
-- tables have RLS enabled with zero policies, and anon/authenticated lack
-- the bypassrls role attribute service_role/postgres have - so any write or
-- read attempted through these functions by anon/authenticated was already
-- being denied at the table level), but it's sloppy defense-in-depth to
-- leave the unneeded grant sitting there, so closing it properly here.
revoke execute on function accommodation_create_booking(text, text, text, text, boolean, date, integer, text, text, jsonb) from anon, authenticated;
revoke execute on function accommodation_find_conflict(uuid, text[], daterange) from anon, authenticated;
revoke execute on function accommodation_set_tent_assignment_stay_range() from anon, authenticated;
-- accommodation_update_booking and accommodation_replace_tents are both
-- fully redefined below (this migration) / in 0008 - their corrected grants
-- are applied where each is (re)created instead of here.

create extension if not exists pg_trgm;

create table accommodation_people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  phone text,
  gender text check (gender in ('Male', 'Female', 'NA')),
  preferences text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial: two people can both have no phone on file, but never share one.
create unique index accommodation_people_phone_key on accommodation_people (phone) where phone is not null;
create index accommodation_people_name_trgm_idx on accommodation_people using gin (name gin_trgm_ops);

alter table accommodation_people enable row level security;
-- No policies - same posture as every other accommodation_* table: only
-- service_role (server-side only) can touch this.

-- Existing rows: the tables are currently empty (verified before writing
-- this migration - the only prior bookings were pre-migration test data,
-- already deleted), so this backfill has zero real rows to risk merging
-- incorrectly. Kept anyway so this migration is safe to rerun against a
-- non-empty accommodation_guests in the future without hand-editing it.
alter table accommodation_guests add column person_id uuid references accommodation_people (id);

insert into accommodation_people (name, gender)
select distinct name, gender from accommodation_guests;

update accommodation_guests g
set person_id = p.id
from accommodation_people p
where p.name = g.name and p.gender is not distinct from g.gender and g.person_id is null;

alter table accommodation_guests alter column person_id set not null;
alter table accommodation_guests drop column name;
alter table accommodation_guests drop column gender;

-- Single enforcement point for guest identity, called once per guest from
-- accommodation_replace_tents instead of that function inserting name/
-- gender directly:
--   personId given      -> update-and-return that row (write-through, so
--                           re-editing a known guest's phone/preferences
--                           while booking them again keeps the directory
--                           current);
--   no personId, phone  -> atomic upsert on the phone unique index
--   given               -> (race-safe under concurrent requests);
--   neither             -> plain insert of a new person.
-- Never auto-matches on name alone - that ambiguity is only ever surfaced
-- to a human via the search endpoint (see accommodation-admin.mts).
create or replace function accommodation_resolve_person(
  p_person_id uuid, p_name text, p_phone text, p_gender text, p_preferences text
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_person_id is not null then
    update accommodation_people
    set name = p_name, phone = coalesce(p_phone, phone), gender = coalesce(p_gender, gender),
        preferences = coalesce(p_preferences, preferences), updated_at = now()
    where id = p_person_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Guest not found' using errcode = 'PT404';
    end if;
    return v_id;
  end if;

  if p_phone is not null then
    insert into accommodation_people (name, phone, gender, preferences)
    values (p_name, p_phone, p_gender, p_preferences)
    on conflict (phone) where phone is not null
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

-- Replaces a booking's whole tent+guest set (delete-then-reinsert), matching
-- the client's "send the full tents[] array on every save" contract.
-- p_tents is the shape the client sends:
-- [{ tentId, guests: [{ personId?, name, phone?, ageGroup, gender?, preferences? }] }].
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
      insert into accommodation_guests (tent_assignment_id, person_id, seq, age_group)
      values (new_tent_id, resolved_person_id, guest_seq, guest ->> 'ageGroup');
      guest_seq := guest_seq + 1;
    end loop;
  end loop;
end;
$$;

-- See the corrective note at the top of this file - these need
-- anon/authenticated (not just PUBLIC) explicitly revoked, and service_role
-- explicitly granted, since both are only ever called internally from
-- accommodation_create_booking/accommodation_update_booking (SECURITY
-- INVOKER, so the calling role - service_role - needs its own direct
-- EXECUTE grant on every function it calls into, not just the outer one).
revoke execute on function accommodation_resolve_person(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function accommodation_replace_tents(uuid, jsonb) from public, anon, authenticated;
grant execute on function accommodation_resolve_person(uuid, text, text, text, text) to service_role;
grant execute on function accommodation_replace_tents(uuid, jsonb) to service_role;

alter function accommodation_resolve_person(uuid, text, text, text, text) set search_path = public, pg_temp;
alter function accommodation_replace_tents(uuid, jsonb) set search_path = public, pg_temp;
