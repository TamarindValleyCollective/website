"""One-off generator for supabase/migrations/0075_site_map_plot_outlines.sql.
Migration 0074 seeded each cluster's plot_path with the raw plan lines only. Several plots (H1-A 29/30, H1-B 44-52) have
boundaries the raw lines do not draw, so the map showed them open. The extraction also produced a closed outline for every
home's land plot (faces_*.json, from the prototype). This writes those outlines to docs/site-map/plot-outlines.json and
the migration that appends them to plot_path.
Usage: python3 -I scripts/gen-site-map-plots-migration.py <folder with faces_H1A.json faces_H1B.json faces_H2.json>"""
import json, sys

faces_dir = sys.argv[1]
CL = {'H1A': 'H1-A', 'H1B': 'H1-B', 'H2': 'H2'}
outlines = {}
for k in CL:
    f = json.load(open(f'{faces_dir}/faces_{k}.json'))
    paths = {}
    for house, i in sorted(f['map'].items()):
        pts = f['faces'][i]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        paths[house] = 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts) + ' Z'
    outlines[k] = paths
json.dump(outlines, open('docs/site-map/plot-outlines.json', 'w'), indent=0, separators=(',', ':'))

statements = []
for k, c in CL.items():
    add = ' '.join(outlines[k].values())
    marker = list(outlines[k].values())[0][:60]
    statements.append(
        f"update site_map_clusters set plot_path = plot_path || ' ' || '{add}', updated_at = now()\n"
        f"  where cluster = '{c}' and position('{marker}' in plot_path) = 0;"
    )

sql = """-- Site map: draw every home's land plot, not only the plan lines that were extracted as strokes.
--
-- 0074 seeded site_map_clusters.plot_path with the raw plan lines of the 2023 site plan. Some plots have boundaries the raw
-- lines do not carry (H1-A 29/30 and H1-B 44-52 showed open), although the extraction also produced a closed outline for
-- every home's plot (docs/site-map/plot-outlines.json). This appends those closed outlines to each cluster's plot_path.
-- Nothing else changes: no schema, no placements. Both the member and the admin Site map read plot_path, so both show it
-- at once. Guarded so running it twice does not add the outlines twice.
--
-- Backwards compatible and additive; not auto-applied on merge. Rollback: re-run the plot_path part of 0074 for the three
-- clusters (docs/site-map/plan-plot-lines.json holds the raw lines).

""" + '\n\n'.join(statements) + '\n'
open('supabase/migrations/0075_site_map_plot_outlines.sql', 'w').write(sql)

# A preview of what will be drawn: the raw lines plus the closed outlines, per cluster.
plan = json.load(open('docs/site-map/plan-plot-lines.json'))
layout = json.load(open('docs/site-map/layout-frozen-2026-10-29.json'))
parts = []
for k in ('H1A', 'H1B', 'H2'):
    vb = plan[k]['vb']
    full = plan[k]['plot'] + ' ' + ' '.join(outlines[k].values())
    labels = ''.join(
        f'<text x="{v["x"]}" y="{v["y"]}" font-size="11" font-weight="700" text-anchor="middle" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">{h[2:]}</text>'
        for h, v in layout['homes'].items() if v['cluster'] == k)
    parts.append(f'<h3>{CL[k]}: plan lines plus closed plot outlines</h3><svg viewBox="{vb[0]} {vb[1]} {vb[2]} {vb[3]}" style="width:100%;height:{760 if k=="H1A" else 440}px;background:#fff;border:1px solid #ccc"><path d="{full}" fill="none" stroke="#000" stroke-width="1.3" vector-effect="non-scaling-stroke"/>{labels}</svg>')
open(sys.argv[2] if len(sys.argv) > 2 else '/dev/null', 'w').write('<!doctype html><meta charset=utf-8><body style="font:14px system-ui;margin:12px">' + ''.join(parts))
print('wrote 0075 migration,', sum(len(v) for v in outlines.values()), 'outlines,', len(sql) // 1024, 'KB')
