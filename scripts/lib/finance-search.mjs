// The Ledger's search chips, Group By and Favorites (docs/finance/FINANCE.md, "Search chips and grouping"), after Odoo's search box
// (docs/finance/odoo-inspiration.md, idea 1). Pure and I/O-free so it is tested directly (finance-search.test.mjs); the page only draws.
//
// A search is: filter chips (a kind and an option), text chips (words that must all appear), and up to two Group By fields.
// Options of the same kind are alternatives ("To allocate" or "To review"); different kinds all have to hold.
//
import { ORIGINS, originLabel } from './finance-origin.mjs';

// A line here is the page's `Line`: { id, date (ISO), direction ('debit'|'credit'), amountPaise, state, review, missingParty,
// effective: { category, party }, allocation: { householdLabel, maintenanceYear } | null }.

export const FILTER_KINDS = {
  status: {
    label: 'Status',
    options: {
      unallocated: ['To allocate', (l) => l.state !== 'allocated'],
      review: ['To review', (l) => Boolean(l.review)],
      noparty: ['No party', (l) => Boolean(l.missingParty)],
      allocated: ['Allocated', (l) => l.state === 'allocated'],
    },
  },
  flow: {
    label: 'Money',
    options: {
      in: ['Money in', (l) => l.direction === 'credit'],
      out: ['Money out', (l) => l.direction === 'debit'],
    },
  },
  origin: {
    label: 'Origin',
    options: Object.fromEntries(Object.entries(ORIGINS).map(([k, o]) => [k, [o.label, (l) => l.origin === k]])),
  },
  // Period options depend on today, so they are built from a `now` ISO date.
  period: { label: 'Date' },
};

/** The date periods, relative to `now` (an ISO date). The financial year runs April to March. */
export function periodOptions(now) {
  const y = Number(now.slice(0, 4));
  const m = Number(now.slice(5, 7));
  const pad = (n) => String(n).padStart(2, '0');
  const ym = (yy, mm) => `${yy}-${pad(mm)}`;
  const prev = m === 1 ? ym(y - 1, 12) : ym(y, m - 1);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const fyStart = m >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  return {
    thismonth: ['This month', (l) => l.date.slice(0, 7) === ym(y, m)],
    lastmonth: ['Last month', (l) => l.date.slice(0, 7) === prev],
    thisquarter: ['This quarter', (l) => l.date >= `${y}-${pad(quarterStartMonth)}-01` && l.date.slice(0, 7) <= ym(y, m)],
    thisyear: ['This financial year', (l) => l.date >= fyStart && l.date.slice(0, 7) <= ym(y, m)],
  };
}

const optionsOf = (kind, now) => (kind === 'period' ? periodOptions(now) : FILTER_KINDS[kind]?.options);

export const kindLabel = (kind) => FILTER_KINDS[kind]?.label ?? kind;
export const optionLabel = (kind, option, now) => optionsOf(kind, now)?.[option]?.[0] ?? option;
export const kindsInOrder = () => Object.keys(FILTER_KINDS);
export const optionKeys = (kind, now) => Object.keys(optionsOf(kind, now) ?? {});

/** How many of `lines` each option would show on its own: [kind][option] -> number. */
export function optionCounts(lines, now) {
  const out = {};
  for (const kind of kindsInOrder()) {
    out[kind] = {};
    for (const [option, [, test]] of Object.entries(optionsOf(kind, now))) out[kind][option] = lines.filter(test).length;
  }
  return out;
}

/** Does a line pass the filter chips? `chips` is [[kind, option], ...]. Unknown chips are ignored rather than hiding everything. */
export function passesChips(line, chips, now) {
  const byKind = new Map();
  for (const [kind, option] of chips) {
    const test = optionsOf(kind, now)?.[option]?.[1];
    if (!test) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), test]);
  }
  for (const tests of byKind.values()) if (!tests.some((t) => t(line))) return false;
  return true;
}

/** Every word chip must appear somewhere in the line's search text (`hay`, lower case). */
export const passesWords = (hay, words) => words.every((w) => hay.includes(String(w).toLowerCase()));

// ---- grouping
const STATUS_WORDS = { review: 'To review', unallocated: 'To allocate', partly_allocated: 'Partly allocated', allocated: 'Allocated' };
export const GROUP_FIELDS = {
  category: ['Category', (l) => l.effective?.category || 'No category'],
  party: ['Party', (l) => l.effective?.party || 'No party'],
  unit: ['Unit', (l) => l.allocation?.householdLabel || 'No unit'],
  month: ['Month', (l) => l.date.slice(0, 7)],
  account: ['Account', (l) => l.account || 'No account'],
  origin: ['Origin', (l) => (l.origin ? originLabel(l.origin) : 'Not known')],
  status: ['Status', (l) => STATUS_WORDS[l.review ? 'review' : l.state] ?? l.state],
};
export const groupLabel = (field) => GROUP_FIELDS[field]?.[0] ?? field;

/**
 * Splits `lines` (already in the order the page wants inside a group) into the page's flat list of items:
 *   { kind: 'group', key, depth, label, count, netPaise } followed by its lines (or its sub-groups), or, when collapsed, nothing.
 * `fields` is at most two group fields; `collapsed` is a Set of group keys; `monthLabel` turns 2026-10 into a heading.
 * Groups are ordered newest first for months and biggest first for everything else, with "No ..." groups last.
 * Returns { items, visible } where `visible` is the lines that are showing (those of expanded groups), in order.
 */
export function buildItems(lines, fields, collapsed = new Set(), monthLabel = (m) => m) {
  const useFields = fields.filter((f) => GROUP_FIELDS[f]).slice(0, 2);
  const items = [];
  const visible = [];
  const net = (ls) => ls.reduce((n, l) => n + (l.direction === 'credit' ? l.amountPaise : -l.amountPaise), 0);
  const walk = (ls, depth, path) => {
    if (depth >= useFields.length) {
      for (const l of ls) {
        items.push({ kind: 'line', line: l });
        visible.push(l);
      }
      return;
    }
    const field = useFields[depth];
    const groups = new Map();
    for (const l of ls) {
      const k = GROUP_FIELDS[field][1](l);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const none = (k) => /^No /.test(k);
      if (none(a) !== none(b)) return none(a) ? 1 : -1;
      if (field === 'month') return a < b ? 1 : a > b ? -1 : 0;
      return groups.get(b).length - groups.get(a).length || a.localeCompare(b);
    });
    for (const k of keys) {
      const members = groups.get(k);
      const key = `${path}/${field}:${k}`;
      const open = !collapsed.has(key);
      items.push({ kind: 'group', key, depth, field, label: field === 'month' ? monthLabel(k) : k, count: members.length, netPaise: net(members), open });
      if (open) walk(members, depth + 1, key);
    }
  };
  walk(lines, 0, '');
  return { items, visible };
}

// ---- favorites: a named search that can be put back
/** A favorite as it is stored: plain data, nothing derived. Unreadable input becomes null. */
export function cleanFavorite(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, 60);
  if (!name) return null;
  const chips = Array.isArray(raw.chips) ? raw.chips.filter((c) => Array.isArray(c) && typeof c[0] === 'string' && typeof c[1] === 'string').map((c) => [c[0], c[1]]) : [];
  const words = Array.isArray(raw.words) ? raw.words.map((w) => String(w).trim().slice(0, 80)).filter(Boolean) : [];
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => GROUP_FIELDS[g]).slice(0, 2) : [];
  return { name, chips, words, groups };
}

export function readFavorites(json) {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.map(cleanFavorite).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Adds a favorite, replacing one with the same name (any case). */
export function withFavorite(list, fav) {
  const clean = cleanFavorite(fav);
  if (!clean) return list;
  return [...list.filter((f) => f.name.toLowerCase() !== clean.name.toLowerCase()), clean];
}

// ---- the searchable pickers: the matcher now lives with the linked picker's core, and is re-exported for the pages that import it from here
export { matchOptions } from './linked-picker-core.mjs';

// ---- the category decides who is likely to be on the other side, and what else has to be said
/** Party kinds that normally go with a category type (null: no opinion, show everyone). Maintenance has none: anybody can pay a unit's maintenance (a company, a relative), so the unit says whose it is, not the payer. The person can always widen it to all parties. */
export function partyKindsFor(categoryType) {
  return {
    revenue: ['customer', 'member'],
    opex: ['vendor', 'employee'],
    capex: ['vendor'],
    tax: ['government'],
    interest: ['bank'],
    transfer: ['bank'],
    reimbursement: ['employee', 'director', 'member'],
  }[categoryType] ?? null;
}

/** The financial year (April to March) a date falls in, named like 2026-27. */
export function financialYearOf(iso) {
  const y = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The maintenance years offered for a payment on `iso`: its own year, the two before it, and the next one (paid early). Oldest first. */
export function maintenanceYears(iso) {
  const start = Number(financialYearOf(iso).slice(0, 4));
  return [start - 2, start - 1, start, start + 1].map((s) => `${s}-${String((s + 1) % 100).padStart(2, '0')}`);
}

/**
 * The unit to SUGGEST for a maintenance payment from this payer: their own, if they are a current member who has one. It is only a suggestion (the person
 * accepts it): the payer can be anybody, so the unit is never assumed from them. A former member, a non-member or a member with no unit gives null.
 */
export function defaultUnitFor(party) {
  if (!party || party.kind !== 'member' || party.former_since || !party.household_id) return null;
  return party.household_id;
}
