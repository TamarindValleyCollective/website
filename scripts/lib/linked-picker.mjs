// The linked picker: choose a value that lives under other values, in one field. docs/linked-picker.md says how to use it; the navigation and search
// rules are in linked-picker-core.mjs (tested). Plain DOM, no framework, no dependencies, so any page's script can use it.
//
//   const field = linkedPicker({
//     nodes: [{ value: 'fuel', label: 'Fuel' }, { value: 'maint', label: 'Maintenance', children: (path) => [...] }],
//     blank: 'Choose…', ariaLabel: 'Category',
//   });
//   field.addEventListener('change', () => use(field.path));   // ['maint', '2026-27', 'unit-id']
//
// It looks like a text field. Opening it lists one level. A row marked ⟹ goes down a level: the way back (the levels above) stays on screen as header lines,
// and the next level is listed under them. Choosing a row that ends the path closes the list and shows the whole path in the field. Typing searches only
// the rows being shown. Arrow keys move, Enter chooses or enters, Left/Backspace go up, Escape closes. Everything is placed with textContent.
import { labelsOf, levelAt, matchOptions, rowsAt, startingPath, trailOf, up } from './linked-picker-core.mjs';

/** Builds an element: h('div', { class, text, attrs }, ...children). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  el.append(...kids.filter((k) => k !== null && k !== undefined));
  return el;
}

/**
 * @typedef {{ value: string, label: string, sub?: string, search?: string, kind?: string, group?: string, selectable?: boolean, pickSub?: string, enterLabel?: string, children?: LinkedNode[] | ((path: string[]) => LinkedNode[]) }} LinkedNode
 * @param {{
 *   nodes?: LinkedNode[],
 *   path?: string[],
 *   blank?: string,
 *   placeholder?: string | null,
 *   ariaLabel?: string,
 *   separator?: string,
 *   display?: 'path' | 'leaf',
 *   rootLabel?: string,
 *   matcher?: ((nodes: LinkedNode[], query: string) => LinkedNode[]) | null,
 *   startAt?: (() => string[] | null) | null,
 *   addNew?: { label?: string, depth?: number, onAdd: (typed: string, path: string[]) => void, blockedAt?: (path: string[]) => string | null } | null,
 *   onBrowse?: ((path: string[]) => void) | null,
 * }} [config]
 *   blank: what the "none" row (at the top level) and an empty field say. placeholder: what an empty field says instead (a suggestion).
 *   display: 'path' shows "Maintenance › 2026-27 › F-01", 'leaf' only the last part. rootLabel: the top header line when browsing below the top.
 *   startAt: the level to open at (a path of ancestors), when it should not be the one holding the current choice.
 *   addNew: a last row "<label>: “typed”" at `depth` (default: every level below the top); blockedAt(path) returns a note instead when adding is not allowed there.
 */
export function linkedPicker({ nodes = [], path = [], blank = 'Choose…', placeholder = null, ariaLabel = '', separator = ' › ', display = 'path', rootLabel = 'All', matcher = null, startAt = null, addNew = null, onBrowse = null } = {}) {
  let tree = nodes;
  let chosen = [...path];
  let blankText = blank;
  let placeholderText = placeholder;
  let browse = []; // the level being looked at while open
  let pop = null;
  let shown = []; // the rows the arrow keys move over
  let active = 0;
  let query = ''; // what has been typed while open

  const input = h('input', { class: 'combo-input', attrs: { type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) } });
  const caret = h('span', { class: 'combo-caret', text: '▾', attrs: { 'aria-hidden': 'true' } });
  const el = h('div', { class: 'combo' }, input, caret);

  const textOf = (p) => {
    const labels = labelsOf(tree, p);
    if (!labels.length) return '';
    return display === 'leaf' ? labels[labels.length - 1] : labels.join(separator);
  };
  const paintText = () => {
    input.value = textOf(chosen);
    input.placeholder = placeholderText ?? blankText;
  };

  function commit(next) {
    chosen = next;
    close();
    paintText();
    el.dispatchEvent(new Event('change'));
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    input.setAttribute('aria-expanded', 'false');
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    document.removeEventListener('mousedown', outside, true);
    paintText();
  }
  function outside(e) {
    if (!el.contains(e.target) && !(pop && pop.contains(e.target))) close();
  }
  function place() {
    if (!pop || pop.classList.contains('combo-pop--inline')) return;
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.min(pop.offsetWidth, 360) - 8))}px`;
    pop.style.minWidth = `${Math.max(r.width, 260)}px`;
    const want = Math.min(pop.scrollHeight, 340);
    if (below < want + 12 && r.top > below) {
      pop.style.top = '';
      pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
      pop.style.maxHeight = `${Math.min(340, r.top - 12)}px`;
    } else {
      pop.style.bottom = '';
      pop.style.top = `${r.bottom + 4}px`;
      pop.style.maxHeight = `${Math.min(340, below - 12)}px`;
    }
  }

  function go(next) {
    browse = next;
    query = '';
    input.value = '';
    active = 0;
    render('');
    place();
    onBrowse?.(browse);
  }

  function render(query) {
    pop.replaceChildren();
    const trail = trailOf(tree, browse);
    // The way back: the levels above, as header lines you can click, indented by depth.
    if (browse.length) {
      const root = h('button', { class: 'combo-trail', text: rootLabel, attrs: { type: 'button' } });
      root.addEventListener('mousedown', (e) => (e.preventDefault(), go([])));
      pop.append(root);
      trail.forEach((t, i) => {
        const line = h('button', { class: 'combo-trail combo-trail--here', text: t.label, attrs: { type: 'button', 'aria-label': `Back to ${t.label}` } });
        line.style.paddingLeft = `${10 + (i + 1) * 12}px`;
        if (i < trail.length - 1) line.addEventListener('mousedown', (e) => (e.preventDefault(), go(t.path)));
        else line.disabled = true;
        pop.append(line);
      });
    }
    shown = [];
    if (!browse.length) shown.push({ type: 'blank', label: blankText });
    for (const row of rowsAt(tree, browse, query, matcher ?? matchOptions)) shown.push({ type: row.kind, node: row.node });
    let note = null;
    if (addNew && browse.length >= (addNew.depth ?? 1)) {
      note = addNew.blockedAt?.(browse) ?? null;
      if (!note) shown.push({ type: 'add', label: query.trim() ? `${addNew.label ?? 'Add a new entry'}: “${query.trim()}”` : `${addNew.label ?? 'Add a new entry'}…`, typed: query.trim() });
    }
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    const indent = 10 + (trail.length + (browse.length ? 1 : 0)) * 12;
    let lastGroup = '';
    shown.forEach((r, i) => {
      if (r.node?.group && r.node.group !== lastGroup) {
        lastGroup = r.node.group;
        pop.append(h('div', { class: 'combo-group', text: lastGroup }));
      }
      const cls = `combo-opt${i === active ? ' is-active' : ''}${r.type === 'add' ? ' combo-opt--add' : ''}${r.type === 'blank' ? ' combo-opt--blank' : ''}`;
      // A node that can be picked as it is AND entered shows as two rows; `enterLabel` / `pickSub` say which is which.
      const two = r.node?.children && r.node.selectable;
      const label = r.type === 'blank' || r.type === 'add' ? r.label : r.type === 'enter' && two && r.node.enterLabel ? r.node.enterLabel : r.node.label;
      const sub = r.type === 'pick' && two && r.node.pickSub ? r.node.pickSub : r.node?.sub;
      const row = h('div', { class: cls, attrs: { role: 'option', 'aria-selected': String(i === active) } }, h('span', { text: r.type === 'enter' ? `${label}` : label }), sub ? h('span', { class: 'combo-sub', text: sub }) : null, r.type === 'enter' ? h('span', { class: 'combo-enter', text: '⟹', attrs: { 'aria-hidden': 'true' } }) : null);
      if (r.type !== 'blank' && r.type !== 'add') row.style.paddingLeft = `${indent}px`;
      if (r.type === 'enter') row.setAttribute('aria-label', `${label}, opens the next level`);
      row.addEventListener('mousedown', (e) => (e.preventDefault(), act(r)));
      pop.append(row);
    });
    if (!rowsAt(tree, browse, query, matcher ?? matchOptions).length && query.trim()) pop.append(h('div', { class: 'combo-none', text: `Nothing called “${query.trim()}” here.` }));
    if (note) pop.append(h('div', { class: 'combo-note', text: note }));
    const row = pop.querySelector('.is-active');
    if (row) {
      // Scroll the list itself, never the page.
      if (row.offsetTop < pop.scrollTop) pop.scrollTop = row.offsetTop - 4;
      else if (row.offsetTop + row.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = row.offsetTop + row.offsetHeight - pop.clientHeight + 4;
    }
  }

  function act(r) {
    if (!r) return;
    if (r.type === 'blank') return commit([]);
    if (r.type === 'add') {
      const typed = r.typed ?? '';
      const at = [...browse];
      close();
      addNew.onAdd(typed, at);
      return;
    }
    if (r.type === 'enter') return go([...browse, r.node.value]);
    commit([...browse, r.node.value]);
  }

  function open() {
    if (pop) return;
    pop = h('div', { class: 'combo-pop', attrs: { role: 'listbox' } });
    if (el.closest('dialog')) {
      pop.classList.add('combo-pop--inline');
      el.append(pop);
    } else {
      // Placed before it is in the page, so it never sits at the end of the document (which would scroll the page there).
      pop.style.top = '0px';
      pop.style.left = '0px';
      pop.style.visibility = 'hidden';
      document.body.append(pop);
    }
    input.setAttribute('aria-expanded', 'true');
    const wanted = startAt?.();
    browse = wanted && levelAt(tree, wanted) ? wanted : startingPath(tree, chosen);
    query = '';
    active = 0;
    input.select();
    render('');
    place();
    pop.style.visibility = '';
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', outside, true);
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    if (!pop) open();
    query = input.value;
    active = browse.length ? 0 : 1; // the first row that is not "none"
    render(query);
    place();
  });
  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // the page's own shortcuts
    const key = e.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (!pop) open();
      active = (active + (key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render(query);
      return;
    }
    if (!pop) return;
    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      act(shown[active]);
    } else if (key === 'ArrowRight' && shown[active]?.type === 'enter') {
      e.preventDefault();
      act(shown[active]);
    } else if ((key === 'ArrowLeft' && !query && browse.length) || (key === 'Backspace' && !input.value && browse.length)) {
      e.preventDefault();
      go(up(browse));
    } else if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (key === 'Tab') close();
  });
  input.addEventListener('blur', () => setTimeout(() => !el.contains(document.activeElement) && close(), 120));

  Object.defineProperties(el, {
    path: { get: () => [...chosen], set: (p) => { chosen = [...(p ?? [])]; if (!pop) paintText(); } },
    value: { get: () => chosen[chosen.length - 1] ?? '', set: (v) => { chosen = v ? [v] : []; if (!pop) paintText(); } },
    input: { value: input },
  });
  el.setNodes = (list) => {
    tree = list;
    if (pop) render('');
    else paintText();
  };
  el.setPlaceholder = (text) => {
    placeholderText = text;
    if (!pop) paintText();
  };
  el.setBlank = (text) => {
    blankText = text;
    if (!pop) paintText();
  };
  el.setStartAt = (fn) => {
    startAt = fn;
  };
  el.focus = () => input.focus();
  paintText();
  return el;
}
