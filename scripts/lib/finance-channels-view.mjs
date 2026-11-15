// The Channels view's drawing (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"). Two parts: the layout, pure and
// tested (layoutFlow: where each box and band goes, from a flowOf result), and the SVG drawing, which only places that layout in the page.
// Colours and type come from the dashboard's CSS (the --tvc-chart-* tokens), so both appearances work; everything the server sent is
// placed with textContent only.
import { lakhText, rupeesText } from './finance-dashboard-view.mjs';

/** '₹0.23 L' from ₹10,000 up, whole rupees ('₹5,000') below. */
export const moneyText = (paise) => (paise >= 1_000_000 ? lakhText(paise, 2) : rupeesText(paise));

/** How full a delegate's month is against their limit: ok, warn from 80%, crit over. */
export const statusOf = (monthPaise, capPaise) => (!capPaise ? 'ok' : monthPaise > capPaise ? 'crit' : monthPaise >= 0.8 * capPaise ? 'warn' : 'ok');

const W = 1120, H = 440, GAP = 14, NW = 14, XS = [220, 560, 900];
const MIN_SLOT = 34;   // a box with a tiny amount still has room for its name and figure
const HUB_PAD = 52;    // room above and below an account's box for its name and what stayed in it

/**
 * Where everything goes. One scale for the whole picture (a band is as wide as its money, a box as tall as its money, never under 4 px),
 * the boxes of the two outer columns ordered by where their money goes so bands cross as little as possible, the fixed deposits last,
 * and each band placed on its boxes in the order of the boxes at its other end.
 * Returns { width, height, nodes: [{...node, x, y, h, w}], links: [{...link, w, sy, ty, d}], kept: [{ account, y, h, paise, side }] }.
 */
export function layoutFlow(flow) {
  const nodes = flow.nodes.map((n) => ({ ...n, w: NW }));
  const links = flow.links.map((l) => ({ ...l }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cols = [0, 1, 2].map((c) => nodes.filter((n) => n.col === c));
  const place = (c) => cols[c].forEach((n, i) => { n.pos = i; });
  [0, 1, 2].forEach(place);
  const order = (c) => {
    for (const n of cols[c]) {
      let s = 0, t = 0;
      for (const l of links) { const o = l.from === n.id ? byId.get(l.to) : l.to === n.id ? byId.get(l.from) : null; if (o) { s += o.pos * l.paise; t += l.paise; } }
      n.bary = t ? s / t : 99;
    }
    cols[c].sort((a, b) => a.bary - b.bary || b.paise - a.paise);
    place(c);
  };
  order(0); order(2);   // the accounts column keeps its order, the fixed deposits (an account too) last

  const scale = Math.min(...cols.filter((c) => c.length).map((c) => (H - GAP * Math.max(0, c.length - 1)) / Math.max(1, c.reduce((a, n) => a + n.paise, 0))));
  const k = Number.isFinite(scale) ? scale : 1;
  const heights = cols.map((c) => c.map((n) => Math.max(4, n.paise * k)));
  const slots = cols.map((c, ci) => c.map((_, i) => (ci === 1 ? heights[ci][i] + HUB_PAD : Math.max(heights[ci][i], MIN_SLOT))));
  const totals = slots.map((s) => s.reduce((a, b) => a + b, 0) + GAP * Math.max(0, s.length - 1));
  const height = Math.max(H, ...totals) + 8;
  cols.forEach((c, ci) => {
    let y = (height - totals[ci]) / 2;
    c.forEach((n, i) => { n.x = XS[ci]; n.h = heights[ci][i]; n.y = y + (slots[ci][i] - n.h) / 2; y += slots[ci][i] + GAP; });
  });

  for (const n of nodes) {
    // transfers between accounts go last on a box, below the bands that lead out to the sides, so they do not cut across them
    const outs = links.filter((l) => l.from === n.id).sort((a, b) => byId.get(a.to).y + (a.transfer ? 1e6 : 0) - (byId.get(b.to).y + (b.transfer ? 1e6 : 0)));
    const ins = links.filter((l) => l.to === n.id).sort((a, b) => byId.get(a.from).y + (a.transfer ? 1e6 : 0) - (byId.get(b.from).y + (b.transfer ? 1e6 : 0)));
    let o = 0; for (const l of outs) { l.w = Math.max(1.5, l.paise * k); l.sy = n.y + o; o += l.w; }
    let i = 0; for (const l of ins) { l.w = Math.max(1.5, l.paise * k); l.ty = n.y + i; i += l.w; }
  }
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to), y0 = l.sy + l.w / 2, y1 = l.ty + l.w / 2;
    if (l.transfer) {
      // between two boxes of the same column: a loop out to the right (into the deposits) or to the left (back out of them)
      const into = b.kind === 'fd', x = into ? a.x + NW : a.x, bulge = into ? 70 : -70;
      l.d = `M${x},${y0} C${x + bulge},${y0} ${x + bulge},${y1} ${x},${y1}`;
      continue;
    }
    const x0 = a.x + NW, x1 = b.x, xm = (x0 + x1) / 2;
    l.d = `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1}`;
  }
  // What an account kept (more came in than went out) or took from its balance: a green strip at the foot of the shorter side.
  const kept = cols[1].filter((n) => n.kind === 'account').map((n) => {
    const diff = n.inPaise - n.outPaise;
    return diff === 0 ? null : { account: n.id, paise: diff, side: diff > 0 ? 'right' : 'left', h: Math.max(3, Math.abs(diff) * k), y: n.y + n.paise * k - Math.max(3, Math.abs(diff) * k) };
  }).filter(Boolean);
  return { width: W, height: height + 34, nodes, links, kept, scale: k };
}

// ---- the columns beyond the picture: a box's breakdown, and then its lines --------------------------------------------------------------

/** How far the picture slides for each level of drilling in (one column's spacing). */
export const SLIDE = 340;
const CARD_W = 206, CARD_HEAD = 62, CARD_ROW = 40;

/**
 * Where the extra columns go when a box on the money-out side (or the money-in side) is opened, on the same scale as the picture. The
 * breakdown is a column of boxes beside the opened box, joined to it by bands as wide as their money; below that is a card for the lines of one
 * of them. Out opens to the right and the picture slides left; in opens to the left and the picture slides right.
 *
 * `rows`: the breakdown [{ id, name, paise, n }], null while it loads (no boxes yet), or undefined for a box that has none (its lines come
 * straight after it). `pickId`: the row whose lines are shown, '*' for all of them, null for none yet. `lineCount`: how many lines are listed in
 * the card (0 while loading).
 * Returns { side, level, dx, rows: [{...row, x, y, h, w, band: { d, w }}], card: { x, y, w, h, link: { d, w } } | null, bottom }.
 */
export function layoutDrill(layout, { nodeId, rows, pickId = null, lineCount = 0 }) {
  const parent = layout.nodes.find((n) => n.id === nodeId);
  const out = parent.col !== 0, k = layout.scale;   // the deposits (an account, in the middle) open to the right, like the money-out side
  const direct = rows === undefined;
  const level = direct || pickId !== null ? (direct ? 1 : 2) : 1;
  const colX = out ? parent.x + SLIDE : parent.x - SLIDE;
  const slots = (rows ?? []).map((r) => ({ ...r, w: NW, h: Math.max(4, r.paise * k) }));
  const slotH = slots.map((r) => Math.max(r.h, MIN_SLOT));
  const total = slotH.reduce((a, b) => a + b, 0) + GAP * Math.max(0, slots.length - 1);
  const mid = parent.y + parent.h / 2;
  let y = Math.max(0, mid - total / 2);
  let ys = parent.y;
  const placed = slots.map((r, i) => {
    const row = { ...r, x: colX, y: y + (slotH[i] - r.h) / 2 };
    const w = Math.max(1.5, r.paise * k);
    row.band = { w, d: out ? curve(parent.x + NW, ys + w / 2, colX, row.y + w / 2) : curve(colX + NW, row.y + w / 2, parent.x, ys + w / 2) };
    y += slotH[i] + GAP;
    ys += w;
    return row;
  });
  let card = null;
  if (direct || pickId !== null) {
    const source = direct ? parent : placed.find((r) => (r.id || 'none') === pickId) ?? null;
    const cardH = CARD_HEAD + Math.max(1, lineCount) * CARD_ROW;
    const nodeX = direct ? colX : out ? colX + SLIDE : colX - SLIDE;
    const x = out ? nodeX : nodeX - CARD_W + NW;
    const cy = Math.max(0, (source ? source.y + source.h / 2 : mid) - cardH / 2);
    const w = Math.min(40, Math.max(1.5, source ? (source.paise ?? source.h / k) * k : parent.h));
    const from = source ?? parent;
    card = {
      x, y: cy, w: CARD_W, h: cardH,
      link: { w, d: out ? curve(from.x + NW, from.y + from.h / 2, x, cy + 14 + w / 2) : curve(x + CARD_W, cy + 14 + w / 2, from.x, from.y + from.h / 2) },
    };
  }
  const bottom = Math.max(total ? y - GAP : 0, card ? card.y + card.h : 0);
  return { side: out ? 'out' : 'in', level, dx: out ? -SLIDE * level : SLIDE * level, rows: placed, card, bottom };
}

function curve(x0, y0, x1, y1) {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1}`;
}

// ---- the SVG drawing -------------------------------------------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

const cameras = new WeakMap();
/** The groups a picture is drawn into. The camera group stays for good, so changing its transform slides what is in it (CSS transition). */
function stageOf(svg) {
  let s = cameras.get(svg);
  if (!s) {
    const cam = svgEl('g', { class: 'fl-cam' }), heads = svgEl('g'), layer = svgEl('g', { transform: 'translate(0,24)' });
    cam.append(heads, layer);
    svg.replaceChildren(cam);
    s = { cam, heads, layer };
    cameras.set(svg, s);
  }
  return s;
}

/**
 * Draws the picture into `svg`, and, when `drill` is given, the opened box's breakdown and lines beside it, with the picture slid along to
 * them. `heads`: the three column headings. `fdNote(node)`: extra line under the money moved to the fixed deposits. `drill`:
 * { nodeId, rows (see layoutDrill), pickId, column: the breakdown's heading, lines: null | { state: 'loading' | 'error' | 'ok', title, summary,
 * rows: [{ date, href, sub, amount }] } }. Handlers: onNode(id) for a box, onBand(link) for a band, onRow(id) for a breakdown row.
 */
export function drawFlow(svg, layout, { heads, fdNote, drill, onNode, onBand, onRow }) {
  const { cam, heads: gHeads, layer } = stageOf(svg);
  gHeads.replaceChildren();
  layer.replaceChildren();
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const text = (parent, x, y, t, cls, anchor = 'start') => parent.append(svgEl('text', { x, y, 'text-anchor': anchor, class: cls }, t));
  const gLinks = svgEl('g'), gNodes = svgEl('g');
  layer.append(gLinks, gNodes);

  const d = drill ? layoutDrill(layout, { nodeId: drill.nodeId, rows: drill.rows === 'error' ? null : drill.rows, pickId: drill.pickId, lineCount: drill.lines?.state === 'ok' ? drill.lines.rows.length : 0 }) : null;
  const opened = drill ? byId.get(drill.nodeId) : null;
  const onPath = (l) => !opened || l.from === opened.id || l.to === opened.id;

  for (const l of layout.links) {
    const p = svgEl('path', { d: l.d, 'stroke-width': l.w, class: `fl-link fl-${l.kind}${onPath(l) ? '' : ' dim'}` });
    p.append(svgEl('title', {}, `${byId.get(l.from).label} → ${byId.get(l.to).label}: ${moneyText(l.paise)}`));
    p.addEventListener('click', () => onBand(l));
    gLinks.append(p);
  }
  for (const k of layout.kept) {
    const n = byId.get(k.account), right = k.side === 'right';
    gNodes.append(svgEl('rect', { x: n.x + (right ? 14 : -6), y: k.y, width: 6, height: k.h, class: 'fl-kept', rx: 1 }));
  }
  for (const n of layout.nodes) {
    const dim = opened && n.kind !== 'account' && n.id !== opened.id;
    const g = svgEl('g', { class: `fl-node${dim ? ' dim' : ''}${opened && n.id === opened.id ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${n.label}: ${moneyText(n.paise)}` });
    g.append(svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 3, class: `fl-box fl-${n.kind}` }));
    const tx = n.col === 0 ? n.x - 8 : n.x + n.w + 8, anchor = n.col === 0 ? 'end' : 'start';
    if (n.col === 1) {
      // an account: its name above, and below it what stayed in it (or what the deposits hold). Two levels in, the accounts have slid mostly out
      // of view, so their names are left off rather than showing as clipped fragments at the edge.
      if (!(d && d.level === 2)) {
        text(g, tx, n.y - 10, n.label, 'fl-acct halo');
        const diff = n.inPaise - n.outPaise;
        const note = n.kind === 'fd' ? fdNote?.(n) : diff !== 0 ? `${diff > 0 ? 'Kept' : 'Taken from balance'} ${moneyText(Math.abs(diff))}` : '';
        if (note) text(g, tx, n.y + n.h + 18, note, 'fl-keptnote halo');
      }
    } else {
      const mid = n.y + n.h / 2;
      text(g, tx, mid - 1, n.label, 'fl-name', anchor);
      text(g, tx, mid + 14, moneyText(n.paise), 'fl-amt', anchor);
      const note = fdNote?.(n);
      if (note) text(g, tx, mid + 29, note, 'fl-keptnote', anchor);
      if (n.noCategory) g.append(svgEl('circle', { cx: n.col === 0 ? n.x + n.w + 5 : n.x - 5, cy: n.y + 5, r: 3.5, class: 'fl-attn' }));
    }
    g.addEventListener('click', () => onNode(n.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNode(n.id); } });
    gNodes.append(g);
  }

  text(gHeads, 234, 12, heads[0], 'fl-head', 'end');
  text(gHeads, 567, 12, heads[1], 'fl-head', 'middle');
  text(gHeads, 900, 12, heads[2], 'fl-head');

  let height = layout.height;
  if (d && opened) {
    const out = d.side === 'out', kind = opened.kind;
    if (drill.rows === null) text(layer, out ? opened.x + SLIDE : opened.x - SLIDE + NW, opened.y + opened.h / 2, 'Loading…', 'fl-amt fl-fade', out ? 'start' : 'end');
    if (drill.rows === 'error') text(layer, out ? opened.x + SLIDE : opened.x - SLIDE + NW, opened.y + opened.h / 2, 'Could not load this. Click the box again to retry.', 'fl-amt fl-fade', out ? 'start' : 'end');
    for (const r of d.rows) {
      const picked = drill.pickId !== null && (drill.pickId === '*' || drill.pickId === (r.id || 'none'));
      const dim = drill.pickId !== null && !picked;
      const band = svgEl('path', { d: r.band.d, 'stroke-width': r.band.w, class: `fl-link fl-${kind}${dim ? ' dim' : ''}` });
      band.append(svgEl('title', {}, `${r.name}: ${moneyText(r.paise)}`));
      band.addEventListener('click', () => onRow(r.id || 'none'));
      gLinks.append(band);
      const g = svgEl('g', { class: `fl-node fl-fade${dim ? ' dim' : ''}${picked && drill.pickId !== '*' ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${r.name}: ${moneyText(r.paise)}` });
      g.append(svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 3, class: `fl-box fl-${kind}` }));
      const tx = out ? r.x + r.w + 8 : r.x - 8, anchor = out ? 'start' : 'end', mid = r.y + r.h / 2;
      text(g, tx, mid - 1, r.name, 'fl-name', anchor);
      text(g, tx, mid + 14, `${moneyText(r.paise)} · ${r.n} ${r.n === 1 ? 'line' : 'lines'}`, 'fl-amt', anchor);
      g.addEventListener('click', () => onRow(r.id || 'none'));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r.id || 'none'); } });
      gNodes.append(g);
    }
    if (d.rows.length && drill.column) text(gHeads, out ? opened.x + SLIDE : opened.x - SLIDE + NW, 12, drill.column, 'fl-head', out ? 'start' : 'end');
    if (d.card && drill.lines) {
      const c = d.card, lines = drill.lines;
      gLinks.append(svgEl('path', { d: c.link.d, 'stroke-width': c.link.w, class: `fl-link fl-${kind}` }));
      const g = svgEl('g', { class: 'fl-fade' });
      g.append(svgEl('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 10, class: 'fl-card' }));
      text(g, c.x + 14, c.y + 24, lines.title, 'fl-card-title');
      text(g, c.x + 14, c.y + 42, lines.state === 'loading' ? 'Loading the lines…' : lines.state === 'error' ? 'Could not load the lines. Click again to retry.' : lines.summary, 'fl-amt');
      (lines.state === 'ok' ? lines.rows : []).forEach((l, i) => {
        const y = c.y + CARD_HEAD + i * CARD_ROW;
        g.append(svgEl('line', { x1: c.x + 10, x2: c.x + c.w - 10, y1: y, y2: y, class: 'fl-rule' }));
        const a = svgEl('a', { href: l.href });
        a.append(svgEl('text', { x: c.x + 14, y: y + 17, class: 'fl-date' }, l.date), svgEl('title', {}, 'Open this line in the Ledger'));
        g.append(a, svgEl('text', { x: c.x + c.w - 14, y: y + 17, 'text-anchor': 'end', class: 'fl-name' }, l.amount), svgEl('text', { x: c.x + 14, y: y + 33, class: 'fl-amt' }, l.sub.length > 30 ? `${l.sub.slice(0, 29)}…` : l.sub));
      });
      layer.append(g);
    }
    height = Math.max(layout.height, d.bottom + 24 + 34);
  }
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${height}`);
  cam.style.transform = `translate(${d ? d.dx : 0}px, 0)`;
  return d;
}

/**
 * The month strip: received and spent for each of the 12 months of the year. Click a month, or drag across several (shift-click extends
 * the range). `onChange(months, done)` is called while dragging (done false) and when the pointer is released (done true); a click on the
 * only chosen month asks for the whole year again. Returns { set({ months, soFar, bars, chosen }) }.
 */
export function mountStrip(svg, { onChange }) {
  const Wd = 1000, Ht = 140, top = 10, base = 110, bw = 22;
  let months = [], soFar = [], bars = [], chosen = [], drag = null;
  const draw = () => {
    const step = Wd / Math.max(1, months.length);
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    const max = Math.max(1, ...bars.map((b) => Math.max(b.in, b.out)));
    svg.append(svgEl('line', { x1: 0, x2: Wd, y1: base, y2: base, class: 'fl-axis' }));
    months.forEach((m, i) => {
      const b = bars.find((x) => x.m === m) ?? { in: 0, out: 0 }, x = i * step + step / 2, on = chosen.includes(m);
      const g = svgEl('g', { class: `fl-bar${on ? '' : ' off'}`, tabindex: 0, role: 'button', 'aria-label': `${monthName(m)}: received ${moneyText(b.in)}, spent ${moneyText(b.out)}` });
      const hi = ((base - top) * b.in) / max, ho = ((base - top) * b.out) / max;
      g.append(svgEl('rect', { x: x - step / 2, y: 0, width: step, height: Ht, class: 'fl-hit' }), svgEl('rect', { x: x - bw - 1, y: base - hi, width: bw, height: hi, rx: 2, class: 'fl-in-bar' }), svgEl('rect', { x: x + 1, y: base - ho, width: bw, height: ho, rx: 2, class: 'fl-out-bar' }), svgEl('text', { x, y: base + 16, 'text-anchor': 'middle', class: 'fl-axis-label' }, monthName(m).slice(0, 3)));
      g.append(svgEl('title', {}, `${monthName(m)}: received ${moneyText(b.in)}, spent ${moneyText(b.out)}`));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(chosen.length === 1 && chosen[0] === m ? [...soFar] : [m], true); } });
      svg.append(g);
    });
  };
  const monthAt = (e) => {
    const r = svg.getBoundingClientRect();
    const m = months[Math.max(0, Math.min(months.length - 1, Math.floor(((e.clientX - r.left) / r.width) * months.length)))];
    return soFar.includes(m) ? m : soFar[soFar.length - 1];
  };
  const range = (a, b) => { const [x, y] = a <= b ? [a, b] : [b, a]; return soFar.filter((m) => m >= x && m <= y); };
  svg.addEventListener('pointerdown', (e) => {
    const m = monthAt(e);
    drag = { a: e.shiftKey && chosen.length ? (m < chosen[0] ? chosen[chosen.length - 1] : chosen[0]) : m, last: m, moved: false, single: !e.shiftKey && chosen.length === 1 && chosen[0] === m };
    svg.setPointerCapture?.(e.pointerId);
    chosen = range(drag.a, m); draw(); onChange(chosen, false);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const m = monthAt(e);
    if (m !== drag.last) { drag.last = m; drag.moved = true; chosen = range(drag.a, m); draw(); onChange(chosen, false); }
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    onChange(d.single && !d.moved ? [...soFar] : chosen, true);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  // The year can change (the page asks for another one), so what the strip shows is set each time rather than fixed at mount.
  return { set(next) { ({ months, soFar, bars, chosen } = next); draw(); } };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1];
