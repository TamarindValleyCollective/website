// The logic behind the linked picker (scripts/lib/linked-picker.mjs, docs/linked-picker.md): choosing a value that lives under other values
// (Maintenance > 2026-27 > a unit; Vendors > BSNL). Pure and I/O-free, so it is tested directly (linked-picker-core.test.mjs); the component only draws it.
//
// A node is { value, label, sub?, search?, kind?, children?, selectable? }:
//   value       what is stored for it (a string)
//   label       what it is called
//   sub         a small right-hand note ("F-01 · H-10", "in this unit")
//   search      extra words that find it without being its name (the people living in a unit)
//   children    the next level: an array, or a function (path) => array for long lists built when opened. A node with children is entered, not picked.
//   selectable  with children: the node can also be picked as it is (a capital category with no project), shown as its own row above "label ⟹".
//   pickSub / enterLabel  for a selectable node with children: the small note on the "pick it as it is" row, and the label of the "enter it" row, so the two read differently.
// A path is the values from the top down: ['maintenance', '2026-27', 'unit-id']. Only the rows of the level being looked at are searched.

/**
 * Every word of `query` must appear in the label, the node's `search` text or its `group` heading (any case), so typing "capital" lists everything under
 * "Capital purchases" as well as anything with "capital" in its name. Names that start with the query come first, then names with a word that does,
 * then other names that contain it, and last the ones found only through their group.
 */
export function matchOptions(options, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  const rank = (o) => {
    const l = o.label.toLowerCase();
    if (l.startsWith(words[0])) return 0;
    if (l.split(/[^a-z0-9]+/).some((w) => w.startsWith(words[0]))) return 1;
    if (l.includes(words[0]) || (o.search ?? '').toLowerCase().includes(words[0])) return 2;
    return 3;
  };
  return options
    .filter((o) => words.every((w) => `${o.label} ${o.search ?? ''} ${o.group ?? ''}`.toLowerCase().includes(w)))
    .map((o, i) => ({ o, i, r: rank(o) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);
}

const childrenOf = (node, path) => (typeof node.children === 'function' ? node.children(path) : node.children ?? null);

/** The nodes shown at `path` (the top level for an empty path), or null if the path does not lead anywhere. */
export function levelAt(nodes, path) {
  let level = nodes;
  for (let i = 0; i < path.length; i++) {
    const node = level.find((n) => n.value === path[i]);
    const next = node ? childrenOf(node, path.slice(0, i + 1)) : null;
    if (!next) return null;
    level = next;
  }
  return level;
}

/** The ancestors of the level at `path`, top first: [{ value, label, path }] (the breadcrumb lines). Stops at the first value that does not exist. */
export function trailOf(nodes, path) {
  const out = [];
  let level = nodes;
  for (let i = 0; i < path.length; i++) {
    const node = level.find((n) => n.value === path[i]);
    if (!node) break;
    out.push({ value: node.value, label: node.label, path: path.slice(0, i + 1) });
    level = childrenOf(node, path.slice(0, i + 1)) ?? [];
  }
  return out;
}

/** The labels for a path, for showing the choice: ['Maintenance', '2026-27', 'F-01 · H-10']. */
export const labelsOf = (nodes, path) => trailOf(nodes, path).map((t) => t.label);

/**
 * What is listed at `path` for a typed `query`: the matching nodes of that level only. A node with children is a row that enters it (marked), and,
 * if it is also `selectable`, a second row that picks it as it is. Each row: { kind: 'pick' | 'enter', node }.
 */
export function rowsAt(nodes, path, query, matcher = matchOptions) {
  const level = levelAt(nodes, path) ?? [];
  const rows = [];
  for (const node of matcher(level, query)) {
    const inner = Boolean(node.children);
    if (!inner) rows.push({ kind: 'pick', node });
    else {
      if (node.selectable) rows.push({ kind: 'pick', node });
      rows.push({ kind: 'enter', node });
    }
  }
  return rows;
}

/** Is `path` a complete choice (it ends at a node with no children, or at a selectable one that the person picked)? */
export function isLeaf(nodes, path) {
  if (!path.length) return false;
  const level = levelAt(nodes, path.slice(0, -1));
  const node = level?.find((n) => n.value === path[path.length - 1]);
  return Boolean(node) && !node.children;
}

/** Moves one level up (never above the top). */
export const up = (path) => path.slice(0, -1);

/** The path to start browsing from when the person opens the picker with `current` already chosen: the level that holds the last chosen value. */
export function startingPath(nodes, current) {
  const parent = current.slice(0, -1);
  return levelAt(nodes, parent) ? parent : [];
}
