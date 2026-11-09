-- Laying each plan page over the satellite image: one row per cluster page (H1-A, H1-B, H2), written from the admin Site map's
-- "Align to satellite" page. The admin pairs points on the plan page and on the image; the server fits the similarity
-- (scale, rotation, shift) from them: plan = c * image + d with c = a + bi, d = (tx, ty). The pairs are kept so the page can
-- show and refine them, and rms is how far the pairs are from the fit, in plan units. The satellite image itself is not
-- here (it is imagery from a map provider): it lives in the private Netlify Blobs store "site-map", read only by admins.
-- The member map joins the pages of a sheet from these rows (scripts/lib/site-map-align.mjs) once both H1 pages have one.
--
-- Additive and not auto-applied on merge. Service role only (RLS on, no anon/authenticated grants), the same as the other
-- site_map_* tables. No personal data. Rollback: drop table site_map_alignment.

create table site_map_alignment (
  cluster text primary key references site_map_clusters (cluster),
  a numeric(14, 8) not null,
  b numeric(14, 8) not null,
  tx numeric(12, 3) not null,
  ty numeric(12, 3) not null,
  rms numeric(8, 2),
  pairs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table site_map_alignment enable row level security;
revoke all on site_map_alignment from anon, authenticated;
