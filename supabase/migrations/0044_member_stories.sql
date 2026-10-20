-- Member portal: member stories (replaces the "TVC Members: Your Story" Google
-- Form). One row per person: what they are writing now (`draft`), what they have
-- handed to the core team (`submitted`), and what the core team approved
-- (`approved`). See docs/plans/member-portal.md, "Member stories".
--
-- Three copies, because the old text must stay live while a new edit is in
-- review: editing never touches `approved`. The core team's approval queue (a
-- later step) copies `submitted` to `approved` and sets `approved_public` from
-- `submitted_public`. Until that exists nothing here can be seen by anyone but
-- the author and the core team.
--
-- Each copy is jsonb { bio, family, why, social }, validated in
-- scripts/lib/member-story.mjs before it is written. The text is the member's own
-- writing and, once approved, may be published; it is not otherwise personal
-- data held about them, but it is never put in audit detail (member_audit_log
-- records which fields changed, never their content).
--
-- show_on_public_site is a per-story switch, default off: approved stories are
-- visible to members in the directory; only those with the switch on may go on
-- tvc.farm. Turning it on, or changing the text of a public story, goes through
-- review like any other edit.
--
-- Access is server-side only (Netlify Functions with the service_role key). RLS
-- is on with no policies and anon/authenticated are revoked, as for every other
-- member_* table. Apply to TVC ERP by hand before merging anything that reads it
-- (migrations are not auto-applied).

create table member_stories (
  person_id uuid primary key references member_people (id) on delete cascade,
  draft jsonb not null default '{}'::jsonb,
  draft_public boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'rejected')),
  submitted jsonb,
  submitted_public boolean,
  submitted_at timestamptz,
  approved jsonb,
  approved_public boolean,
  approved_at timestamptz,
  reviewed_by uuid references staff_users (id) on delete set null,
  reviewer_note text,
  updated_at timestamptz not null default now(),
  -- A story that is in review always has the snapshot being reviewed.
  constraint member_stories_review_has_snapshot check (status <> 'in_review' or (submitted is not null and submitted_public is not null)),
  -- Something only counts as approved if there is approved text to show.
  constraint member_stories_approved_has_text check (status <> 'approved' or (approved is not null and approved_public is not null))
);
create index member_stories_status_idx on member_stories (status) where status = 'in_review';

alter table member_stories enable row level security;
revoke all on member_stories from anon, authenticated;
