-- Member portal: the feature tour. Records the newest tour step each person has seen
-- (scripts/lib/member-tour.mjs, a step's `since`). Null = never: a new member gets the
-- whole tour on their first sign-in; anyone else gets only the steps added after
-- this number, as "What's new". Closing or skipping the tour counts as seen.
--
-- People who have already signed in (they accepted the privacy notice) are set to 1:
-- they don't get the original tour replayed, only the steps added since. People
-- invited but not yet signed in stay null and get the whole tour.
--
-- Server-side only, like every other member_* table: RLS is already on for
-- member_people with no policies and anon/authenticated revoked.

alter table member_people
  add column tour_seen_through integer check (tour_seen_through is null or tour_seen_through >= 1);

update member_people set tour_seen_through = 1 where privacy_notice_version is not null;
