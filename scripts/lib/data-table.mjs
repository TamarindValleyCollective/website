// The pure pieces of TVC's admin data table, the format the Ledger set: a search box that holds chips, a filter row under the column
// headers, Group by, Favorites. I/O-free so it is tested directly (data-table.test.mjs). The table itself, which filters and sorts
// with these, is data-table-engine.mjs (a TanStack table-core instance); data-table-ui.mjs is the DOM around both. A page describes
// its columns, chip filters and groupings, and hands over plain rows.
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

/** How many rows each chip filter would give on its own (with the other conditions in force), for the counts in the Filters list. */
export function chipCounts(rows, filters, base = () => true) {
  const counts = {};
  for (const f of filters) counts[f.id] = rows.filter((r) => base(r) && f.test(r)).length;
  return counts;
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

// ---- column layout: which columns show and in what order. Plain data { order, hidden }; a column marked `fixed` (a column of buttons,
// say) is always shown and keeps the place it has by default, and only the others move around it.
/** @typedef {{ order: string[], hidden: string[] }} ColumnLayout */

/**
 * @param {string[]} ids
 * @param {string[]} fixed
 * @param {string[]} movable
 * @returns {string[]}
 */
const placeMovable = (ids, fixed, movable) => {
  let k = 0;
  return ids.map((id) => (fixed.includes(id) ? id : movable[k++]));
};

/**
 * A saved layout made safe for the columns the table has today: unknown and repeated ids dropped, new columns follow in their default order.
 * `fixed` columns stay shown and where they are; `required` ones can move but never hide (the Ledger edits its category and party in their cells);
 * `defaultHidden` columns start hidden, both when nothing is saved and when a column is new since the layout was saved. Hiding every column is not allowed.
 *
 * @param {any} raw
 * @param {string[]} ids
 * @param {string[]} [fixed]
 * @param {string[]} [required]
 * @param {string[]} [defaultHidden]
 * @returns {ColumnLayout}
 */
export function cleanLayout(raw, ids, fixed = [], required = [], defaultHidden = []) {
  const once = (list) => (Array.isArray(list) ? list.filter((id, i) => ids.includes(id) && !fixed.includes(id) && list.indexOf(id) === i) : []);
  const saved = once(raw?.order);
  const fresh = ids.filter((id) => !fixed.includes(id) && !saved.includes(id));
  const order = placeMovable(ids, fixed, [...saved, ...fresh]);
  const hasSaved = raw && typeof raw === 'object' && (Array.isArray(raw.order) || Array.isArray(raw.hidden));
  const wanted = hasSaved ? [...once(raw.hidden), ...(Array.isArray(raw.order) ? fresh.filter((id) => defaultHidden.includes(id)) : [])] : once(defaultHidden);
  const hidden = [...new Set(wanted)].filter((id) => !required.includes(id));
  return { order, hidden: ids.every((id) => hidden.includes(id)) ? [] : hidden };
}

/** Moves a column `delta` places among the movable ones (a fixed column never moves, and nothing passes it). `ids` is the default order. */
/**
 * @param {ColumnLayout} layout
 * @param {string} id
 * @param {number} delta
 * @param {string[]} ids
 * @param {string[]} [fixed]
 * @returns {ColumnLayout}
 */
export function moveColumn(layout, id, delta, ids, fixed = []) {
  const movable = layout.order.filter((x) => !fixed.includes(x));
  const i = movable.indexOf(id);
  const j = Math.min(Math.max(i + delta, 0), movable.length - 1);
  if (i < 0 || i === j) return layout;
  [movable[i], movable[j]] = [movable[j], movable[i]];
  return { ...layout, order: placeMovable(ids, fixed, movable) };
}

// ---- cell and header menus: what "filter to this value" and "group by this column" mean in the table's own terms
const rupeesText = (paise) => String(Math.round(Number(paise)) / 100);

/**
 * The text to type under a column's filter box so that only rows with this cell's value pass (or, with `not`, every other row).
 * Null when the column's syntax cannot say it: an empty amount or date, or "not this date" (dates take only `=` and a full date).
 */
export function cellFilterText(type, value, not = false) {
  const op = not ? '!=' : '=';
  if (type === 'amount') return value == null || value === '' ? null : `${op}${rupeesText(value)}`;
  if (type === 'count') return `${op}${Number(value ?? 0)}`;
  if (type === 'date') return not || value == null || value === '' ? null : `=${value}`;
  return `${op}${String(value ?? '').trim()}`;
}

/** A grouping by the values of one column: rows with no value fall in a "No ..." group, which comes last. `groupValue` lets a column group on something other than what it shows. */
export function columnGroup(c) {
  const label = c.label ?? c.id;
  const none = `No ${String(label).toLowerCase()}`;
  const get = c.groupValue ?? c.value;
  return {
    id: `col:${c.id}`,
    label,
    key: (r) => {
      const v = get(r);
      return v == null || String(v).trim() === '' ? none : String(v).trim();
    },
  };
}
