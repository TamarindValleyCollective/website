// The Channels view (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"): the cashflow, and the channels it moves
// through. Money comes in, passes the accounts and goes out; each side can be grouped by CHANNEL (what the ledger already calls an
// origin: BHIM, Paytm, Paypro, the payment gateway, the debit card, the bank directly) or by PURPOSE (what the money was for). Pure and
// I/O-free (finance-channels.test.mjs).
//
// The fixed deposits are a holding outside the accounts, so money moved to or from them is neither received nor spent: it is drawn as its
// own pair of boxes, whichever grouping is chosen, and counted apart from Received and Spent.
//
// The server sums the ledger once into a small "cube" (channelCube: one cell per month, account, channel, direction and purpose); the
// browser then draws any period and grouping of it without asking again (flowOf).
import { CHANNELS, originOf } from './finance-origin.mjs';
import { groupOf } from './finance-metrics.mjs';

/** The key of the money moved to or from the fixed deposits, in place of a channel or a purpose. */
export const FD = '__fd';

export const OUT_PURPOSES = [
  { id: 'salary', label: 'Salary' }, { id: 'farm', label: 'Farm and household' }, { id: 'projects', label: 'Projects' },
  { id: 'company', label: 'Company' }, { id: 'sinking', label: 'Sinking fund' }, { id: 'other', label: 'Other or not yet categorised' },
];
export const IN_PURPOSES = [
  { id: 'maintenance', label: 'Maintenance from households' }, { id: 'sinking', label: 'Back from the sinking fund' }, { id: 'other', label: 'Everything else' },
];
export const GROUPINGS = ['channel', 'purpose'];

/**
 * One piece per allocation of a line (and one for what is left unallocated): { lineId, date, m, a, c, d, g, p, cat, party, paise, u }
 * (cat: the category's id, party: who it was paid to or by; both '' when none; neither is in the cube, which stays small).
 * a: account id, c: channel, d: 'in'|'out', g: purpose (out: by head, with a project's money under `projects`; in: maintenance, money back
 * from the sinking fund, or everything else), p: project id or '', u: 1 when the money has no category yet. What nobody has allocated is
 * `other` with u: 1, so each direction always adds up to the bank lines. `upiAppByLine`: bank line id -> 'bhim' | 'paytm' for lines
 * joined to a UPI row.
 */
export function channelPieces({ lines, upiAppByLine, allocations, categories }) {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const allocBy = new Map();
  for (const a of allocations) (allocBy.get(a.bank_line_id) ?? allocBy.set(a.bank_line_id, []).get(a.bank_line_id)).push(a);
  const pieces = [];
  for (const l of lines) {
    const c = originOf({ narration: l.narration, direction: l.direction }, upiAppByLine.get(l.id));
    const d = l.direction === 'debit' ? 'out' : 'in';
    const base = { lineId: l.id, date: String(l.tran_date).slice(0, 10), m: String(l.tran_date).slice(0, 7), a: l.bank_account_id, c, d };
    let left = l.amount_paise;
    for (const a of allocBy.get(l.id) ?? []) {
      const cat = cats.get(a.category_id);
      const g = d === 'out' ? groupOf(cat, a.project_id) : cat?.type === 'member_contribution' ? 'maintenance' : cat?.type === 'sinking_fund' ? 'sinking' : 'other';
      pieces.push({ ...base, g, p: d === 'out' ? a.project_id || '' : '', cat: a.category_id || '', party: a.party_id || '', paise: a.amount_paise, u: 0 });
      left -= a.amount_paise;
    }
    if (left > 0) pieces.push({ ...base, g: 'other', p: '', cat: '', party: '', paise: left, u: 1 });
  }
  return pieces;
}

/** The pieces summed into cells: { m, a, c, d, g, p, paise, n: lines, u }. */
export function channelCube(source) {
  const cells = new Map();
  const seen = new Set();
  for (const x of channelPieces(source)) {
    const key = `${x.m}|${x.a}|${x.c}|${x.d}|${x.g}|${x.p}|${x.u}`;
    const cell = cells.get(key) ?? cells.set(key, { m: x.m, a: x.a, c: x.c, d: x.d, g: x.g, p: x.p, paise: 0, n: 0, u: x.u }).get(key);
    cell.paise += x.paise;
    if (!seen.has(`${x.lineId}|${key}`)) { seen.add(`${x.lineId}|${key}`); cell.n += 1; }
  }
  return [...cells.values()];
}

// ---- dates -----------------------------------------------------------------------------------------------------------------------

/** The 12 months of a financial year ('YYYY-MM', April first). */
export function fyMonths(fy) {
  return Array.from({ length: 12 }, (_, i) => { const mm = ((3 + i) % 12) + 1, yy = mm >= 4 ? fy : fy + 1; return `${yy}-${String(mm).padStart(2, '0')}`; });
}

/** The months of the year that have begun: all 12 for a closed year, April to this month for the current one. */
export function monthsSoFar({ fy, today }) {
  const thisMonth = String(today).slice(0, 7);
  return fyMonths(fy).filter((m) => m <= thisMonth);
}

/** A preset's months: 'm1' this (latest) month, 'prev' the month before, 'm3' the last three, 'ytd' the whole year so far. */
export function presetMonths(soFar, preset) {
  if (preset === 'm1') return soFar.slice(-1);
  if (preset === 'prev') return soFar.slice(-2, -1);
  if (preset === 'm3') return soFar.slice(-3);
  return [...soFar];
}

/** Every month from a to b (either order) that has begun. */
export function rangeOf(soFar, a, b) {
  const [x, y] = a <= b ? [a, b] : [b, a];
  return soFar.filter((m) => m >= x && m <= y);
}

/** The same number of months straight before the chosen ones, within the year; null if the year does not reach back that far. */
export function previousMonths(allMonths, chosen) {
  const ms = allMonths.filter((m) => chosen.includes(m));
  if (!ms.length) return null;
  const i = allMonths.indexOf(ms[0]);
  return i - ms.length < 0 ? null : allMonths.slice(i - ms.length, i);
}

// ---- figures ---------------------------------------------------------------------------------------------------------------------

/** What was received and spent in the months, and what moved to and from the fixed deposits (neither received nor spent). */
export function totalsOf(cube, months) {
  const set = new Set(months);
  let received = 0, spent = 0, toFd = 0, fromFd = 0;
  for (const c of cube) {
    if (!set.has(c.m)) continue;
    if (c.g === 'sinking') { if (c.d === 'out') toFd += c.paise; else fromFd += c.paise; } else if (c.d === 'in') received += c.paise; else spent += c.paise;
  }
  const moved = toFd - fromFd;
  return { received, spent, toFd, fromFd, moved, left: received - spent - moved };
}

/** Received and spent for each month, for the strip (the fixed deposits' moves are not in it). */
export function monthBars(cube, months) {
  const by = new Map(months.map((m) => [m, { m, in: 0, out: 0 }]));
  for (const c of cube) if (c.g !== 'sinking' && by.has(c.m)) by.get(c.m)[c.d] += c.paise;
  return [...by.values()];
}

// ---- the flow --------------------------------------------------------------------------------------------------------------------

const channelLabel = (k) => CHANNELS[k]?.label ?? k;
const purposeLabel = (side, k) => (side === 'in' ? IN_PURPOSES : OUT_PURPOSES).find((p) => p.id === k)?.label ?? k;

/** The key a cell belongs to on one side: the fixed deposits first, then its channel or its purpose. */
export const keyOf = (cell, grouping) => (cell.g === 'sinking' ? FD : grouping === 'channel' ? cell.c : cell.g);

/**
 * The cashflow of the months: money in (grouped), the accounts, money out (grouped). Nodes: { id, col: 0|1|2, kind: 'in'|'out'|'fd'|'account',
 * key, label, paise, n, noCategory }; accounts also have inPaise and outPaise (what is left is what stayed there, or came out of the balance).
 * Links: { from, to, paise, kind: 'in'|'out'|'fd' }. Accounts with no money in the months are left out.
 */
export function flowOf({ cube, accounts, months, groupIn = 'channel', groupOut = 'channel' }) {
  const set = new Set(months);
  const cells = cube.filter((c) => set.has(c.m));
  const sides = { in: new Map(), out: new Map() }, hub = new Map(), links = new Map();
  const grouping = { in: groupIn, out: groupOut };
  for (const c of cells) {
    const key = keyOf(c, grouping[c.d]);
    const side = sides[c.d];
    const e = side.get(key) ?? side.set(key, { paise: 0, n: 0, un: 0 }).get(key);
    e.paise += c.paise; e.n += c.n; if (c.u) e.un += c.n;
    const h = hub.get(c.a) ?? hub.set(c.a, { inPaise: 0, outPaise: 0, n: 0 }).get(c.a);
    if (c.d === 'in') h.inPaise += c.paise; else h.outPaise += c.paise;
    h.n += c.n;
    const lk = c.d === 'in' ? `L:${key}|A:${c.a}` : `A:${c.a}|R:${key}`;
    links.set(lk, (links.get(lk) ?? 0) + c.paise);
  }
  const nodes = [];
  const sideNodes = (d, col, prefix) => [...sides[d]].sort((x, y) => y[1].paise - x[1].paise || (x[0] < y[0] ? -1 : 1)).map(([key, e]) => ({
    id: `${prefix}:${key}`, col, kind: key === FD ? 'fd' : d, key,
    label: key === FD ? (d === 'in' ? 'From fixed deposits' : 'To fixed deposits') : grouping[d] === 'channel' ? channelLabel(key) : purposeLabel(d, key),
    sub: key !== FD && grouping[d] === 'channel' ? CHANNELS[key]?.hint ?? '' : '',
    paise: e.paise, n: e.n, noCategory: e.un,
  }));
  nodes.push(...sideNodes('in', 0, 'L'));
  for (const a of accounts) {
    const h = hub.get(a.id);
    if (h && (h.inPaise > 0 || h.outPaise > 0)) nodes.push({ id: `A:${a.id}`, col: 1, kind: 'account', key: a.id, label: a.label, sub: '', paise: Math.max(h.inPaise, h.outPaise), n: h.n, noCategory: 0, inPaise: h.inPaise, outPaise: h.outPaise });
  }
  nodes.push(...sideNodes('out', 2, 'R'));
  const out = [];
  for (const [lk, paise] of links) {
    if (paise <= 0) continue;
    const [from, to] = lk.split('|');
    out.push({ from, to, paise, kind: from === `L:${FD}` || to === `R:${FD}` ? 'fd' : from.startsWith('L:') ? 'in' : 'out' });
  }
  const t = totalsOf(cube, months);
  return { nodes, links: out, ...t, hasData: nodes.length > 0 };
}

// ---- what a click on the picture means -------------------------------------------------------------------------------------------

/**
 * The cells behind a box or band, as a filter: { dir?, account?, channel?, purpose?, fd?: 'only' | 'exclude' }. `node` is a flowOf node;
 * `link` is a flowOf link (then `nodes` has both ends). A channel or purpose box leaves the fixed deposits out, because they have a box of their own.
 * @param {{ node?: any, link?: any, nodes: any[], groupIn: string, groupOut: string }} pick
 */
export function specOf({ node, link, nodes, groupIn, groupOut }) {
  /** @type {(n: any, dir: string) => Record<string, string>} */
  const one = (n, dir) => {
    if (n.kind === 'account') return { account: n.key };
    const grouping = n.col === 0 ? groupIn : groupOut;
    if (n.kind === 'fd') return { dir, fd: 'only' };
    return grouping === 'channel' ? { dir, channel: n.key, fd: 'exclude' } : { dir, purpose: n.key, fd: 'exclude' };
  };
  if (!link) return node.kind === 'account' ? { account: node.key } : one(node, node.col === 0 ? 'in' : 'out');
  const [a, b] = [nodes.find((n) => n.id === link.from), nodes.find((n) => n.id === link.to)];
  const side = a.col === 0 ? one(a, 'in') : one(b, 'out');
  const acct = a.kind === 'account' ? a : b;
  return { ...side, account: acct.key };
}

/** Whether a cell is behind a spec, within the months. */
export function cellMatches(cell, spec, months) {
  if (!months.includes(cell.m)) return false;
  if (spec.dir && cell.d !== spec.dir) return false;
  if (spec.account && cell.a !== spec.account) return false;
  if (spec.channel && cell.c !== spec.channel) return false;
  if (spec.purpose && cell.g !== spec.purpose) return false;
  if (spec.fd === 'only' && cell.g !== 'sinking') return false;
  if (spec.fd === 'exclude' && cell.g === 'sinking') return false;
  if (spec.project && cell.p !== (spec.project === 'none' ? '' : spec.project)) return false;   // 'none': money for projects that names no project
  // Who it was paid to or by, and its category, are on the pieces (the lines), not on the cube's cells; 'none' means nobody named / no category yet.
  if (spec.party && cell.party !== (spec.party === 'none' ? '' : spec.party)) return false;
  if (spec.category && cell.cat !== (spec.category === 'none' ? '' : spec.category)) return false;
  return true;
}

/**
 * How a clicked box or band is broken down, the same way for every purpose: Projects by project, Salary by employee (who it was paid to),
 * Maintenance by who paid it, every other purpose by category, and a channel by what its money was for. 'project' and 'purpose' come from the
 * cube in the browser; 'party' and 'category' need the lines, so the server groups them (GET /channels/breakdown). null: an account or the
 * fixed deposits, which go straight to their lines.
 * @param {Record<string, string>} spec as made by specOf
 * @returns {'project' | 'party' | 'category' | 'purpose' | null}
 */
export function breakdownOf(spec) {
  if (spec.fd === 'only') return null;
  if (spec.purpose === 'projects') return 'project';
  if (spec.purpose === 'salary' || spec.purpose === 'maintenance') return 'party';
  if (spec.purpose) return 'category';
  if (spec.channel) return 'purpose';
  return null;
}

/** What a channel's money was for, purpose by purpose (the fixed deposits left out): [{ id, name, paise, n }], biggest first. */
export function purposesOf({ cube, months, spec }) {
  const dir = spec.dir === 'in' ? 'in' : 'out';
  const labels = new Map((dir === 'in' ? IN_PURPOSES : OUT_PURPOSES).map((p) => [p.id, p.label]));
  const by = new Map();
  for (const c of cube) {
    if (!cellMatches(c, { ...spec, purpose: undefined }, months)) continue;
    const e = by.get(c.g) ?? by.set(c.g, { id: c.g, name: labels.get(c.g) ?? c.g, paise: 0, n: 0 }).get(c.g);
    e.paise += c.paise;
    e.n += c.n;
  }
  return [...by.values()].sort((a, b) => b.paise - a.paise || (a.name < b.name ? -1 : 1));
}

/**
 * Pieces grouped by party or category: [{ id ('' when none), name, paise, n: lines }], biggest first. `names`: id -> name; what has none is
 * 'No one named' / 'No category yet'.
 */
export function groupPieces(pieces, by, names) {
  const field = by === 'party' ? 'party' : 'cat';
  const none = by === 'party' ? 'No one named' : 'No category yet';
  const groups = new Map(), seen = new Set();
  for (const p of pieces) {
    const id = p[field];
    const e = groups.get(id) ?? groups.set(id, { id, name: id ? names.get(id) ?? (by === 'party' ? 'Someone no longer listed' : 'Another category') : none, paise: 0, n: 0 }).get(id);
    e.paise += p.paise;
    if (!seen.has(`${id}|${p.lineId}`)) { seen.add(`${id}|${p.lineId}`); e.n += 1; }
  }
  return [...groups.values()].sort((a, b) => b.paise - a.paise || (a.name < b.name ? -1 : 1));
}

/**
 * What the money grouped as "Projects" went to, project by project: [{ id ('' when no project is named), name, paise, n: lines }], biggest first.
 * `spec` is the filter of the box or band that was clicked; its own `project`, if any, is ignored so every project is listed.
 */
export function projectsOf({ cube, months, spec, projects }) {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const by = new Map();
  for (const c of cube) {
    if (!cellMatches(c, { ...spec, project: undefined }, months)) continue;
    const e = by.get(c.p) ?? by.set(c.p, { id: c.p, name: c.p ? names.get(c.p) ?? 'Another project' : 'No project named', paise: 0, n: 0 }).get(c.p);
    e.paise += c.paise;
    e.n += c.n;
  }
  return [...by.values()].sort((a, b) => b.paise - a.paise || (a.name < b.name ? -1 : 1));
}
