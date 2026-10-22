-- Member portal: the core team may approve more family members than an owner can add alone.
--
-- 0053 capped family members who can sign in at two per household, the same number an owner may add without
-- anyone's approval (members-me.mts enforces that one). A further one is a member_family_requests row that the
-- core team approves (members-admin.mts), so the database's own limit has to be higher than the self-service one:
-- six family members. Owners and non-owners stay at two.

create or replace function member_household_members_max_two_logins() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.can_login and (
    select count(*) from public.member_household_members
    where household_id = new.household_id and can_login and person_id <> new.person_id
      and (role = 'family') = (new.role = 'family')
  ) >= (case when new.role = 'family' then 6 else 2 end) then
    raise exception 'a household can have at most 2 owners and 6 family members who can sign in';
  end if;
  return new;
end;
$$;
