-- Member portal: land documents. A member uploads their patta / land survey extract
-- (Tamil Nadu "Integrated Land Record" or chitta, downloaded from eservices.tn.gov.in);
-- the details are read from it (netlify/functions/members-land-extract-background.mts)
-- and either confirm a record already in the register ("verified") or, when the
-- register has no such entry, create one that waits for the core team ("pending_review").
-- See docs/plans/member-portal.md, "Land documents".
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying anything that
-- reads these columns (the portal's home query selects them and would fail).
--
-- Privacy: land records are PII. The files live in a PRIVATE storage bucket and, like
-- every member_* table, are reachable only from Netlify Functions with the service_role
-- key (RLS on, no policies, anon/authenticated revoked). Nothing is ever returned as a
-- public URL; staff and the owning member get a short-lived signed link from a function.

create table member_land_documents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references member_households (id) on delete cascade,
  uploaded_by_person_id uuid references member_people (id) on delete set null,
  -- Which register the member said it is for: farm patta (member_plots) or house patta
  -- (member_house_pattas). Asked, not guessed: area alone can't tell the two apart.
  land_type text not null check (land_type in ('farm', 'house')),
  storage_path text not null unique,
  original_filename text,
  mime_type text not null,
  size_bytes integer not null,
  -- Same file uploaded twice for a household is recognised, not re-read.
  sha256 text not null,
  -- processing: waiting for the reader. applied: every record in it was checked and the
  -- register updated (verified, or created pending). needs_review: something needs the core
  -- team (a mismatch, a photo, a survey number held by another household). failed: unreadable
  -- or not a land document; `error` says why in words safe to show the member.
  status text not null default 'processing' check (status in ('processing', 'applied', 'needs_review', 'failed')),
  error text,
  -- What the reader found, and what was decided per record (see member-land-docs.mjs).
  extracted jsonb,
  items jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index member_land_documents_household_idx on member_land_documents (household_id, created_at desc);
create index member_land_documents_status_idx on member_land_documents (status) where status in ('processing', 'needs_review');

-- Verification state of each land record. Existing (imported) rows start 'unverified'.
--   verified       a document or the core team has confirmed it
--   pending_review the member added it from a document; waiting for the core team
alter table member_plots
  add column verification text not null default 'unverified' check (verification in ('unverified', 'verified', 'pending_review')),
  add column verified_at timestamptz,
  add column verification_source text check (verification_source in ('document', 'staff')),
  add column source_document_id uuid references member_land_documents (id) on delete set null;

alter table member_house_pattas
  add column verification text not null default 'unverified' check (verification in ('unverified', 'verified', 'pending_review')),
  add column verified_at timestamptz,
  add column verification_source text check (verification_source in ('document', 'staff')),
  add column source_document_id uuid references member_land_documents (id) on delete set null;

alter table member_land_documents enable row level security;
revoke all on member_land_documents from anon, authenticated;

-- Private bucket for the files. 5 MB cap and PDF/JPEG/PNG only, enforced by storage itself
-- as well as by the upload function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-land-documents', 'member-land-documents', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
