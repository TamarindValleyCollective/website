-- Risk assessments for UNIT stories (member_unit_stories, migration 0049).
--
-- Same table as member_story_assessments (0046) with the same columns and meaning, keyed by the unit
-- instead of the person: when a unit's story is submitted for the public site it is assessed (fixed
-- rules plus the model's judgement, scripts/lib/member-risk.mjs), the assessment is recorded here, and
-- in shadow mode it only shows what it WOULD have done beside the admin's own decision so the two can be
-- compared; in live mode a low-risk story is approved at once and a high-risk one is held and emailed.
-- One row per submission: (household_id, submitted_at) is unique, and a later decision by a person is
-- written onto the same row.
--
-- ADDITIVE: nothing reads this table yet; member_story_assessments is untouched. Server-side only
-- (Netlify Functions with the service_role key): RLS on, no policies, anon/authenticated revoked, as for
-- every other member_* table. NOT auto-applied: apply to "TVC ERP" by hand before merging code that
-- reads it.

create table member_unit_story_assessments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  submitted_at timestamptz not null,
  is_public boolean not null,
  level text not null check (level in ('low', 'high')),
  reasons jsonb not null default '[]',
  assessed_by text not null check (assessed_by in ('members_only', 'rules', 'rules+model')),
  mode text not null check (mode in ('shadow', 'live')),
  outcome text not null check (outcome in ('publish', 'hold')),
  decision text check (decision in ('approved', 'rejected', 'auto_approved')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, submitted_at)
);

create index member_unit_story_assessments_created_idx on member_unit_story_assessments (created_at desc);

alter table member_unit_story_assessments enable row level security;
revoke all on member_unit_story_assessments from anon, authenticated;
