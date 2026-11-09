-- Aligning groups of homes to the satellite map: a group is homes that share walls (scripts/lib/site-map-groups.mjs). The 2023
-- plan and what is built on the ground differ a little, but homes that share walls were built as one piece, so each group is
-- fitted to Google's live satellite map on its own, from point pairs, exactly as a whole plan page is in site_map_alignment
-- (0095): plan = c * local + d, c = a + bi, d = (tx, ty), local = metres east and south of the shared reference point
-- (origin_lat, origin_lng). The member map moves a group's homes and their plot outlines with the group's fit, while the plan's
-- own lines stay with the page's fit.
--
-- group_key is the page and the lowest house number ("H1-B:H-33"). `houses` is the group as it was when saved: groups are
-- detected from the layout, so when a home is added or moved the saved row follows the group it overlaps most.
-- Service role only (RLS on, no anon/authenticated grants), like the other site_map_* tables. Positions of the farm's homes
-- are not personal data. Additive; not auto-applied on merge. Rollback: drop table site_map_group_alignment.

create table site_map_group_alignment (
  group_key text primary key check (group_key ~ '^[A-Z0-9-]+:H-[0-9]{2}$'),
  cluster text not null references site_map_clusters (cluster),
  houses text[] not null check (cardinality(houses) between 1 and 40),
  a numeric(14, 8) not null,
  b numeric(14, 8) not null,
  tx numeric(12, 3) not null,
  ty numeric(12, 3) not null,
  origin_lat numeric(9, 6) not null check (origin_lat between -90 and 90),
  origin_lng numeric(9, 6) not null check (origin_lng between -180 and 180),
  rms numeric(8, 2),
  -- The size (plan units per metre) the fit was held to, so every home is the same size whichever group it is in; null if it was free.
  locked_scale numeric(10, 5),
  pairs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index site_map_group_alignment_cluster_idx on site_map_group_alignment (cluster);

alter table site_map_group_alignment enable row level security;
revoke all on site_map_group_alignment from anon, authenticated;
