-- Member register: the profile picture Google shows for a member's account, kept so the core team can recognise
-- them on the staff member register (the household cards at /internal/members).
--
-- Set from the Google sign-in token (`picture`) each time a member signs in to the portal, and only once they
-- have accepted privacy notice v7, which says so. Cleared at the next sign-in if they remove the picture from
-- their Google account. Only a https address on Google's own image hosts is ever stored (the Function checks
-- this before writing; the constraint below is a second guard). Shown only to core-team staff who may see names:
-- never to other members, never to a read-only staff role.
--
-- Access is server-side only (Netlify Functions with the service_role key), as for every other member_* table.
-- Apply to TVC ERP by hand before merging (migrations are not auto-applied).

alter table member_people
  add column google_picture_url text
  check (google_picture_url is null or (length(google_picture_url) <= 500 and google_picture_url ~* '^https://[a-z0-9.-]+\.(googleusercontent|ggpht)\.com/'));
