-- Laying each plan page over Google's live satellite map: one row per cluster page (H1-A, H1-B, H2), written from the admin
-- Site map's "Align to satellite" page. The admin pairs points on the plan page and on the map; each pair is a spot on the
-- plan page and its latitude and longitude. The server turns the positions into metres around a reference point
-- (origin_lat, origin_lng, shared by every page so they sit on one frame) and fits the similarity (scale, rotation, shift)
-- from them: plan = c * local + d with c = a + bi, d = (tx, ty), local = metres east and south of the origin. The pairs are
-- kept so the page can show and refine them, and rms is how far the pairs are from the fit, in plan units. No map imagery is
-- stored anywhere: the page draws our plan over Google's live map through the Maps JavaScript API.
-- The member map joins the pages of a sheet from these rows (scripts/lib/site-map-align.mjs) once both H1 pages have one.
--
-- Additive and not auto-applied on merge. Service role only (RLS on, no anon/authenticated grants), the same as the other
-- site_map_* tables. Positions of the farm's homes are not personal data. Rollback: drop table site_map_alignment.

create table site_map_alignment (
  cluster text primary key references site_map_clusters (cluster),
  a numeric(14, 8) not null,
  b numeric(14, 8) not null,
  tx numeric(12, 3) not null,
  ty numeric(12, 3) not null,
  origin_lat numeric(9, 6) not null check (origin_lat between -90 and 90),
  origin_lng numeric(9, 6) not null check (origin_lng between -180 and 180),
  rms numeric(8, 2),
  pairs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table site_map_alignment enable row level security;
revoke all on site_map_alignment from anon, authenticated;
