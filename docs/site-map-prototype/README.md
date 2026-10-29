# Member portal site map: prototype (paused 2026-10-26)

Prototype of a "Site map" view for the member portal: every home (H-01..H-52) drawn on the
H1-A / H1-B / H2 plans using five standard unit shapes. Not wired into the portal; no docs or changelog
updated on purpose (prototype). Source plan: Drive > Housing > `TVC site plan 20230213.pdf` (3 pages, vector).

Published mockups (private artifacts): map https://claude.ai/artifact/Ge2xmQWp5NYVCazbGp5Xp4,
shapes https://claude.ai/artifact/69vJqjSLyUoVk5ZpMQNN4g

## Unit types (Sharath's definitions)
K kitchen, H hall, B bedroom; in the sketch the top is the back of the house and the bottom is the road side.
- S: single bedroom, all ground floor (K,H row; B below H). Base of every type.
- DG: double, all ground floor (S + ground bedroom behind the kitchen).
- DF: double, 2nd bedroom on the first floor above the ground-floor bedroom (S footprint).
- DO: double, 2nd bedroom a separate ground-floor block at the back, joined by a passage.
- TO: triple, DO + 3rd bedroom on the first floor above the main block's bedroom.
Every home is drawn at ONE fixed size (k = 1.78); orientation and mirror vary per home.

## Pipeline (python venv with `shapely` and `pillow`; scripts expect the working dirs they were run in)
1. `pdftocairo -svg -f N -l N plan.pdf pN.svg` for N = 1..3 into a `pdf/` dir (copy the PDF there as `plan.pdf`);
   `extract.py pdf out` writes `labels{1,2,3}.json` (plot-number text positions).
2. `build.py pdf out` writes `houses_base.json` and the page (needs `out/tpl.html`).
3. `plots.py pdf out 2.5` polygonizes each unit's land plot into `faces_*.json` (seeds in SEED; H-02 and H-32 needed manual seeds).
4. `place.py pdf out` fits each home (rotation snapped to the cluster's building axes, mirror, position) to the real
   building outlines by overlap, keeps it inside its plot, flushes shared walls, aligns neighbours' K/H rows.
5. `build.py pdf out` again to merge `placed.json` into `site-map-mockup.html`.

## Editor (added 2026-10-29): `out/site-map-editor.html`
Hand-tuning tool so corrections are made visually instead of described by home number. Open the file directly in a browser
(or `python3 -m http.server -d out`). Drag a unit to move, drag its round handle to rotate (fine: 0.1 degree steps, typed
value, slider, `[` `]` keys), mirror left-right or top-bottom about the base foundation's own axes, change unit type.
Snap (on by default, Alt bypasses) slides edges flush onto plan lines and neighbouring units and rotates to the nearest line
direction within 3 degrees; "Snap to nearest lines" does both with a wider reach. Base size (`k`, default 1.78) is one number per
cluster, because the three PDF pages were drawn at different scales; it applies to every unit in that cluster, each about its
own centre. There is no per-unit scale. Units are anchored on the centre of the base L-shape, so mirroring or changing type never
moves the foundation. "Mark checked" tracks which homes have been reviewed. Edits autosave in the browser; "Download JSON"
(`site-map-edits.json`: x, y of the base centre, rotation, mirrorX, mirrorY, type, per home) is the real save.
Rebuild with `python3 -I scripts/build_editor.py out` (reads the data already embedded in `site-map-mockup.html`).
Next: load the exported JSON as overrides in `place.py`/`build.py` so the map mockup and any portal view use it.

## Known problems (Sharath: "a lot of corrections needed")
Weakest fits: H-29, H-30, H-24, H-8, H-9, H-35. In H1-A the PDF's buildings cross plot lines. Orientation and mirror of
several homes are still wrong; Sharath will send corrections by home number. Next step if approved: a portal view that
reads `unit_type` from the member record, one SVG per cluster plus a placement table, then ARCHITECTURE and CHANGELOG.
