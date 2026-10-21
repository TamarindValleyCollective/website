-- Member portal: members book their own stays (netlify/functions/members-me.mts,
-- /api/members-me/stays*). The booking itself is an ordinary `member-stay` row in
-- accommodation_bookings, created through the same accommodation_create_booking RPC the
-- admin calendar uses, so tent conflicts are still enforced by the EXCLUDE constraint.
-- The member does not choose tents: the booking is created with no tents and Madhavan allocates
-- them in the calendar. This table adds what the calendar does not know: which household booked
-- it, who clicked, who is coming (names and adult/child only; `party`), and how many are paying
-- guests (not family) for the pricing step. A booking with no tents yet is "waiting", and its
-- party_size is taken off what the next member is told is free.
--
-- portal_settings holds portal-wide values that admins change without a deploy. Seeded with
-- the guest discount (Sharath, 2026-10-21): paying guests get 20% off the guest rate.
-- Server-side only, like every member_* table: RLS on, no policies.
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying the code.

create table portal_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table portal_settings enable row level security;
revoke all on portal_settings from anon, authenticated;

insert into portal_settings (key, value) values ('guest_discount_percent', '20'::jsonb);

create table member_stays (
  booking_id uuid primary key references accommodation_bookings (id) on delete cascade,
  household_id uuid not null references member_households (id),
  requested_by uuid not null references member_people (id),
  party_size integer not null check (party_size >= 1),
  party jsonb not null,
  guest_count integer not null default 0 check (guest_count >= 0),
  created_at timestamptz not null default now()
);
create index member_stays_household_idx on member_stays (household_id);
alter table member_stays enable row level security;
revoke all on member_stays from anon, authenticated;

-- The people on a member's booking, linked to the SAME guest directory (accommodation_people) that tent
-- allocation uses, before any tent exists. When Madhavan allocates tents the calendar prefills these people,
-- so they become ordinary guests on tents (accommodation_guests) with the same person row, and a guest's
-- past stays (listStaysForPerson) include a stay that is still waiting for tents. One row per person per
-- booking; seq keeps the order the member listed them.
--
-- `capacity` is how THIS person came on THIS stay, not a property of the person: the same directory person can
-- come as an event participant or a Linger guest (the booking's own type says which), as a guest of a member, as
-- a member, or as member family, in any order over the years, and stays one person. 'member' = an owner on the
-- register, 'member_family' = a family or non-owner member on the register, 'member_guest' = not on the register,
-- so a paying guest of the member who booked (member_stays.household_id says whose).
create table accommodation_booking_party (
  booking_id uuid not null references accommodation_bookings (id) on delete cascade,
  person_id uuid not null references accommodation_people (id),
  seq integer not null default 0,
  age_group text not null check (age_group in ('Adult', 'Child')),
  capacity text not null check (capacity in ('member', 'member_family', 'member_guest')),
  primary key (booking_id, person_id)
);
create index accommodation_booking_party_person_idx on accommodation_booking_party (person_id);
alter table accommodation_booking_party enable row level security;
revoke all on accommodation_booking_party from anon, authenticated;

-- ONE PERSON, WHATEVER THEIR ROLE. The guest directory (accommodation_people) is the single record of everyone
-- who stays: a guest, a member, or someone who was a guest and later joined as a member. A directory person may be
-- linked to a member record (member_person_id), so allocation, past stays, allergies and notices follow the same
-- person across both roles. The link is made only on mobile number + name or email + name (the directory never
-- merges on name alone), by accommodation_link_member below: when a member books in the portal, when an admin adds
-- or edits a member, and once now for every existing member.
alter table accommodation_people add column member_person_id uuid references member_people (id) on delete set null;
create unique index accommodation_people_member_key on accommodation_people (member_person_id) where member_person_id is not null;

-- Phone numbers are compared by their last ten digits, so "98450 12345", "+919845012345" and "09845012345" agree.
create function accommodation_phone_key(p text) returns text language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

-- The directory person who is this member but is not yet linked: same name AND the same mobile or email.
create function accommodation_find_member_match(p_name text, p_mobile text, p_email text) returns uuid
language sql stable as $$
  select id from accommodation_people
  where member_person_id is null
    and lower(btrim(name)) = lower(btrim(p_name))
    and ((accommodation_phone_key(p_mobile) is not null and accommodation_phone_key(mobile_number) = accommodation_phone_key(p_mobile))
      or (p_email is not null and lower(email) = lower(p_email)))
  order by created_at
  limit 1;
$$;

-- Links a member to their existing directory person (the one already linked, else the one that matches), and
-- returns it. Returns null when they have never stayed: no row is made here, so the directory only holds people
-- who stay.
create function accommodation_link_member(p_member_person_id uuid) returns uuid
language plpgsql as $$
declare
  v_member member_people;
  v_id uuid;
begin
  select id into v_id from accommodation_people where member_person_id = p_member_person_id;
  if v_id is not null then
    return v_id;
  end if;
  select * into v_member from member_people where id = p_member_person_id and active;
  if not found then
    return null;
  end if;
  v_id := accommodation_find_member_match(v_member.full_name, v_member.phone, v_member.email);
  if v_id is not null then
    update accommodation_people set member_person_id = p_member_person_id, updated_at = now() where id = v_id;
  end if;
  return v_id;
end;
$$;

-- Finds or creates a directory person for someone on a member's booking. A MEMBER (p_member_person_id) is
-- always the one directory person linked to them: found by the link, else adopted from an earlier stay as a guest,
-- else created and linked, and any contact the directory lacks is filled from what we hold. A GUEST matches on
-- mobile number + name exactly as tent allocation does (accommodation_resolve_person); with only an email, on
-- email + name, never on name alone (two different people can share a name); with no contact, a new row.
create function accommodation_resolve_booking_person(
  p_name text, p_mobile_number text, p_email text, p_gender text, p_preferences text, p_member_person_id uuid default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_member_person_id is not null then
    v_id := accommodation_link_member(p_member_person_id);
    if v_id is null then
      v_id := accommodation_resolve_person(null, p_name, p_mobile_number, p_gender, p_preferences, p_email);
      update accommodation_people set member_person_id = p_member_person_id where id = v_id and member_person_id is null;
    end if;
    update accommodation_people
    set gender = coalesce(p_gender, gender),
        preferences = coalesce(p_preferences, preferences),
        email = coalesce(email, p_email),
        mobile_number = case
          when mobile_number is null and p_mobile_number is not null
            and not exists (select 1 from accommodation_people o where o.id <> v_id and o.mobile_number = p_mobile_number and lower(btrim(o.name)) = lower(btrim(accommodation_people.name)))
          then p_mobile_number else mobile_number end,
        updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  if p_mobile_number is null and p_email is not null then
    select id into v_id
    from accommodation_people
    where mobile_number is null
      and lower(btrim(name)) = lower(btrim(p_name))
      and lower(email) = lower(p_email)
    order by created_at
    limit 1;
    if v_id is not null then
      update accommodation_people
      set gender = coalesce(p_gender, gender), preferences = coalesce(p_preferences, preferences), updated_at = now()
      where id = v_id;
      return v_id;
    end if;
  end if;
  return accommodation_resolve_person(null, p_name, p_mobile_number, p_gender, p_preferences, p_email);
end;
$$;

-- Everyone who is already a member and has already stayed is linked now.
do $$
declare
  r record;
begin
  for r in select id from member_people where active loop
    perform accommodation_link_member(r.id);
  end loop;
end $$;

alter function accommodation_phone_key(text) set search_path = public, pg_temp;
alter function accommodation_find_member_match(text, text, text) set search_path = public, pg_temp;
alter function accommodation_link_member(uuid) set search_path = public, pg_temp;
alter function accommodation_resolve_booking_person(text, text, text, text, text, uuid) set search_path = public, pg_temp;
revoke execute on function accommodation_link_member(uuid) from public, anon, authenticated;
grant execute on function accommodation_link_member(uuid) to service_role;
revoke execute on function accommodation_resolve_booking_person(text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function accommodation_resolve_booking_person(text, text, text, text, text, uuid) to service_role;
