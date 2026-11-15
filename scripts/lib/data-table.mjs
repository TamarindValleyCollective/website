// The logic of TVC's admin data table, the format the Ledger set: a search box that holds chips, a filter row under the column
// headers, Group by, Favorites. Pure and I/O-free so it is tested directly (data-table.test.mjs); data-table-ui.mjs is the DOM
// around it. A page describes its columns, chip filters and groupings, and hands over plain rows.
//
// Column filters use the Ledger's syntax (finance-columns.mjs): words match anywhere, = exact, != not, ^ starts with, ! does not
// contain; numbers take >1000, <=500, 1000..3000; dates take 2026-10, >2026-10-15, 2026-10-01..2026-10-31.
import { parseText, matchText, parseAmount, matchAmount, parseDate, matchDate } from './finance-columns.mjs';

/**
 * Column types: 'text' (the default), 'amount' (rupees, matched against paise), 'date' (ISO yyyy-mm-dd), 'count' (a whole number,
 * typed like an amount without the paise), 'none' (no filter box).
 */
export function parseColumnFilter(type, raw) {
  if (type === 'amount') return parseAmount(raw);
  if (type === 'date') return parseDate(raw);
  if (type === 'count') {
    const t = String(raw ?? '').trim();
    if (!t) return null;
    const c = parseAmount(t);
    // A count is typed as a whole number: reuse the amount grammar and scale back.
    return c?.error ? { error: 'Use a number like 2, a comparison like >1, or a range like 1..3.' } : { ...c, kind: 'count' };
  }
  return parseText(raw);
}

export function matchColumn(type, cond, value) {
  if (!cond || cond.error) return true;
  if (type === 'amount') return value == null ? false : matchAmount(cond, Number(value));
  if (type === 'count') return matchAmount(cond, Number(value ?? 0) * 100);
  if (type === 'date') return value ? matchDate(cond, String(value)) : false;
  return matchText(cond, value ?? '');
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Every word typed in the search box must appear somewhere in the row's search text (case and punctuation ignored). */
export const passesWords = (hay, words) => {
  const h = norm(hay);
  return words.every((w) => norm(w).split(' ').every((x) => !x || h.includes(x)));
};

/**
 * The rows that pass. `chips` are the ids of chip filters in force (all must pass); `filters` define them as { id, test(row) };
 * `words` come from the search box; `cols` maps a column id to the text typed under it.
 * Returns { rows, errors } where errors maps a column id to the message for a condition that cannot be understood.
 */
export function filterRows(rows, { columns = [], chips = [], filters = [], words = [], searchText = () => '', cols = {} } = {}) {
  // Chips of one `group` (BHIM and Paytm, say) are alternatives: a row passes if it passes any of them. Different groups all have to pass.
  const byGroup = new Map();
  for (const id of chips) {
    const f = filters.find((x) => x.id === id);
    if (f) byGroup.set(f.group ?? f.id, [...(byGroup.get(f.group ?? f.id) ?? []), f.test]);
  }
  const tests = [...byGroup.values()].map((list) => (r) => list.some((t) => t(r)));
  const conds = [];
  const errors = {};
  for (const c of columns) {
    const typed = cols[c.id];
    if (!typed || c.filter === 'none') continue;
    const type = c.type ?? 'text';
    const cond = parseColumnFilter(type, typed);
    if (cond?.error) errors[c.id] = cond.error;
    else if (cond) conds.push({ c, type, cond });
  }
  const out = rows.filter(
    (r) =>
      tests.every((t) => t(r)) &&
      (!words.length || passesWords(searchText(r), words)) &&
      conds.every(({ c, type, cond }) => matchColumn(type, cond, (c.filterValue ?? c.value)(r))),
  );
  return { rows: out, errors };
}

/** How many rows each chip filter would give on its own (with the other conditions in force), for the counts in the Filters list. */
export function chipCounts(rows, filters, base = () => true) {
  const counts = {};
  for (const f of filters) counts[f.id] = rows.filter((r) => base(r) && f.test(r)).length;
  return counts;
}

/** A comparator for a column. Empty cells go last whichever way; ties keep the order the rows came in. */
export function compareBy(column, dir = 1) {
  const get = column.sortValue ?? column.value;
  const empty = (v) => v == null || v === '';
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    if (empty(x) !== empty(y)) return empty(x) ? 1 : -1;
    if (empty(x)) return 0;
    const n = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).toLowerCase().localeCompare(String(y).toLowerCase());
    return n * dir;
  };
}

export function sortRows(rows, column, dir = 1) {
  if (!column) return rows;
  const cmp = compareBy(column, dir);
  return rows.map((r, i) => [r, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(([r]) => r);
}

/**
 * Splits rows (already in the order the page wants inside a group) into the flat list the table draws:
 * { kind: 'group', key, label, count, open } then its rows, or nothing for a collapsed group. `group` is { id, key(row), order?, descending?,
 * format?(key) }; `order` lists keys in the order to show them, others follow alphabetically (backwards when `descending`), then "No ..." groups
 * last; `format` turns a key into the heading (2026-10 into October 2026).
 */
export function buildItems(rows, group, collapsed = new Set()) {
  if (!group) return { items: rows.map((row) => ({ kind: 'row', row })), visible: rows };
  const groups = new Map();
  for (const r of rows) {
    const k = String(group.key(r));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rank = (k) => (group.order?.includes(k) ? group.order.indexOf(k) : group.order ? group.order.length : 0);
  const sign = group.descending ? -1 : 1;
  const keys = [...groups.keys()].sort((a, b) => {
    const none = (k) => /^No /.test(k);
    if (none(a) !== none(b)) return none(a) ? 1 : -1;
    return rank(a) - rank(b) || a.localeCompare(b) * sign;
  });
  const items = [];
  const visible = [];
  for (const k of keys) {
    const members = groups.get(k);
    const key = `${group.id}:${k}`;
    const open = !collapsed.has(key);
    items.push({ kind: 'group', key, label: group.format ? group.format(k) : k, count: members.length, open });
    if (open) for (const row of members) { items.push({ kind: 'row', row }); visible.push(row); }
  }
  return { items, visible };
}

// ---- favorites: a named view that can be put back (chips, search words, grouping, sort). Plain data, nothing derived.
export function cleanFavorite(raw, { chipIds = null, groupIds = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, 60);
  if (!name) return null;
  const chips = Array.isArray(raw.chips) ? raw.chips.filter((c) => typeof c === 'string' && (!chipIds || chipIds.includes(c))) : [];
  const words = Array.isArray(raw.words) ? raw.words.map((w) => String(w).trim().slice(0, 80)).filter(Boolean) : [];
  const group = typeof raw.group === 'string' && (!groupIds || groupIds.includes(raw.group)) ? raw.group : '';
  return { name, chips, words, group };
}

export function readFavorites(json, allowed) {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.map((f) => cleanFavorite(f, allowed)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Adds a favorite, replacing one with the same name (any case). */
export function withFavorite(list, fav, allowed) {
  const clean = cleanFavorite(fav, allowed);
  if (!clean) return list;
  return [...list.filter((f) => f.name.toLowerCase() !== clean.name.toLowerCase()), clean];
}
