-- Member portal: which public Members-page card each household is, for the public export
-- (docs/plans/member-portal.md, "Public export").
--
-- The public Members page (src/data/members.ts) has one card per household, named the way the
-- 2017 directory named it ("Sree & Prameela", "Amit Gupta"), which is not always how the register
-- spells the people (a first name on the card, a longer one in the register). The export keeps those names, so it needs to know which
-- household is which card. `person_ids` is in the order of the names on the card, because a card with
-- two quotes or two profile links pairs them with the names by position.
--
-- Filled once from the card text by the seeding SQL (seed-cards.sql, scripts/seed-member-stories.mjs);
-- a household with no row here gets a name made from its primary members' names.
--
-- Access is server-side only (Netlify Functions with the service_role key). RLS is on with no
-- policies and anon/authenticated are revoked, as for every other member_* table. Apply to TVC ERP by
-- hand before merging anything that reads it (migrations are not auto-applied).

create table member_cards (
  household_id uuid primary key references member_households (id) on delete cascade,
  card_name text not null unique check (btrim(card_name) <> ''),
  person_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table member_cards enable row level security;
revoke all on member_cards from anon, authenticated;
