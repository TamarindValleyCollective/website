# Site map seed data

The layout of the 52 homes on the 2023 site plan, fixed by hand on 2026-10-29 with the prototype editor (branch
`worktree-site-map-prototype`, folder `docs/site-map-prototype/`). Source of the rows in migration `0074_site_map.sql`.

- `layout-frozen-2026-10-29.json`: per home x, y (centre of the base foundation, plan coordinates), rotation, mirrors, shape;
  one base size per cluster (H1A 1.63, H1B 1.8, H2 1.8). Coordinates only, no personal data.
- `plan-plot-lines.json`: view box and plot lines of each cluster's plan page.
- `scripts/gen-site-map-migration.py` regenerates the seed part of the migration from these two files. After 0074 is applied
  the database is the source of truth (admins change the layout in the admin portal); these files are history.
- The member map shows H1-A and H1-B as one H1 sheet (`mergeSheets` in `scripts/lib/site-map.mjs`): each cluster has its own
  scale, rotation and offset into the first page's coordinates, and every home is drawn at the one base size. The placement
  comes from the admin page **Align to satellite** (`/internal/site-map-align/`): pair three or more points on a plan page and
  on a satellite image, and the page's fit is stored in `site_map_alignment` (migration 0095); the pages of a sheet are
  placed against each other from their fits to the same image. Until both H1 pages are aligned, `SHEETS` holds the placement
  (set by laying the plan over a satellite image by eye). The image itself is kept in a private store, never in the repo.
