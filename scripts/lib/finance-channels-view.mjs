// The Channels view's drawing (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"). Two parts: pure rules for
// what each circle and link looks like (elementsOf, tested in finance-channels-view.test.mjs), and a thin wrapper around Cytoscape.js
// (the graph: drawing, zoom, pan, drag) with the ELK layered layout (the arrangement: columns, ordered so links cross as little as
// possible). The libraries are large (Cytoscape about 130 KB and ELK about 400 KB compressed), so they are loaded only when the
// Channels tab is first opened (createChannelsView imports them), never with the rest of the dashboard.
import { lakhText, rupeesText } from './finance-dashboard-view.mjs';

const RMAX = 52;       // radius of the biggest account; banks, channels and the deposits share one scale
const DELEGATE_R = 38; // the biggest delegate; delegates have a scale of their own
const DMIN = 32;       // a tiny amount is still big enough to click

/** '₹0.23 L' from ₹10,000 up, whole rupees ('₹5,000') below. */
export const moneyText = (paise) => (paise >= 1_000_000 ? lakhText(paise, 2) : rupeesText(paise));

const fits = (text, d) => d >= 6 + text.length * 7;   // the figure goes inside a circle only where it fits

/** How full a delegate's month is against their limit: ok, warn from 80%, crit over. */
export const statusOf = (monthPaise, capPaise) => (!capPaise ? 'ok' : monthPaise > capPaise ? 'crit' : monthPaise >= 0.8 * capPaise ? 'warn' : 'ok');

/**
 * What to draw for a graph (finance-channels.mjs graphOf): Cytoscape elements. Circle area is the amount; the figure is inside where it
 * fits and under the name otherwise; a link is as thick as the money through it, between 2 and 18 px.
 */
export function elementsOf(graph) {
  const accounts = graph.nodes.filter((n) => n.kind === 'account');
  const biggest = Math.max(1, ...accounts.map((n) => n.paise), 1);
  const biggestDelegate = Math.max(1, ...graph.nodes.filter((n) => n.kind === 'delegate').map((n) => n.paise));
  const nodes = graph.nodes.map((n) => {
    let d;
    if (n.kind === 'delegate') d = Math.max(DMIN, 2 * DELEGATE_R * Math.sqrt(n.paise / biggestDelegate));
    else if (n.kind === 'fd') d = Math.max(DMIN, 2 * 0.8 * RMAX * Math.sqrt(n.paise / biggest));
    else d = Math.max(DMIN, 2 * RMAX * Math.sqrt(n.paise / biggest));
    const text = moneyText(n.paise);
    const inside = fits(text, d);
    return {
      data: {
        id: n.id, kind: n.kind, name: n.label, amountText: text, inside, w: Math.round(d * 10) / 10,
        label: inside ? n.label : `${n.label}\n${text}`,
        attention: Boolean(n.attention?.length),
        status: n.kind === 'delegate' ? statusOf(n.monthPaise ?? 0, n.capPaise) : undefined,
      },
    };
  });
  const edges = graph.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.from, target: e.to, w: Math.max(2, Math.min(18, (18 * e.paise) / Math.max(1, graph.total))), paise: e.paise } }));
  return { nodes, edges };
}

// ---- the browser part -------------------------------------------------------------------------------------------------------------

const cssVar = (name, fallback) => (typeof document === 'undefined' ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const palette = () => ({
  out: cssVar('--tvc-chart-out', '#eb6834'), in: cssVar('--tvc-chart-in', '#2a78d6'), balance: cssVar('--tvc-chart-balance', '#2a8f56'),
  ink: cssVar('--tvc-ink', '#22291f'), soft: cssVar('--tvc-ink-soft', '#57604f'), line: cssVar('--tvc-line-strong', '#8c8873'),
  warn: cssVar('--tvc-orange-text', '#965836'), crit: cssVar('--tvc-error-text', '#b3261e'),
});
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The figure inside a circle (where it fits), as an SVG data URI. */
function pictureOf(data, pal) {
  if (!data.inside) return 'none';
  const d = data.w;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><text x="${d / 2}" y="${d / 2}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-weight="700" font-size="${d >= 90 ? 15 : 12}" fill="${pal.ink}">${esc(data.amountText)}</text></svg>`)}`;
}

function styleOf(pal, dir) {
  const money = dir === 'in' ? pal.in : pal.out;
  const status = { ok: pal.balance, warn: pal.warn, crit: pal.crit };
  return [
    { selector: 'node', style: {
      width: 'data(w)', height: 'data(w)', shape: 'ellipse', label: 'data(label)', color: pal.ink, 'font-size': 12, 'font-weight': 600, 'text-wrap': 'wrap', 'text-max-width': 118,
      'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 6, 'line-height': 1.25, 'border-width': 2, 'border-color': money, 'background-color': money, 'background-opacity': 0.26,
      'background-image': (ele) => pictureOf(ele.data(), pal), 'background-fit': 'contain', 'background-clip': 'none', 'background-image-containment': 'over', 'overlay-opacity': 0, 'min-zoomed-font-size': 7,
    } },
    { selector: 'node.account', style: { 'border-color': pal.line, 'background-color': pal.soft, 'background-opacity': 0.2 } },
    { selector: 'node.fd', style: { 'border-color': pal.balance, 'background-color': pal.balance } },
    ...['ok', 'warn', 'crit'].map((s) => ({ selector: `node.delegate.${s}`, style: { 'border-color': status[s], 'background-color': status[s] } })),
    { selector: 'edge', style: { width: 'data(w)', 'line-color': money, 'curve-style': 'bezier', opacity: 0.5, 'overlay-opacity': 0, 'target-arrow-shape': 'none' } },
    { selector: 'node.dim', style: { opacity: 0.35 } },
    { selector: 'edge.dim', style: { opacity: 0.12 } },
    { selector: 'edge.hl', style: { opacity: 0.9 } },
    { selector: 'node.attention', style: { 'outline-width': 3, 'outline-color': pal.warn, 'outline-offset': 3, 'outline-style': 'solid' } },
    { selector: 'node.sel', style: { 'border-width': 4, 'border-color': pal.ink } },
  ];
}

let registered = false;

/**
 * Mounts the graph on `container`. `onSelect(id | null)` is called when a circle (or the background) is clicked. Returns
 * { render(graph), select(id), zoomBy(factor), fit(), arrange(), resize(), destroy() }.
 */
export async function createChannelsView({ container, onSelect }) {
  const [{ default: cytoscape }, { default: elk }] = await Promise.all([import('cytoscape'), import('cytoscape-elk')]);
  if (!registered) { cytoscape.use(elk); registered = true; }
  let dir = 'out';
  const cy = cytoscape({ container, elements: [], style: styleOf(palette(), dir), minZoom: 0.2, maxZoom: 3, wheelSensitivity: 0.25, boxSelectionEnabled: false, autounselectify: true });

  container._cy = cy;   // for debugging and the browser tests: where a circle is drawn
  const clearFocus = () => cy.elements().removeClass('dim hl sel');
  const focus = (id) => {
    clearFocus();
    if (!id) return;
    const node = cy.getElementById(id);
    if (node.empty()) return;
    cy.elements().not(node.closedNeighborhood()).addClass('dim');
    node.addClass('sel');
    node.connectedEdges().addClass('hl');
  };
  cy.on('tap', 'node', (e) => { const id = e.target.id(); focus(id); onSelect(id); });
  cy.on('tap', (e) => { if (e.target === cy) { clearFocus(); onSelect(null); } });
  cy.on('mouseover', 'node', (e) => { container.style.cursor = 'pointer'; if (!cy.$('.sel').length) e.target.connectedEdges().addClass('hl'); });
  cy.on('mouseout', 'node', (e) => { container.style.cursor = ''; if (!cy.$('.sel').length) e.target.connectedEdges().removeClass('hl'); });

  const layout = () => cy.layout({
    name: 'elk', fit: true, padding: 28, animate: false, nodeDimensionsIncludeLabels: true,
    elk: {
      algorithm: 'layered', 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': 120, 'elk.spacing.nodeNode': 30,
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.edgeRouting': 'POLYLINE',
    },
  }).run();

  // The colours come from the site's tokens, so a change of theme has to repaint.
  const repaint = () => cy.style(styleOf(palette(), dir)).update();
  const watchers = [];
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', repaint);
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    watchers.push(() => mq.removeEventListener('change', repaint), () => mo.disconnect());
  }

  return {
    render(graph) {
      dir = graph.dir;
      const { nodes, edges } = elementsOf(graph);
      cy.batch(() => {
        cy.elements().remove();
        cy.add([...nodes.map((n) => ({ group: 'nodes', data: n.data, classes: [n.data.kind, n.data.status, n.data.attention ? 'attention' : ''].filter(Boolean).join(' ') })), ...edges.map((e) => ({ group: 'edges', data: e.data }))]);
      });
      cy.style(styleOf(palette(), dir)).update();
      return nodes.length ? layout().promiseOn('layoutstop').then(() => undefined) : Promise.resolve();
    },
    select(id) { focus(id); },
    zoomBy(factor) { cy.zoom({ level: Math.max(0.2, Math.min(3, cy.zoom() * factor)), renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } }); },
    fit() { cy.fit(undefined, 28); },
    arrange() { return layout().promiseOn('layoutstop').then(() => undefined); },
    resize() { cy.resize(); cy.fit(undefined, 28); },
    destroy() { watchers.forEach((w) => w()); cy.destroy(); },
  };
}
