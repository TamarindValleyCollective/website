-- Admin portal: the profile picture Google shows for an admin's account, so the Access page can show a face
-- next to each name (/internal/access, super admins only).
--
-- Set from the Google sign-in token (`picture`) when the admin opens any admin page (netlify/functions/staff-me.mts),
-- and cleared at the next sign-in if they remove the picture from their Google account. Only a https address on
-- Google's own image hosts is ever stored (the Function checks this before writing; the constraint below is a second
-- guard), as for member_people.google_picture_url (migration 0047). Shown only to the person themselves (from their
-- own token, not this column) and to super admins on the Access page.
--
-- Access is server-side only (Netlify Functions with the service_role key), as for every other staff_* table.
-- Apply to TVC ERP by hand before merging (migrations are not auto-applied). The code works without it: until it
-- is applied the Access page simply shows initials, and each person still sees their own picture.

alter table staff_users
  add column google_picture_url text
  check (google_picture_url is null or (length(google_picture_url) <= 500 and google_picture_url ~* '^https://[a-z0-9.-]+\.(googleusercontent|ggpht)\.com/'));
