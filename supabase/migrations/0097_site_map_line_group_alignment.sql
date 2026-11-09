-- The plan's lines, group by group, on their own placement. A plan page is a drawing of lines (roads, the site boundary and the lines between
-- plots: "the white boundaries" on the satellite map) and of homes. The homes are placed on the ground per page (site_map_alignment) and per
-- group of homes (site_map_group_alignment, 0096), but the drawn lines can sit differently from the ground than the homes do. The lines split
-- the same way the homes do: the boundary lines that run along a group of homes' plots are that group's lines, and every other line (roads, the
-- site boundary) is the page's "other" lines. An admin can place any of them on their own, moving, turning and resizing them like a group of
-- homes. Until a group of lines has a row it follows its homes (so a plot is drawn once), and the "other" lines follow their page.
--
-- One row per group of lines, in the same form as a group's alignment: plan = c * local + d with c = a + bi, d = (tx, ty), local = metres east and
-- south of the shared reference point (origin_lat, origin_lng). group_key is the plan page and the lowest house number of the homes the lines
-- run along ("H1-B:H-35"), or "H1-B:other". `houses` is that group of homes as it was when saved (null for "other"): groups are detected from the
-- layout, so the row follows the group it overlaps most. The member map places the lines from these rows (scripts/lib/site-map-align.mjs,
-- mergeSheets); the homes and their plots are unaffected.
--
-- Service role only (RLS on, no anon/authenticated grants), like the other site_map_* tables. Positions of the farm's lines are not personal data.
-- Additive; not auto-applied on merge. Rollback: drop table site_map_line_group_alignment.

create table site_map_line_group_alignment (
  group_key text primary key check (group_key ~ '^[A-Z0-9-]+:(H-[0-9]{2}|other)$'),
  cluster text not null references site_map_clusters (cluster),
  houses text[] check (houses is null or cardinality(houses) between 1 and 40),
  a numeric(14, 8) not null,
  b numeric(14, 8) not null,
  tx numeric(12, 3) not null,
  ty numeric(12, 3) not null,
  origin_lat numeric(9, 6) not null check (origin_lat between -90 and 90),
  origin_lng numeric(9, 6) not null check (origin_lng between -180 and 180),
  updated_at timestamptz not null default now()
);
create index site_map_line_group_alignment_cluster_idx on site_map_line_group_alignment (cluster);

alter table site_map_line_group_alignment enable row level security;
revoke all on site_map_line_group_alignment from anon, authenticated;
