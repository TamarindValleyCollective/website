// The DOM around data-table.mjs: TVC's admin table in the format the Ledger set. A search box that holds chips (its ▾ opens
// Filters, Group by and Favorites), sortable headers over a row of column filters, group bands, row ticks with a bulk bar, and
// cards on a phone. Style: styles/data-table.css (import it in the page). Everything a row holds is placed with textContent or
// the nodes the page builds, never as HTML.
//
//   const table = createDataTable({ root, columns, rowId, searchText, filters, groups, ... });
//   table.setRows(rows);
//
// columns: [{ id, label, type: 'text'|'amount'|'date'|'count'|'none', filter: 'none' to drop the box, align: 'end',
//             value(row), sortValue?(row), filterValue?(row), render?(row) -> Node | string }]
// filters: [{ id, label, test(row) }]   chips in the Filters list; all chips in force must pass
// groups:  [{ id, label, key(row), order? }]   one level, as in the Ledger's Group by
// bulk:    [{ id, label, run(rows) }]   shown when rows are ticked
// detail:  (row) -> Node | null   a full-width row under that row (the Requests suggestions); built fresh for the table and for the card
// onUserFilter: () => void   called when the person changes a chip, the search, a column filter or the grouping (not by setRows or setChips)
// column extras: sortable: false (no sort button), wrap: true (the cell may wrap, for long text), sticky: true (the last column stays
//   in view while the table scrolls sideways, for a column of buttons)
import { buildItems, chipCounts, filterRows, readFavorites, sortRows, withFavorite } from './data-table.mjs';
import { h } from './finance-ui.mjs';

const tick = (checked, label, onChange) => {
  const box = h('input', { attrs: { type: 'checkbox', 'aria-label': label } });
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  box.addEventListener('click', (e) => e.stopPropagation());
  return box;
};

export function createDataTable(opts) {
  const {
    root, columns, rowId, searchText = () => '', filters = [], groups = [], bulk = [], selectable = bulk.length > 0, onOpen = null, card = null,
    rowClass = () => '', noun = ['row', 'rows'], favoritesKey = null, searchPlaceholder = 'Search every column', toolbarEnd = null, empty = {},
    defaultGroup = '', defaultSort = null, onChange = () => {}, onUserFilter = () => {}, detail = null, cap = Infinity,
  } = opts;
  const allowed = { chipIds: filters.map((f) => f.id), groupIds: groups.map((g) => g.id) };
  const state = { rows: [], chips: [], words: [], text: '', group: defaultGroup, sort: defaultSort ?? [null, 1], cols: {}, collapsed: new Set(), sel: new Set(), favs: [], popOpen: false };
  const colById = new Map(columns.map((c) => [c.id, c]));

  const readStore = () => {
    try { return localStorage.getItem(favoritesKey); } catch { return null; }
  };
  const writeStore = () => {
    try { localStorage.setItem(favoritesKey, JSON.stringify(state.favs)); } catch { /* storage can be blocked: favorites just do not persist */ }
  };
  if (favoritesKey) state.favs = readFavorites(readStore(), allowed);

  // ---- the frame
  const input = h('input', { attrs: { type: 'search', placeholder: searchPlaceholder, autocomplete: 'off', 'aria-label': 'Search' } });
  const chipBox = h('span', { class: 'dt-chips' });
  const caret = h('button', { class: 'dt-caret', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': 'Filters, group by and favorites', title: 'Filters, group by and favorites' }, text: '▾' });
  const pop = h('div', { class: 'dt-pop', attrs: { hidden: '' } });
  const sbox = h('div', { class: 'dt-sbox' }, chipBox, input, caret);
  const errors = h('p', { class: 'dt-errors', attrs: { role: 'status', hidden: '' } });
  const headRow = h('tr', { class: 'dt-heads' });
  const filterRow = h('tr', { class: 'dt-filters' });
  const body = h('tbody');
  const scroll = h('div', { class: 'dt-scroll' }, h('table', { class: 'dt-table' }, h('thead', {}, headRow, filterRow), body));
  const cards = h('div', { class: 'dt-cards' });
  const emptyBox = h('div', { class: 'dt-empty', attrs: { 'aria-live': 'polite', hidden: '' } });
  const foot = h('p', { class: 'dt-foot', attrs: { 'aria-live': 'polite' } });
  const bulkBar = h('div', { class: 'dt-bulk', attrs: { role: 'region', 'aria-label': 'Selected rows', hidden: '' } });
  root.classList.add('dt');
  root.replaceChildren(h('div', { class: 'dt-tools' }, h('div', { class: 'dt-search' }, sbox, pop), toolbarEnd), errors, scroll, cards, emptyBox, foot, bulkBar);

  // ---- what is showing
  let shown = [];
  function compute() {
    const sortCol = colById.get(state.sort[0]);
    const filtered = filterRows(state.rows, { columns, chips: state.chips, filters, words: [...state.words, ...(state.text ? [state.text] : [])], searchText, cols: state.cols });
    shown = sortRows(filtered.rows, sortCol, state.sort[1]);
    const msgs = Object.entries(filtered.errors).map(([id, m]) => `${colById.get(id)?.label ?? id}: ${m}`);
    errors.textContent = msgs.join(' ');
    errors.hidden = msgs.length === 0;
  }
  const groupDef = () => groups.find((g) => g.id === state.group) ?? null;

  // ---- search box chips
  function renderChips() {
    const chipEl = (kind, text, remove) =>
      h('span', { class: 'dt-chip' }, h('b', { text: kind }), document.createTextNode(text), h('button', { attrs: { type: 'button', 'aria-label': `Remove ${kind.toLowerCase()} ${text}` }, text: '×', on: { click: remove } }));
    chipBox.replaceChildren(
      ...state.chips.map((id) => chipEl('Filter', filters.find((f) => f.id === id)?.label ?? id, () => { onUserFilter(); state.chips = state.chips.filter((x) => x !== id); render(); })),
      ...state.words.map((w, i) => chipEl('Search', w, () => { onUserFilter(); state.words.splice(i, 1); render(); })),
      ...(state.group ? [chipEl('Group by', groupDef()?.label ?? state.group, () => { onUserFilter(); state.group = ''; render(); })] : []),
    );
    input.placeholder = state.chips.length || state.words.length || state.group ? '' : searchPlaceholder;
  }

  // ---- the Filters / Group by / Favorites popover
  function option(label, pressed, onClick, extra = '') {
    return h('button', { class: 'dt-opt', attrs: { type: 'button', 'aria-pressed': String(pressed) }, on: { click: onClick } }, h('span', { text: label }), extra ? h('em', { text: extra }) : null);
  }
  function renderPop() {
    pop.hidden = !state.popOpen;
    caret.setAttribute('aria-expanded', String(state.popOpen));
    if (!state.popOpen) return;
    // Counts: how many rows each filter gives with everything else already in force.
    const others = (id) => (r) => state.chips.filter((c) => c !== id).every((c) => filters.find((f) => f.id === c)?.test(r));
    const counts = {};
    for (const f of filters) counts[f.id] = chipCounts(state.rows, [f], others(f.id))[f.id];
    const cols = [];
    if (filters.length) {
      // A gap where the group changes: chips in one group are alternatives (BHIM or Paytm), groups combine.
      const opts = filters.map((f, i) => {
        const o = option(f.label, state.chips.includes(f.id), () => { onUserFilter(); state.chips = state.chips.includes(f.id) ? state.chips.filter((x) => x !== f.id) : [...state.chips, f.id]; render(); }, String(counts[f.id]));
        if (i > 0 && (f.group ?? f.id) !== (filters[i - 1].group ?? filters[i - 1].id)) o.classList.add('dt-opt--gap');
        return o;
      });
      cols.push(h('section', {}, h('h3', { text: 'Filters' }), ...opts));
    }
    if (groups.length) cols.push(h('section', {}, h('h3', { text: 'Group by' }), option('None', !state.group, () => { onUserFilter(); state.group = ''; render(); }), ...groups.map((g) => option(g.label, state.group === g.id, () => { onUserFilter(); state.group = g.id; render(); }))));
    if (favoritesKey) {
      const save = h('button', { class: 'dt-opt', attrs: { type: 'button' }, on: { click: () => {
        const name = nameBox.value.trim();
        if (!name) { nameBox.focus(); return; }
        state.favs = withFavorite(state.favs, { name, chips: state.chips, words: [...state.words, ...(state.text ? [state.text] : [])], group: state.group }, allowed);
        writeStore();
        nameBox.value = '';
        renderPop();
      } } }, h('span', { text: 'Save this view' }));
      const nameBox = h('input', { attrs: { type: 'text', placeholder: 'Name for this view', 'aria-label': 'Name for this view', maxlength: '60' } });
      nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
      cols.push(h('section', {}, h('h3', { text: 'Favorites' }),
        ...state.favs.map((f) => h('div', { class: 'dt-fav' },
          h('button', { class: 'dt-opt', attrs: { type: 'button' }, on: { click: () => { state.chips = [...f.chips]; state.words = [...f.words]; state.text = ''; input.value = ''; state.group = f.group; render(); } } }, h('span', { text: `★ ${f.name}` })),
          h('button', { class: 'dt-x', attrs: { type: 'button', 'aria-label': `Delete favorite ${f.name}` }, text: '×', on: { click: () => { state.favs = state.favs.filter((x) => x !== f); writeStore(); renderPop(); } } }))),
        nameBox, save));
    }
    pop.replaceChildren(...cols);
  }

  // ---- header, filter boxes
  function renderHead() {
    headRow.replaceChildren(
      ...(selectable ? [h('th', { class: 'dt-tick' }, tick(shown.length > 0 && shown.every((r) => state.sel.has(rowId(r))), 'Select all shown', (on) => { for (const r of shown) on ? state.sel.add(rowId(r)) : state.sel.delete(rowId(r)); renderBody(); renderHead(); renderBulk(); }))] : []),
      ...columns.map((c) => {
        const on = state.sort[0] === c.id;
        if (c.sortable === false) return h('th', { class: `${c.align === 'end' ? 'dt-end' : ''}${c.sticky ? ' dt-sticky' : ''}`.trim(), text: c.label });
        const th = h('th', { class: `${c.align === 'end' ? 'dt-end' : ''}${c.sticky ? ' dt-sticky' : ''}`.trim(), attrs: { 'aria-sort': on ? (state.sort[1] > 0 ? 'ascending' : 'descending') : 'none' } },
          h('button', { class: 'dt-sort', attrs: { type: 'button' }, on: { click: () => { state.sort = [c.id, on ? -state.sort[1] : 1]; render(); } } }, c.label, h('span', { class: 'dt-arrow', attrs: { 'aria-hidden': 'true' }, text: on ? (state.sort[1] > 0 ? '▲' : '▼') : '⇕' })));
        if (on) th.classList.add('dt-sorted');
        return th;
      }),
    );
  }
  const HINTS = { amount: ['e.g. >1000', 'In rupees: 2500, >1000, <=500, 1000..3000, !=295'], count: ['e.g. >=1', 'A number: 2, >1, <=3, 1..3'], date: ['e.g. 2026-10', 'Try: 2026-10, >2026-10-15, 2026-10-01..2026-10-31'], text: ['Search', 'Words match anywhere. = exact, != not, ^ starts with, ! does not contain.'] };
  let colTimer;
  function buildFilterRow() {
    filterRow.replaceChildren(
      ...(selectable ? [h('td')] : []),
      ...columns.map((c) => {
        if (c.filter === 'none' || c.type === 'none') return h('td', { class: c.sticky ? 'dt-sticky' : '' });
        const [placeholder, title] = HINTS[c.type ?? 'text'];
        const box = h('input', { class: 'dt-colfilter', attrs: { type: 'search', placeholder, title, 'aria-label': `Search the ${c.label} column`, autocomplete: 'off' } });
        box.addEventListener('input', () => {
          onUserFilter();
          state.cols[c.id] = box.value;
          clearTimeout(colTimer);
          colTimer = setTimeout(() => { compute(); renderBody(); renderHead(); renderBulk(); }, 150);
        });
        return h('td', {}, box);
      }),
    );
  }

  // ---- rows
  function renderBody() {
    // `cap`: a very long list is cut after that many rows (the foot says so); filters narrow it.
    const { items } = buildItems(shown.slice(0, cap), groupDef(), state.collapsed);
    const width = columns.length + (selectable ? 1 : 0);
    const trs = [];
    const cardNodes = [];
    for (const item of items) {
      if (item.kind === 'group') {
        const toggle = () => { state.collapsed.has(item.key) ? state.collapsed.delete(item.key) : state.collapsed.add(item.key); renderBody(); };
        const label = `${item.label}`;
        const n = `${item.count} ${item.count === 1 ? noun[0] : noun[1]}`;
        const btn = h('button', { class: 'dt-group-btn', attrs: { type: 'button', 'aria-expanded': String(item.open) } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: item.open ? '▾' : '▸' }), h('b', { text: label }), h('span', { class: 'dt-count', text: n }));
        btn.addEventListener('click', toggle);
        trs.push(h('tr', { class: 'dt-group' }, h('td', { attrs: { colspan: String(width) } }, btn)));
        cardNodes.push(h('div', { class: 'dt-group dt-group--card' }, btn.cloneNode(true)));
        cardNodes.at(-1).firstChild.addEventListener('click', toggle);
        continue;
      }
      const r = item.row;
      const id = rowId(r);
      const sel = state.sel.has(id);
      const tr = h('tr', { class: `dt-row ${rowClass(r)}${sel ? ' dt-selected' : ''}${onOpen ? ' dt-clickable' : ''}` });
      if (selectable) tr.append(h('td', { class: 'dt-tick' }, tick(sel, 'Select row', (on) => { on ? state.sel.add(id) : state.sel.delete(id); renderBody(); renderHead(); renderBulk(); })));
      for (const c of columns) {
        const out = c.render ? c.render(r) : c.value(r);
        const td = h('td', { class: `${c.align === 'end' ? 'dt-end' : ''}${c.wrap ? ' dt-wrap' : ''}${c.sticky ? ' dt-sticky' : ''}`.trim() });
        if (out instanceof Node) td.append(out);
        else td.textContent = out == null || out === '' ? '–' : String(out);
        tr.append(td);
      }
      if (onOpen) tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input,select,textarea,label')) onOpen(r); });
      trs.push(tr);
      const more = detail?.(r) ?? null;
      if (more) {
        tr.classList.add('dt-has-detail');
        trs.push(h('tr', { class: 'dt-detail' }, h('td', { attrs: { colspan: String(width) } }, more)));
      }
      if (card) {
        const c = card(r);
        const moreCard = detail?.(r) ?? null;
        if (moreCard) c.append(moreCard);
        c.classList.add('dt-card');
        if (sel) c.classList.add('dt-selected');
        if (selectable) c.prepend(tick(sel, 'Select row', (on) => { on ? state.sel.add(id) : state.sel.delete(id); renderBody(); renderHead(); renderBulk(); }));
        cardNodes.push(c);
      }
    }
    body.replaceChildren(...trs);
    cards.replaceChildren(...cardNodes);
    const none = shown.length === 0;
    emptyBox.hidden = !none;
    scroll.hidden = none;
    if (none) {
      const filtered = state.chips.length || state.words.length || state.text || Object.values(state.cols).some(Boolean);
      emptyBox.replaceChildren(
        h('p', { class: 'dt-empty-title', text: filtered ? `No ${noun[0]} matches` : empty.title ?? `No ${noun[1]} yet` }),
        h('p', { class: 'hint', text: filtered ? 'Take a filter off, or clear the search.' : empty.text ?? '' }),
        ...(filtered ? [h('button', { class: 'button button--outline', attrs: { type: 'button' }, text: 'Clear filters', on: { click: clearAll } })] : []),
      );
    }
    foot.textContent = state.rows.length
      ? `${shown.length > cap ? `Showing the first ${cap} of ${shown.length}. Narrow the filters to see the rest.` : `${shown.length} of ${state.rows.length} ${state.rows.length === 1 ? noun[0] : noun[1]}`}${state.sel.size ? ` · ${state.sel.size} selected` : ''}`
      : '';
  }

  function renderBulk() {
    const picked = selected();
    bulkBar.hidden = picked.length === 0 || bulk.length === 0;
    if (bulkBar.hidden) return;
    bulkBar.replaceChildren(
      h('b', { text: `${picked.length} selected` }),
      ...bulk.map((a) => h('button', { class: 'button button--outline', attrs: { type: 'button' }, text: a.label, on: { click: () => a.run(picked, api) } })),
      h('button', { class: 'button button--outline', attrs: { type: 'button' }, text: 'Clear', on: { click: () => api.clearSelection() } }),
    );
  }

  function clearAll() {
    onUserFilter();
    state.chips = [];
    state.words = [];
    state.text = '';
    state.cols = {};
    input.value = '';
    filterRow.querySelectorAll('input').forEach((i) => { i.value = ''; });
    render();
  }

  function render() {
    compute();
    renderChips();
    renderPop();
    renderHead();
    renderBody();
    renderBulk();
    onChange(shown);
  }
  const selected = () => state.rows.filter((r) => state.sel.has(rowId(r)));

  // ---- search box behaviour: words typed, Enter turns them into a chip, Backspace on an empty box takes the last chip off
  let textTimer;
  input.addEventListener('input', () => {
    onUserFilter();
    state.text = input.value.trim();
    clearTimeout(textTimer);
    textTimer = setTimeout(() => { compute(); renderBody(); renderHead(); renderBulk(); }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); state.words.push(input.value.trim()); input.value = ''; state.text = ''; render(); }
    else if (e.key === 'Backspace' && !input.value) { if (state.words.length) state.words.pop(); else if (state.group) state.group = ''; else state.chips.pop(); render(); }
    else if (e.key === 'Escape' && state.popOpen) { state.popOpen = false; renderPop(); }
  });
  caret.addEventListener('click', () => { state.popOpen = !state.popOpen; renderPop(); });
  document.addEventListener('click', (e) => { if (state.popOpen && !root.querySelector('.dt-search').contains(e.target)) { state.popOpen = false; renderPop(); } });

  buildFilterRow();
  const api = {
    setRows(rows) {
      state.rows = rows;
      const ids = new Set(rows.map(rowId));
      for (const id of [...state.sel]) if (!ids.has(id)) state.sel.delete(id);
      render();
    },
    render,
    selected,
    clearSelection() { state.sel.clear(); renderBody(); renderHead(); renderBulk(); },
    setChips(ids) { state.chips = ids.filter((i) => allowed.chipIds.includes(i)); render(); },
    setText(text) { input.value = text; state.text = text.trim(); render(); },
    setGroup(id) { state.group = allowed.groupIds.includes(id) ? id : ''; render(); },
    shown: () => shown,
    state,
  };
  return api;
}
