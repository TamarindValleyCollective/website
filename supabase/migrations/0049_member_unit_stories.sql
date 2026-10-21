-- Member stories, one per UNIT instead of one per person.
--
-- A couple's story text was copied onto each person when the public cards were seeded, and the
-- directory only merged two people while their text stayed byte-identical, so the first owner to
-- edit and publish split the card. Bio and family describe the unit, so they are now one record per
-- unit (this table). Agreed shape:
--   shared by the unit:  bio, family, up to two photos, "show on tvc.farm"
--   personal:            each person's own quote and profile link (the directory turns a first
--                        name in the story into that person's link)
-- The rules are in scripts/lib/member-unit-story.mjs (tested).
--
-- Same three copies as member_stories, for the same reason: the old text stays live while a new
-- edit is in review, and editing never touches `approved`. Each copy is jsonb
--   { bio, family, photos: [{ ref, personId }], quotes: { <personId>: text }, links: { <personId>: url } }
-- validated before it is written. `ref` is an uploaded photo's uuid or a path on the public site;
-- an uploaded photo stays under its uploader's id in the private bucket, so `personId` is kept.
--
-- Two owners can edit the shared draft at once. `draft_version` counts saves and `draft_changed`
-- records the version at which each field last changed, so a save only conflicts when it touches a
-- field the other owner changed since the version it started from (mergeDraftEdit).
--
-- ADDITIVE: nothing reads this table yet and member_stories is left exactly as it is, so it is the
-- rollback. Backfill it with scripts/backfill-unit-stories.mjs (see that file), then later steps
-- move the portal, the staff queue and the public export over.
--
-- Access is server-side only (Netlify Functions with the service_role key). RLS is on with no
-- policies and anon/authenticated are revoked, as for every other member_* table. NOT auto-applied:
-- apply to "TVC ERP" by hand.

create table member_unit_stories (
  household_id uuid primary key references member_households (id) on delete cascade,
  draft jsonb not null default '{}'::jsonb,
  draft_public boolean not null default false,
  draft_version integer not null default 0,
  draft_changed jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'rejected')),
  submitted jsonb,
  submitted_public boolean,
  submitted_at timestamptz,
  submitted_by uuid references member_people (id) on delete set null,
  approved jsonb,
  approved_public boolean,
  approved_at timestamptz,
  reviewed_by uuid references staff_users (id) on delete set null,
  reviewer_note text,
  updated_at timestamptz not null default now(),
  -- A story that is in review always has the snapshot being reviewed.
  constraint member_unit_stories_review_has_snapshot check (status <> 'in_review' or (submitted is not null and submitted_public is not null)),
  -- Something only counts as approved if there is approved text to show.
  constraint member_unit_stories_approved_has_text check (status <> 'approved' or (approved is not null and approved_public is not null)),
  -- At most two photos in any copy.
  constraint member_unit_stories_max_two_photos check (
    jsonb_array_length(coalesce(draft -> 'photos', '[]'::jsonb)) <= 2
    and jsonb_array_length(coalesce(submitted -> 'photos', '[]'::jsonb)) <= 2
    and jsonb_array_length(coalesce(approved -> 'photos', '[]'::jsonb)) <= 2
  )
);
create index member_unit_stories_review_idx on member_unit_stories (status) where status = 'in_review';

alter table member_unit_stories enable row level security;
revoke all on member_unit_stories from anon, authenticated;
