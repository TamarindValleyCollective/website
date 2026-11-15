// The Channels view (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"): how money moves through the accounts and the
// channels it passes through, sliced by what it was for. Pure and I/O-free (finance-channels.test.mjs).
//
// Only money channels are circles: the accounts, the channels (what the ledger already calls an origin: BHIM, Paytm, Paypro, the
// payment gateway, the debit card, the bank directly), the delegates, who pay through a UPI app, and the fixed deposits, which sit
// outside the accounts. What the money was FOR (salary, farm and household, projects, company, sinking fund; maintenance on the way
// in) is not a channel: it is a filter on the same circles.
//
// The server sums the ledger once into a small "cube" (channelCube: one cell per month, account, channel, direction and purpose);
// the browser then draws any slice of it without asking again (graphOf).
import { CHANNELS, originOf } from './finance-origin.mjs';
import { groupOf } from './finance-metrics.mjs';

export const OUT_PURPOSES = [
  { id: 'salary', label: 'Salary' }, { id: 'farm', label: 'Farm and household' }, { id: 'projects', label: 'Projects' },
  { id: 'company', label: 'Company' }, { id: 'sinking', label: 'Sinking fund' }, { id: 'other', label: 'Other or not yet categorised' },
];
export const IN_PURPOSES = [
  { id: 'maintenance', label: 'Maintenance from households' }, { id: 'sinking', label: 'Back from the sinking fund' }, { id: 'other', label: 'Everything else' },
];

/**
 * Sum the ledger into cells: { m: 'YYYY-MM', a: account id, c: channel, d: 'in'|'out', g: purpose, p: project id or '', paise, n: lines, u: 1 when
 * the money has no category yet }. A line is split by its allocations (out: by group, with a project's money under `projects`; in:
 * maintenance, money back from the sinking fund, or everything else); what nobody has allocated is `other`, flagged `u`, so each
 * direction always adds up to the bank lines. `upiAppByLine`: bank line id -> 'bhim' | 'paytm' for lines joined to a UPI row.
 */
export function channelCube({ lines, upiAppByLine, allocations, categories }) {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const allocBy = new Map();
  for (const a of allocations) (allocBy.get(a.bank_line_id) ?? allocBy.set(a.bank_line_id, []).get(a.bank_line_id)).push(a);
  const cells = new Map();
  for (const l of lines) {
    const c = originOf({ narration: l.narration, direction: l.direction }, upiAppByLine.get(l.id));
    const d = l.direction === 'debit' ? 'out' : 'in';
    const m = String(l.tran_date).slice(0, 7);
    const seen = new Set();
    const add = (g, p, paise, u) => {
      const key = `${m}|${l.bank_account_id}|${c}|${d}|${g}|${p}|${u}`;
      const cell = cells.get(key) ?? cells.set(key, { m, a: l.bank_account_id, c, d, g, p, paise: 0, n: 0, u }).get(key);
      cell.paise += paise;
      if (!seen.has(key)) { seen.add(key); cell.n += 1; }
    };
    let left = l.amount_paise;
    for (const a of allocBy.get(l.id) ?? []) {
      const cat = cats.get(a.category_id);
      if (d === 'out') add(groupOf(cat, a.project_id), a.project_id || '', a.amount_paise, 0);
      else add(cat?.type === 'member_contribution' ? 'maintenance' : cat?.type === 'sinking_fund' ? 'sinking' : 'other', '', a.amount_paise, 0);
      left -= a.amount_paise;
    }
    if (left > 0) add('other', '', left, 1);
  }
  return [...cells.values()];
}

/** The months of a period as 'YYYY-MM', oldest first. A closed financial year has only the whole year. */
export function monthsOfPeriod({ fy, today, period }) {
  const thisMonth = String(today).slice(0, 7);
  const todayFy = Number(thisMonth.slice(5, 7)) >= 4 ? Number(thisMonth.slice(0, 4)) : Number(thisMonth.slice(0, 4)) - 1;
  const all = [];
  for (let i = 0; i < 12; i++) {
    const month = 4 + i, year = month > 12 ? fy + 1 : fy, mm = ((month - 1) % 12) + 1;
    all.push(`${year}-${String(mm).padStart(2, '0')}`);
  }
  if (fy >= todayFy) while (all.length && all[all.length - 1] > thisMonth) all.pop();
  const p = fy < todayFy ? 'ytd' : period;
  return p === 'm3' ? all.slice(-3) : p === 'm1' ? all.slice(-1) : all;
}

const validPurpose = (dir, purpose) => {
  if (purpose === 'all') return 'all';
  if (dir === 'out') return OUT_PURPOSES.some((p) => p.id === purpose) || String(purpose).startsWith('project:') ? purpose : 'all';
  return IN_PURPOSES.some((p) => p.id === purpose) ? purpose : 'all';
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The graph of one slice. `filters`: { months: ['YYYY-MM', ...], dir: 'out'|'in', account: 'all' | account id, purpose: 'all' | a purpose id |
 * 'project:<id>' }. Nodes: { id, kind: 'account'|'channel'|'delegate'|'fd', label, paise, n, ... }; edges follow the money: out, from the account
 * through the channel (and on to a delegate or the deposits); in, from the channel into the account (and from the deposits). Channels that
 * carried nothing in this slice are left out. `fd.balances`: month -> the deposits' balance at the end of it.
 */
export function graphOf({ cube, accounts, delegates, delegatePayments, fd, projects, filters }) {
  const dir = filters.dir === 'in' ? 'in' : 'out';
  const months = new Set(filters.months);
  const lastMonth = [...months].sort().pop();
  const account = filters.account ?? 'all';
  const purpose = validPurpose(dir, filters.purpose ?? 'all');
  const wantsGroup = purpose === 'all' ? null : purpose.startsWith('project:') ? 'projects' : purpose;
  const wantsProject = purpose.startsWith('project:') ? purpose.slice(8) : null;
  const matches = (c) => months.has(c.m) && c.d === dir && (account === 'all' || c.a === account) && (wantsGroup === null || c.g === wantsGroup) && (wantsProject === null || c.p === wantsProject);

  const byAccount = new Map(), byChannel = new Map(), links = new Map(), noCategory = new Map();
  const bump = (map, key, paise, n) => { const e = map.get(key) ?? map.set(key, { paise: 0, n: 0 }).get(key); e.paise += paise; e.n += n; };
  for (const c of cube) {
    if (!matches(c)) continue;
    bump(byAccount, c.a, c.paise, c.n);
    bump(byChannel, c.c, c.paise, c.n);
    bump(links, `${c.a}|${c.c}`, c.paise, c.n);
    if (c.u) noCategory.set(c.c, (noCategory.get(c.c) ?? 0) + c.n);
  }

  const nodes = [], edges = [];
  for (const a of accounts) {
    const e = byAccount.get(a.id);
    if (e && e.paise > 0) nodes.push({ id: `acct:${a.id}`, kind: 'account', label: a.label, paise: e.paise, n: e.n });
  }
  const chanIds = [...byChannel.keys()].sort((x, y) => byChannel.get(y).paise - byChannel.get(x).paise || (x < y ? -1 : 1));
  for (const c of chanIds) {
    const e = byChannel.get(c), un = purpose === 'all' ? noCategory.get(c) ?? 0 : 0;
    nodes.push({ id: `ch:${c}`, kind: 'channel', label: CHANNELS[c]?.label ?? c, sub: CHANNELS[c]?.hint ?? '', channel: c, paise: e.paise, n: e.n, attention: un ? [{ tone: 'warn', text: `${plural(un, 'line has', 'lines have')} no category` }] : [] });
  }
  for (const [key, e] of links) {
    if (e.paise <= 0) continue;
    const [a, c] = key.split('|');
    edges.push(dir === 'out' ? { from: `acct:${a}`, to: `ch:${c}`, paise: e.paise } : { from: `ch:${c}`, to: `acct:${a}`, paise: e.paise });
  }
  const total = nodes.filter((n) => n.kind === 'account').reduce((t, n) => t + n.paise, 0);

  // The fixed deposits: outside the accounts, so they never change the total. Money put in goes through the channel that carried it.
  if (account === 'all' && (purpose === 'all' || purpose === 'sinking')) {
    const put = new Map();
    for (const c of cube) if (months.has(c.m) && c.d === dir && c.g === 'sinking') put.set(c.c, (put.get(c.c) ?? 0) + c.paise);
    nodes.push({ id: 'fd', kind: 'fd', label: 'Fixed deposits', sub: 'Held outside the current accounts', paise: fd?.balances?.[lastMonth] ?? 0, n: 0, putPaise: [...put.values()].reduce((t, v) => t + v, 0) });
    for (const [c, paise] of put) if (paise > 0 && byChannel.has(c)) edges.push(dir === 'out' ? { from: `ch:${c}`, to: 'fd', paise } : { from: 'fd', to: `ch:${c}`, paise });
  }

  // Delegates pay through an operator's UPI app, so they hang off that channel. Their spend is not split by purpose, so only the whole picture has them.
  if (dir === 'out' && purpose === 'all' && account === 'all') {
    const byDelegate = new Map(), viaApp = new Map();
    for (const p of delegatePayments) {
      if (!months.has(p.m)) continue;
      const id = p.d ?? 'none';
      const e = byDelegate.get(id) ?? byDelegate.set(id, { paise: 0, n: 0, monthPaise: 0 }).get(id);
      e.paise += p.paise; e.n += p.n;
      if (p.m === lastMonth) e.monthPaise += p.paise;
      bump(viaApp, `${id}|${p.app}`, p.paise, p.n);
    }
    const known = new Map((delegates ?? []).map((d) => [d.id, d]));
    for (const [id, e] of [...byDelegate].sort((x, y) => y[1].paise - x[1].paise)) {
      if (e.paise <= 0) continue;
      const d = known.get(id);
      nodes.push({ id: `del:${id}`, kind: 'delegate', label: d ? d.label : 'No delegate yet', sub: d ? `Number ${d.number}` : 'Delegated payments with no delegate chosen', number: d?.number ?? null, paise: e.paise, n: e.n, monthPaise: e.monthPaise, capPaise: d?.capPaise ?? null });
    }
    for (const [key, e] of viaApp) {
      const [id, app] = key.split('|');
      if (e.paise > 0 && byChannel.has(app) && byDelegate.get(id)?.paise > 0) edges.push({ from: `ch:${app}`, to: `del:${id}`, paise: e.paise });
    }
  }

  return { dir, purpose, total, nodes, edges, projects: projects ?? [] };
}

/** What one channel's money was for, within the same months, direction and account: [{ id, label, paise }], biggest first. */
export function usedFor({ cube, filters, channelId }) {
  const dir = filters.dir === 'in' ? 'in' : 'out';
  const months = new Set(filters.months);
  const account = filters.account ?? 'all';
  const by = new Map();
  for (const c of cube) if (c.c === channelId && c.d === dir && months.has(c.m) && (account === 'all' || c.a === account)) by.set(c.g, (by.get(c.g) ?? 0) + c.paise);
  const labels = new Map((dir === 'in' ? IN_PURPOSES : OUT_PURPOSES).map((p) => [p.id, p.label]));
  return [...by].filter(([, paise]) => paise > 0).map(([id, paise]) => ({ id, label: labels.get(id) ?? id, paise })).sort((a, b) => b.paise - a.paise || (a.id < b.id ? -1 : 1));
}
