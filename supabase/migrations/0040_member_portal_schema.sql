-- Member portal (members.tvc.farm), step 1: the member register that replaces the
-- "TVC Spend Summary" workbook (Member Master, Farm Patta Details, House Patta
-- Details) as the source of truth. See docs/plans/member-portal.md.
--
-- The household (one farm unit, F-01..F-53) is the unit of membership; people
-- attach to it. Maintenance dues, stays and change requests arrive in later
-- steps with their own migrations.
--
-- Numbering: 0039 is taken by the (still unmerged) stay-notification work, so
-- this is 0040. Apply it to TVC ERP by hand before merging anything that reads
-- these tables (migrations are not auto-applied).
--
-- Privacy: names, emails, phone numbers and land records are PII. Access is
-- server-side only (Netlify Functions with the service_role key). RLS is
-- enabled with no policies and anon/authenticated are revoked, so the public
-- PostgREST API can read none of it. Emails and phones are never sent to the
-- browser for any staff role (see netlify/functions/lib/staff-masking.ts).
--
-- import_key columns make the one-time workbook import idempotent: a re-run
-- updates the same rows instead of duplicating them. They are NULL for rows
-- created in the portal.

create table member_households (
  id uuid primary key default gen_random_uuid(),
  farm_unit text not null unique check (farm_unit ~ '^F-[0-9]{2}$'),
  -- Null when no house has been built yet.
  house_no text check (house_no ~ '^H-[0-9]{2}$'),
  cluster text check (cluster in ('H1-A', 'H1-B', 'H2')),
  unit_type text,
  created_at timestamptz not null default now()
);
-- One house belongs to one household.
create unique index member_households_house_no_key on member_households (house_no) where house_no is not null;

create table member_people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (btrim(full_name) <> ''),
  -- The sign-in identity. Only 18 of 98 people have one at import time; the
  -- rest are collected at first login. Stored lower-case.
  email text check (email = lower(email) and email like '%_@_%'),
  phone text,
  -- The directory is opt-out: visible unless the person says otherwise.
  directory_visible boolean not null default true,
  active boolean not null default true,
  import_key text unique,
  created_at timestamptz not null default now()
);
create unique index member_people_email_key on member_people (email) where email is not null;

create table member_household_members (
  household_id uuid not null references member_households (id) on delete cascade,
  person_id uuid not null references member_people (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'family', 'non_owner')),
  -- At most two people per household may sign in (member + spouse/partner/
  -- co-owner); enforced by the trigger below. Nobody can sign in until invited.
  can_login boolean not null default false,
  primary key (household_id, person_id)
);
create index member_household_members_person_idx on member_household_members (person_id);

create function member_household_members_max_two_logins() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.can_login and (
    select count(*) from public.member_household_members
    where household_id = new.household_id and can_login and person_id <> new.person_id
  ) >= 2 then
    raise exception 'a household can have at most 2 people who can sign in';
  end if;
  return new;
end;
$$;
create trigger member_household_members_max_two_logins
  before insert or update of can_login on member_household_members
  for each row execute function member_household_members_max_two_logins();

-- Farm patta: one row per survey number of a household. Missing values stay
-- NULL ("not available yet"), never zero.
create table member_plots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  patta_no text,
  reference_no text,
  survey_no text,
  area_hectares numeric(8, 4),
  area_acres numeric(8, 2),
  settlement text,
  import_key text unique,
  created_at timestamptz not null default now()
);
create index member_plots_household_idx on member_plots (household_id);

create table member_house_pattas (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  patta_no text,
  reference_no text,
  survey_no text,
  area_sq_ft numeric(10, 2),
  settlement text,
  import_key text unique,
  created_at timestamptz not null default now()
);
create index member_house_pattas_household_idx on member_house_pattas (household_id);

-- Free-text flag per household, e.g. "patta issue" (one at import time).
create table member_household_notes (
  id bigint generated always as identity primary key,
  household_id uuid not null references member_households (id) on delete cascade,
  kind text not null check (kind in ('patta_issue', 'data_gap', 'other')),
  note text,
  created_at timestamptz not null default now(),
  unique (household_id, kind)
);

alter table member_households enable row level security;
alter table member_people enable row level security;
alter table member_household_members enable row level security;
alter table member_plots enable row level security;
alter table member_house_pattas enable row level security;
alter table member_household_notes enable row level security;
revoke all on member_households, member_people, member_household_members, member_plots,
  member_house_pattas, member_household_notes from anon, authenticated;
revoke all on function member_household_members_max_two_logins() from public, anon, authenticated;
