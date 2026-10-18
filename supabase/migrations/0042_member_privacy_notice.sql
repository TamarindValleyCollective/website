-- Member portal: first-login privacy notice. Records which version of the notice
-- (scripts/lib/member-privacy.mjs, PRIVACY_NOTICE_VERSION) each person has read
-- and acknowledged, and when. Null = not yet. Raising the version in code asks
-- everyone again, the next time they sign in.
--
-- Until a person has acknowledged the current version the portal returns none of
-- their household's data (netlify/functions/members-me.mts). The acknowledgement
-- itself is also written to member_audit_log (action member.privacy.accept).
--
-- Server-side only, like every other member_* table: RLS is already on for
-- member_people with no policies and anon/authenticated revoked.

alter table member_people
  add column privacy_notice_version integer,
  add column privacy_notice_accepted_at timestamptz;
