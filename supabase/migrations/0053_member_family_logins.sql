-- Member portal: family members who can sign in, added by an owner.
--
-- 0040 capped sign-in at two people per household in total (member + spouse /
-- co-owner). Family members now sign in too, with fewer rights (members-me.mts
-- checks the role), so the cap becomes two per group: at most two owners (or
-- non-owners) and, separately, at most two family members. Existing data was
-- already at most two in total, so it satisfies both.
--
-- A third family member is not refused outright: an owner asks for one, and
-- the request waits here for the core team (member_family_requests).

create or replace function member_household_members_max_two_logins() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.can_login and (
    select count(*) from public.member_household_members
    where household_id = new.household_id and can_login and person_id <> new.person_id
      and (role = 'family') = (new.role = 'family')
  ) >= 2 then
    raise exception 'a household can have at most 2 owners and 2 family members who can sign in';
  end if;
  return new;
end;
$$;

drop trigger member_household_members_max_two_logins on member_household_members;
create trigger member_household_members_max_two_logins
  before insert or update of can_login, role on member_household_members
  for each row execute function member_household_members_max_two_logins();

create table member_family_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  requested_by uuid references member_people (id) on delete set null,
  full_name text not null check (btrim(full_name) <> ''),
  email text not null check (email = lower(email) and email like '%_@_%'),
  phone text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
create index member_family_requests_household_idx on member_family_requests (household_id, status);

-- Server-side only, like every other member_* table.
alter table member_family_requests enable row level security;
revoke all on member_family_requests from anon, authenticated;
