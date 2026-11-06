-- Finance module: every member has a party (docs/finance/FINANCE.md, "Member parties").
-- NOT YET APPLIED to TVC ERP (a migration is not applied by merging it). Apply it only after the dry run of
-- scripts/backfill-member-parties.mjs has been read and agreed.
--
-- A member party was one per household (fin_parties_household_idx, unique), but the people who pay are individuals: a spouse, a parent or
-- a son sends the maintenance, from their own bank account, and the household is only where the payment is booked. So a member party is
-- now one per PERSON in the member records, linked to that person and to the household they belong to.
--
--   * fin_parties.person_id: the member person this party is. Unique among active parties, so a person cannot be added twice.
--     A party with a person is a member party (kind 'member'); the check keeps the two in step.
--   * household_id stays (the unit the person belongs to), but several people may now share it, so its unique index becomes a plain one.
--
-- Nothing here is a real name, number or amount.

-- on delete set null: deleting a person row (the portal and admin code do that to undo a half-finished add) must never be blocked by finance, and
-- the party, with its payment history, stays.
alter table fin_parties add column person_id uuid references member_people (id) on delete set null;
alter table fin_parties add constraint fin_parties_person_is_member check (person_id is null or kind = 'member');
-- When a member leaves (their last household link goes: a unit sold, a family member removed) the party stays, with its payments, and
-- is marked with the date, so the screens can say "former member" and stop presuming their unit. Being added to a household again clears it.
alter table fin_parties add column former_since date;
alter table fin_parties add constraint fin_parties_former_is_member check (former_since is null or kind = 'member');
create unique index fin_parties_person_idx on fin_parties (person_id) where person_id is not null and active;

drop index fin_parties_household_idx;
create index fin_parties_household_idx on fin_parties (household_id) where household_id is not null and active;

-- Keeping it true afterwards: whenever a person is put into a household (the member portal's family request, the admin member screen, an approved
-- request, the import script: all end in a member_household_members row), they get a party if they have none, and their party's unit follows
-- them if they move.
--   * A person who already has a party only has its household kept in step.
--   * An unlinked active member party with the same name (letters and digits only, any case) is linked, not duplicated, when there is exactly one.
--   * Otherwise a new member party is created with no bank details. Inactive people are left alone.
--   * Nothing is renamed or deleted. A person leaving, or being renamed, changes nothing here: old payments still belong to their party.
--   * It can never stop a member being added: any failure here is logged as a warning and swallowed (the next dry run of
--     scripts/backfill-member-parties.mjs would show the person still without a party).
create or replace function fin_ensure_member_party() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  person record;
  entity uuid;
  party uuid;
  key text;
  same uuid[];
begin
  begin
    select id, full_name, active into person from member_people where id = new.person_id;
    if person.id is null or not person.active then
      return new;
    end if;

    select id into party from fin_parties where person_id = person.id and active limit 1;
    if party is not null then
      update fin_parties set household_id = new.household_id, former_since = null, updated_at = now()
        where id = party and (household_id is distinct from new.household_id or former_since is not null);
      return new;
    end if;

    select id into entity from fin_entities order by created_at asc limit 1;
    if entity is null then
      return new;
    end if;

    key := trim(regexp_replace(lower(person.full_name), '[^a-z0-9]+', ' ', 'g'));
    select array_agg(id) into same from fin_parties
      where active and kind = 'member' and person_id is null and merged_into is null
        and trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = key;
    if coalesce(array_length(same, 1), 0) = 1 then
      update fin_parties set person_id = person.id, household_id = new.household_id, former_since = null, updated_at = now() where id = same[1];
    else
      insert into fin_parties (entity_id, kind, name, household_id, person_id)
        values (entity, 'member', regexp_replace(trim(person.full_name), '\s+', ' ', 'g'), new.household_id, person.id);
    end if;
  exception when others then
    raise warning 'fin_ensure_member_party failed for person %: %', new.person_id, sqlerrm;
  end;
  return new;
end $$;

revoke all on function fin_ensure_member_party() from public, anon, authenticated;

create trigger fin_ensure_member_party
  after insert or update of household_id on member_household_members
  for each row execute function fin_ensure_member_party();

-- The other direction: the last link of a person goes, so their party is marked as a former member from today. The unit it last had stays on the
-- party (old payments keep their own unit; this is only what the picker showed). Never blocks the removal.
create or replace function fin_mark_former_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if not exists (select 1 from member_household_members where person_id = old.person_id) then
      update fin_parties set former_since = current_date, updated_at = now() where person_id = old.person_id and active and former_since is null;
    end if;
  exception when others then
    raise warning 'fin_mark_former_member failed for person %: %', old.person_id, sqlerrm;
  end;
  return old;
end $$;

revoke all on function fin_mark_former_member() from public, anon, authenticated;

create trigger fin_mark_former_member
  after delete on member_household_members
  for each row execute function fin_mark_former_member();
