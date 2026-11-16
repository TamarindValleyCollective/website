// The Columns button and its menu, the same on every admin table (the shared table in data-table-ui.mjs and the Ledger in finance/ledger.astro): an
// icon button that opens a list of the columns, each with a checkbox (show or hide), move-earlier and move-later buttons, and Reset to default.
// The table owns the layout; this only edits it. Styles: styles/admin-controls.css. Built with the DOM, never as HTML.
//
//   const menu = createColumnsMenu({ labels, defaultOrder, fixed, required, getLayout, onChange });
//   toolbar.append(menu.element);          // a wrapper holding the button and the menu
//   menu.render();                          // redraw the open menu after the layout changed some other way (the header's Hide column)
//
// `labels` maps a column id to its name; `defaultOrder` lists every id; `fixed` ids are always shown and never listed (the tick column, a column of buttons);
// `required` ids can move but not hide (the Ledger's category and party, which are edited in their cells). `getLayout()` returns { order, hidden } and
// `onChange(next)` receives the layout the person asked for (null for "Reset to default"); the table cleans and applies it.
import { h } from './finance-ui.mjs';
import { iconButton } from './admin-icons.mjs';
import { moveColumn } from './data-table.mjs';

let serial = 0;

/**
 * @param {{ labels: Record<string, string>, defaultOrder: string[], fixed?: string[], required?: string[], getLayout: () => { order: string[], hidden: string[] }, onChange: (next: { order: string[], hidden: string[] } | null) => void }} options
 */
export function createColumnsMenu({ labels, defaultOrder, fixed = [], required = [], getLayout, onChange }) {
  const uid = `admin-colpop-${++serial}`;
  let open = false;
  const button = iconButton({ name: 'columns', label: 'Columns', tip: 'Choose columns', cls: 'admin-colsbtn', attrs: { 'aria-expanded': 'false', 'aria-controls': uid } });
  const pop = h('div', { class: 'admin-colpop', attrs: { id: uid, hidden: '' } });
  const element = h('div', { class: 'admin-cols' }, button, pop);

  const change = (next) => {
    onChange(next);
    render();
  };

  function render() {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const layout = getLayout();
    const movable = layout.order.filter((id) => !fixed.includes(id));
    pop.replaceChildren(
      h('h3', { text: 'Columns' }),
      ...movable.map((id, i) => {
        const shown = !layout.hidden.includes(id);
        const box = h('input', { attrs: { type: 'checkbox', id: `${uid}-${id}` } });
        box.checked = shown;
        // A required column stays; so does the last one showing when nothing is fixed to hold the table up.
        box.disabled = required.includes(id) || (shown && movable.length - layout.hidden.length <= 1 && fixed.length === 0);
        if (required.includes(id)) box.title = 'This column is edited in place, so it always shows';
        box.addEventListener('change', () => change({ ...layout, hidden: box.checked ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] }));
        const move = (delta, word, glyph, off) =>
          h('button', {
            class: 'admin-colx',
            attrs: { type: 'button', 'aria-label': `Move ${labels[id]} ${word}`, ...(off ? { disabled: '' } : {}) },
            text: glyph,
            on: { click: () => { change(moveColumn(layout, id, delta, defaultOrder, fixed)); pop.querySelector(`[data-col="${id}"] [aria-label$="${word}"]`)?.focus(); } },
          });
        return h('div', { class: 'admin-colrow', attrs: { 'data-col': id } }, h('label', { attrs: { for: `${uid}-${id}` } }, box, h('span', { text: labels[id] })), move(-1, 'earlier', '↑', i === 0), move(1, 'later', '↓', i === movable.length - 1));
      }),
      h('button', { class: 'admin-colreset', attrs: { type: 'button' }, text: 'Reset to default', on: { click: () => change(null) } }),
    );
  }

  button.addEventListener('click', () => { open = !open; render(); });
  // composedPath, not contains(e.target): a click on a button this menu has just re-drawn has a target that is no longer in the page.
  document.addEventListener('click', (e) => { if (open && !e.composedPath().includes(element)) { open = false; render(); } });
  // On the whole control, not just the menu: focus is on the button when it has just been opened from the keyboard.
  element.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; render(); button.focus(); } });

  return { element, button, render, isOpen: () => open };
}
