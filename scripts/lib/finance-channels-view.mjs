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
  order(0); order(2);
  for (const c of [0, 2]) { const i = cols[c].findIndex((n) => n.kind === 'fd'); if (i >= 0) { cols[c].push(...cols[c].splice(i, 1)); place(c); } }

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
    const outs = links.filter((l) => l.from === n.id).sort((a, b) => byId.get(a.to).y - byId.get(b.to).y);
    const ins = links.filter((l) => l.to === n.id).sort((a, b) => byId.get(a.from).y - byId.get(b.from).y);
    let o = 0; for (const l of outs) { l.w = Math.max(1.5, l.paise * k); l.sy = n.y + o; o += l.w; }
    let i = 0; for (const l of ins) { l.w = Math.max(1.5, l.paise * k); l.ty = n.y + i; i += l.w; }
  }
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to), x0 = a.x + NW, x1 = b.x, xm = (x0 + x1) / 2, y0 = l.sy + l.w / 2, y1 = l.ty + l.w / 2;
    l.d = `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1}`;
  }
  // What an account kept (more came in than went out) or took from its balance: a green strip at the foot of the shorter side.
  const kept = cols[1].map((n) => {
    const diff = n.inPaise - n.outPaise;
    return diff === 0 ? null : { account: n.id, paise: diff, side: diff > 0 ? 'right' : 'left', h: Math.max(3, Math.abs(diff) * k), y: n.y + n.paise * k - Math.max(3, Math.abs(diff) * k) };
  }).filter(Boolean);
  return { width: W, height: height + 34, nodes, links, kept, scale: k };
}

// ---- the SVG drawing -------------------------------------------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Draws the flow into `svg`. `heads`: the three column headings. `fdNote(node)`: extra line under the box of the money moved to the fixed
 * deposits (what is held). `onSelect(selection | null)`, a selection being { nodeId } or { link }. Returns { select(selection | null) } to
 * show a selection (the boxes and bands on its path stay, the rest fade).
 */
export function drawFlow(svg, layout, { heads, fdNote, onSelect, selected }) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const text = (x, y, t, cls, anchor = 'start') => svgEl('text', { x, y, 'text-anchor': anchor, class: cls }, t);
  svg.append(text(234, 12, heads[0], 'fl-head', 'end'), text(560 + 7, 12, heads[1], 'fl-head', 'middle'), text(900, 12, heads[2], 'fl-head'));
  const gLinks = svgEl('g', { transform: 'translate(0,24)' }), gNodes = svgEl('g', { transform: 'translate(0,24)' });
  svg.append(gLinks, gNodes);

  const linkEls = new Map();
  for (const l of layout.links) {
    const p = svgEl('path', { d: l.d, 'stroke-width': l.w, class: `fl-link fl-${l.kind}` });
    p.append(svgEl('title', {}, `${byId.get(l.from).label} → ${byId.get(l.to).label}: ${moneyText(l.paise)}`));
    p.addEventListener('click', () => onSelect({ link: l }));
    gLinks.append(p);
    linkEls.set(l, p);
  }
  for (const k of layout.kept) {
    const n = byId.get(k.account), right = k.side === 'right';
    gNodes.append(svgEl('rect', { x: n.x + (right ? 14 : -6), y: k.y, width: 6, height: k.h, class: 'fl-kept', rx: 1 }));
  }
  const nodeEls = new Map();
  for (const n of layout.nodes) {
    const g = svgEl('g', { class: 'fl-node', tabindex: 0, role: 'button', 'aria-label': `${n.label}: ${moneyText(n.paise)}` });
    g.append(svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 3, class: `fl-box fl-${n.kind}` }));
    const tx = n.col === 0 ? n.x - 8 : n.x + n.w + 8, anchor = n.col === 0 ? 'end' : 'start';
    if (n.kind === 'account') {
      g.append(text(tx, n.y - 10, n.label, 'fl-acct halo'));
      const diff = n.inPaise - n.outPaise;
      if (diff !== 0) g.append(text(tx, n.y + n.h + 18, `${diff > 0 ? 'Kept' : 'Taken from balance'} ${moneyText(Math.abs(diff))}`, 'fl-keptnote halo'));
    } else {
      const mid = n.y + n.h / 2;
      g.append(text(tx, mid - 1, n.label, 'fl-name', anchor), text(tx, mid + 14, moneyText(n.paise), 'fl-amt', anchor));
      const note = fdNote?.(n);
      if (note) g.append(text(tx, mid + 29, note, 'fl-keptnote', anchor));
      if (n.noCategory) g.append(svgEl('circle', { cx: n.col === 0 ? n.x + n.w + 5 : n.x - 5, cy: n.y + 5, r: 3.5, class: 'fl-attn' }));
    }
    g.addEventListener('click', () => onSelect({ nodeId: n.id }));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ nodeId: n.id }); } });
    gNodes.append(g);
    nodeEls.set(n.id, g);
  }

  const select = (sel) => {
    const keepN = new Set(), keepL = new Set();
    if (sel) {
      const walk = (id, dir) => { for (const l of layout.links) { const from = dir > 0 ? l.from : l.to, to = dir > 0 ? l.to : l.from; if (from === id) { keepL.add(l); if (!keepN.has(to)) { keepN.add(to); walk(to, dir); } } } };
      if (sel.link) { keepN.add(sel.link.from); keepN.add(sel.link.to); keepL.add(layout.links.find((l) => l.from === sel.link.from && l.to === sel.link.to)); walk(sel.link.to, 1); walk(sel.link.from, -1); }
      else { keepN.add(sel.nodeId); walk(sel.nodeId, 1); walk(sel.nodeId, -1); }
    }
    for (const [l, p] of linkEls) { p.classList.toggle('dim', Boolean(sel) && !keepL.has(l)); p.classList.toggle('on', Boolean(sel) && keepL.has(l)); }
    for (const [id, g] of nodeEls) { g.classList.toggle('dim', Boolean(sel) && !keepN.has(id)); g.classList.toggle('sel', Boolean(sel?.nodeId) && sel.nodeId === id); }
  };
  select(selected ?? null);
  return { select };
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
