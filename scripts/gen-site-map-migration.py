"""One-off generator for supabase/migrations/0074_site_map.sql.
Seeds site_map_units and site_map_clusters from the frozen layout (docs/site-map/layout-frozen-2026-10-29.json)
and the plot lines of the 2023 site plan (docs/site-map/plan-plot-lines.json). Kept so the seed can be reproduced.
Usage: python3 -I scripts/gen-site-map-migration.py"""
import json

layout = json.load(open('docs/site-map/layout-frozen-2026-10-29.json'))
plan = json.load(open('docs/site-map/plan-plot-lines.json'))
CL = {'H1A': 'H1-A', 'H1B': 'H1-B', 'H2': 'H2'}

units = ',\n'.join(
    f"  ('{h}', '{CL[v['cluster']]}', '{v['type']}', {v['x']}, {v['y']}, {v['rotation']}, {str(v['mirrorX']).lower()}, {str(v['mirrorY']).lower()})"
    for h, v in sorted(layout['homes'].items())
)
clusters = ',\n'.join(
    f"  ('{CL[k]}', {layout['baseSize'][k]}, '{json.dumps(plan[k]['vb'])}'::jsonb, '{plan[k]['plot']}')" for k in ('H1A', 'H1B', 'H2')
)

sql = f"""-- The site map: where every home sits on the plan, drawn in the member portal ("Site map") and edited by admins.
--
-- site_map_units: one row per home, keyed by house number. x, y is the centre of the home's base foundation in the
-- coordinates of its cluster's plan page; rotation is in degrees (clockwise); mirror_x flips left-right and mirror_y
-- top-bottom about the base's own axes; shape is the standard unit shape (S 1 BHK, DG/DF/DO 2 BHK, TO 3 BHK). A home is
-- a row here whether or not a household lives in it; member_households.house_no points at it by number.
-- site_map_clusters: one base size per cluster (every home in a cluster is drawn at the same size; the three plan pages
-- were drawn at different scales), the page's view box, and the plot lines of the 2023 site plan to draw the homes on.
--
-- Seeded from the layout fixed by hand on 2026-10-29 (docs/site-map/layout-frozen-2026-10-29.json). No personal data.
-- The member portal reads these through netlify/functions/members-sitemap.mts, behind the early-access gate: the new
-- feature name 'site_map' is added to member_feature_access below (Netlify flag MEMBER_SITE_MAP_ENABLED = everyone).
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: drop tables site_map_units, site_map_clusters;
-- delete from member_feature_access where feature = 'site_map'; restore the check to ('rental').

create table site_map_clusters (
  cluster text primary key check (cluster in ('H1-A', 'H1-B', 'H2')),
  base_size numeric(5, 3) not null check (base_size between 0.5 and 4),
  view_box jsonb not null,
  plot_path text not null,
  updated_at timestamptz not null default now()
);

create table site_map_units (
  house_no text primary key check (house_no ~ '^H-[0-9]{{2}}$'),
  cluster text not null references site_map_clusters (cluster),
  shape text not null check (shape in ('S', 'DG', 'DF', 'DO', 'TO')),
  x numeric(8, 2) not null,
  y numeric(8, 2) not null,
  rotation numeric(6, 2) not null default 0 check (rotation > -360 and rotation < 360),
  mirror_x boolean not null default false,
  mirror_y boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index site_map_units_cluster_idx on site_map_units (cluster);

alter table site_map_clusters enable row level security;
alter table site_map_units enable row level security;
revoke all on site_map_clusters, site_map_units from anon, authenticated;

alter table member_feature_access drop constraint member_feature_access_feature_check;
alter table member_feature_access add constraint member_feature_access_feature_check check (feature in ('rental', 'site_map'));

insert into site_map_clusters (cluster, base_size, view_box, plot_path) values
{clusters};

insert into site_map_units (house_no, cluster, shape, x, y, rotation, mirror_x, mirror_y) values
{units};
"""
open('supabase/migrations/0074_site_map.sql', 'w').write(sql)
print('wrote 0074_site_map.sql', len(sql) // 1024, 'KB')
