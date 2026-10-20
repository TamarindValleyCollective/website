-- Member stories: the risk assessment made when a story is submitted, and the switch that decides
-- whether it acts on it (docs/plans/member-portal.md, "Risk-based publishing").
--
-- `member_story_assessments` has one row per submission: how risky it was to put on the public site
-- (low or high), why, and what the system did or, in shadow mode, would have done. When a person later
-- approves or rejects the submission their decision is written alongside, so the assessment can be
-- compared with what the core team actually decided before it is allowed to publish anything alone.
-- It holds reasons (which may quote a link address) but never the story text.
--
-- `member_settings` is a small key/value table; the only key so far is `story_autopublish`:
--   { "mode": "shadow" | "live", "paused": false }
-- Missing means shadow, not paused. In shadow mode nothing is published or sent automatically.
--
-- Access is server-side only (Netlify Functions with the service_role key). RLS is on with no
-- policies and anon/authenticated are revoked, as for every other member_* table. Apply to TVC ERP by
-- hand before merging anything that reads it (migrations are not auto-applied).

create table member_story_assessments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references member_people (id) on delete cascade,
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
  unique (person_id, submitted_at)
);

create index member_story_assessments_created_idx on member_story_assessments (created_at desc);

alter table member_story_assessments enable row level security;
revoke all on member_story_assessments from anon, authenticated;

create table member_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table member_settings enable row level security;
revoke all on member_settings from anon, authenticated;
