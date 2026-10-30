// How a home, its plot and its house number are drawn on the site map. One module for both portals (the member portal's
// Site map and the admin portal's Site map), so the two cannot drift apart; the look is src/styles/site-map.css.
// Browser only (it builds SVG elements). The plan data and the status rules are in site-map.mjs.

import { labelAnchor, plotOutline, plotSpan } from './site-map.mjs';

export const SVG_NS = 'http://www.w3.org/2000/svg';

// The five standard unit shapes about the centre of the base foundation (34 x 37, scaled per cluster): the top is the back
// of the house and the bottom the road side. Fixed drawing constants, never server data. A home is one polygon, the
// outline of its whole footprint (the blocks and the passage joining them), so the walls between its own blocks do not
// show. The outlines are drawn on a layer above every home's fill (outlineEl), so where two homes share a wall the
// two outlines fall on the same line and neither home's wall lies on top of the other's.
const BASE = [[-17, -18], [17, -18], [17, 19], [0, 19], [0, -3], [-17, -3]];
const FOOTPRINT = {
  S: BASE,
  DF: BASE,
  DG: [[-17, -40], [0, -40], [0, -18], [17, -18], [17, 19], [0, 19], [0, -3], [-17, -3]],
  DO: [[-17, -64], [0, -64], [0, -18], [17, -18], [17, 19], [0, 19], [0, -3], [-17, -3], [-17, -18], [-5, -18], [-5, -40], [-17, -40]],
};
FOOTPRINT.TO = FOOTPRINT.DO;
const FIRST_FLOOR = { DF: [3, 0, 11, 17], TO: [3, 0, 11, 17] };
const pathOf = (pts) => `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}Z`;

export const shapeKeys = () => Object.keys(FOOTPRINT);
/** The corners of a shape's footprint in its own coordinates (before it is placed on the plan). */
export const footprintOf = (shape) => (FOOTPRINT[shape] ?? FOOTPRINT.S).map(([x, y]) => [x, y]);
/** The extra offset every shape is drawn with (see shapeDefs). */
export const SHAPE_OFFSET_Y = -0.5;

/** The <defs> content: per shape `sm-S` (hit area, fill, first floor) and `sm-S-o` (its outline). */
export function shapeDefs() {
  return shapeKeys().map((k) => {
    const up = FIRST_FLOOR[k];
    return `<g id="sm-${k}"><g transform="translate(0 -0.5)"><rect class="sm-hit" x="-17" y="-18" width="34" height="37"/>`
      + `<path class="sm-body" d="${pathOf(FOOTPRINT[k])}"/>`
      + (up ? `<rect class="sm-up" x="${up[0]}" y="${up[1]}" width="${up[2]}" height="${up[3]}"/>` : '') + '</g></g>'
      + `<g id="sm-${k}-o"><g transform="translate(0 -0.5)"><path class="sm-edge" d="${pathOf(FOOTPRINT[k])}"/></g></g>`;
  }).join('');
}

const el = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };

/** The home itself. `cls` carries its status (sm-named, sm-vacant, ...) and is-sel / is-draft / sm-dim. */
export function unitGroup(u, baseSize, cls, label) {
  const g = el('g', `sm-unit ${cls}`);
  g.setAttribute('data-house', u.houseNo);
  g.setAttribute('role', 'button');
  g.setAttribute('tabindex', '0');
  g.setAttribute('aria-label', label);
  const inner = el('g');
  inner.setAttribute('transform', `translate(${u.x} ${u.y}) rotate(${u.rotation}) scale(${u.mirrorX ? -baseSize : baseSize} ${u.mirrorY ? -baseSize : baseSize})`);
  const use = el('use');
  use.setAttribute('href', `#sm-${u.shape}`);
  inner.append(use);
  g.append(inner);
  return g;
}

/** The home's outline, for the layer above all the homes. `cls` is the same as for unitGroup. */
export function outlineEl(u, baseSize, cls) {
  const g = el('g', `sm-outline ${cls}`);
  g.setAttribute('transform', `translate(${u.x} ${u.y}) rotate(${u.rotation}) scale(${u.mirrorX ? -baseSize : baseSize} ${u.mirrorY ? -baseSize : baseSize})`);
  const use = el('use');
  use.setAttribute('href', `#sm-${u.shape}-o`);
  g.append(use);
  return g;
}

/** The home's land plot, filled in the home's status colour; null when the home is in no drawn plot (a new one, or across a line). */
export function plotFillEl(plotPath, u, cls) {
  const d = plotOutline(plotPath, u.x, u.y);
  if (!d) return null;
  // Neighbouring plots of one status would run together, so every other house number is a shade lighter and each plot has a pale rim.
  const p = el('path', `sm-plotfill ${cls}${(parseInt(String(u.houseNo).slice(2), 10) || 0) % 2 ? '' : ' sm-alt'}`);
  p.setAttribute('d', d);
  return p;
}

/** The house number as a small pill at the centre of the home's plot. `px` is user units per screen pixel, so it keeps its size as the
 *  map zooms. It is fitted to the room the plot has on screen so neighbours' labels never overlap: "H-44" when there is room,
 *  "44" in a smaller pill when there is less, nothing when there is none (zoom in, or pick the home, to see it).
 *  Returns null when there is no label to draw. A picked home always keeps its full label. */
export function badgeEl(plotPath, u, px, cls) {
  const [bx, by] = labelAnchor(plotPath, u.x, u.y) ?? [u.x, u.y];
  const span = plotSpan(plotPath, u.x, u.y);
  const room = span ? span.w / px : Infinity; // screen pixels across the plot
  const picked = /\bis-sel\b/.test(cls);
  const tier = picked || room >= 54 ? 'full' : room >= 30 ? 'short' : room >= 20 ? 'tiny' : null;
  if (!tier) return null;
  const text = tier === 'full' ? u.houseNo : u.houseNo.slice(2).replace(/^0/, '');
  const font = tier === 'tiny' ? 9 : 11;
  const w = (text.length * (font * 0.62) + (tier === 'full' ? 14 : 10)) * px;
  const h = (tier === 'tiny' ? 14 : 18) * px;
  const g = el('g', `sm-badge ${cls}`);
  const bg = el('rect', 'sm-badge-bg');
  bg.setAttribute('x', String(bx - w / 2));
  bg.setAttribute('y', String(by - h / 2));
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('rx', String(h / 2));
  const t = el('text', 'sm-badge-text');
  t.setAttribute('x', String(bx));
  t.setAttribute('y', String(by));
  t.setAttribute('style', `font-size:${font * px}px`);
  t.textContent = text;
  g.append(bg, t);
  return g;
}
