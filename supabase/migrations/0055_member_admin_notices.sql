-- Member portal: notices for the core team that need no action, only reading (for example "an owner added a
-- family member"). They show on /internal/members until someone dismisses them. A change that does need a
-- decision is a request instead (member_family_requests), and is emailed.
--
-- Server-side only, like every other member_* table. `text` names people, so it is for the core team's eyes only.

create table member_admin_notices (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  household_id uuid references member_households (id) on delete cascade,
  text text not null check (btrim(text) <> ''),
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  dismissed_by text
);
create index member_admin_notices_open_idx on member_admin_notices (created_at) where dismissed_at is null;

alter table member_admin_notices enable row level security;
revoke all on member_admin_notices from anon, authenticated;
