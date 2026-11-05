// Column search and sort for the Ledger table (docs/finance/FINANCE.md, "The table"), after ServiceNow's list view: type under a
// column header to filter it, click a header to sort. Pure and I/O-free so it is tested directly (finance-columns.test.mjs); the
// Function parses what the page sends and applies it to every line, not just the page on screen.
//
// What can be typed:
//   text columns (narration, category, party, wording):  word      contains (any case)
//                                                          =word     is exactly      !=word    is not exactly
//                                                          ^word     starts with     !word     does not contain
//                                                          =         is empty        !=        is not empty
//   amount (rupees):   2500   >2500   >=2500   <2500   <=2500   =2500   !=2500   1000..3000
//   date:              2026-10 or oct (contains the ISO date or the day-and-month label)   >2026-10-15   >=   <   <=   =   2026-10-01..2026-10-31
// A condition that cannot be understood comes back as { error } so the page can say so, instead of quietly showing everything.

const cut = (raw) => String(raw ?? '').trim();

// ---- text
export function parseText(raw) {
  const t = cut(raw);
  if (!t) return null;
  let op = 'contains';
  let value = t;
  if (t.startsWith('!=')) [op, value] = ['ne', t.slice(2)];
  else if (t.startsWith('=')) [op, value] = ['eq', t.slice(1)];
  else if (t.startsWith('^')) [op, value] = ['starts', t.slice(1)];
  else if (t.startsWith('!')) [op, value] = ['notcontains', t.slice(1)];
  value = value.trim();
  return { kind: 'text', op, raw: value, value: value.toLowerCase() };
}

export function matchText(cond, cell) {
  if (!cond) return true;
  const c = cut(cell).toLowerCase();
  const v = cond.value;
  switch (cond.op) {
    case 'eq': return c === v;
    case 'ne': return c !== v;
    case 'starts': return c.startsWith(v);
    case 'notcontains': return v === '' ? true : !c.includes(v);
    default: return c.includes(v);
  }
}

// ---- amount, in rupees (matched against paise)
const NUMBER = String.raw`\d+(?:\.\d{1,2})?`;
const toPaise = (text) => {
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || 0);
};
const AMOUNT_ERROR = 'Use a number like 2500, a comparison like >2500, or a range like 1000..3000 (rupees).';

export function parseAmount(raw) {
  const t = cut(raw).replace(/[,\s₹]/g, '');
  if (!t) return null;
  const range = new RegExp(`^(${NUMBER})\\.\\.(${NUMBER})$`).exec(t);
  if (range) {
    const [a, b] = [toPaise(range[1]), toPaise(range[2])];
    return a <= b ? { kind: 'amount', op: 'between', a, b, shown: [range[1], range[2]] } : { error: 'The range starts higher than it ends.' };
  }
  const single = new RegExp(`^(>=|<=|!=|>|<|=)?(${NUMBER})$`).exec(t);
  if (!single) return { error: AMOUNT_ERROR };
  return { kind: 'amount', op: single[1] ?? '=', a: toPaise(single[2]), shown: [single[2]] };
}

export function matchAmount(cond, paise) {
  if (!cond) return true;
  switch (cond.op) {
    case '>': return paise > cond.a;
    case '>=': return paise >= cond.a;
    case '<': return paise < cond.a;
    case '<=': return paise <= cond.a;
    case '!=': return paise !== cond.a;
    case 'between': return paise >= cond.a && paise <= cond.b;
    default: return paise === cond.a;
  }
}

// ---- date
const ISO = String.raw`\d{4}-\d{2}-\d{2}`;
export function parseDate(raw) {
  const t = cut(raw);
  if (!t) return null;
  const range = new RegExp(`^(${ISO})\\.\\.(${ISO})$`).exec(t);
  if (range) return range[1] <= range[2] ? { kind: 'date', op: 'between', a: range[1], b: range[2] } : { error: 'The range starts later than it ends.' };
  const compare = /^(>=|<=|>|<|=)\s*(.*)$/.exec(t);
  if (compare) {
    return new RegExp(`^${ISO}$`).test(compare[2]) ? { kind: 'date', op: compare[1], a: compare[2] } : { error: 'After >, <, = write a full date like 2026-10-15, or use a range like 2026-10-01..2026-10-31.' };
  }
  return { kind: 'date', op: 'contains', value: t.toLowerCase(), raw: t };
}

export function matchDate(cond, iso, label = '') {
  if (!cond) return true;
  switch (cond.op) {
    case '>': return iso > cond.a;
    case '>=': return iso >= cond.a;
    case '<': return iso < cond.a;
    case '<=': return iso <= cond.a;
    case '=': return iso === cond.a;
    case 'between': return iso >= cond.a && iso <= cond.b;
    default: return `${iso} ${label}`.toLowerCase().includes(cond.value);
  }
}

/** A condition in words, for the breadcrumb above the table: "Category != Bank charges". */
export function describeCondition(label, cond) {
  if (cond.kind === 'text') {
    if (cond.op === 'eq' && cond.raw === '') return `${label} is empty`;
    if (cond.op === 'ne' && cond.raw === '') return `${label} is not empty`;
    const words = { contains: 'contains', eq: '=', ne: '!=', starts: 'starts with', notcontains: 'does not contain' }[cond.op];
    return `${label} ${words} ${cond.raw}`;
  }
  if (cond.kind === 'amount') return cond.op === 'between' ? `${label} between ${cond.shown[0]} and ${cond.shown[1]}` : `${label} ${cond.op} ${cond.shown[0]}`;
  return cond.op === 'between' ? `${label} between ${cond.a} and ${cond.b}` : cond.op === 'contains' ? `${label} contains ${cond.raw}` : `${label} ${cond.op} ${cond.a}`;
}

// ---- sort
export const SORT_KEYS = ['date', 'narration', 'amount', 'category', 'party', 'nature', 'status'];
// Working order: what needs a person first.
const STATUS_RANK = { review: 0, unallocated: 1, partly_allocated: 2, allocated: 3 };

/**
 * A comparator for rows { id, date, narration, amount, category, party, nature, status }. Empty cells go last whichever way, so a sort
 * by Category brings the filled ones to the top. Ties break by newest date, then id, so the order is the same on every request and
 * paging never repeats or skips a line.
 */
export function compareRows(key, dir = 'desc') {
  const k = SORT_KEYS.includes(key) ? key : 'date';
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r) => (k === 'amount' ? r.amount : k === 'status' ? STATUS_RANK[r.status] ?? 9 : k === 'date' ? r.date : String(r[k] ?? '').toLowerCase());
  return (a, b) => {
    const [va, vb] = [value(a), value(b)];
    const [ea, eb] = [va === '', vb === ''];
    if (ea !== eb) return ea ? 1 : -1;
    const c = (va < vb ? -1 : va > vb ? 1 : 0) * sign;
    if (c) return c;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}
