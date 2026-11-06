// Small browser helpers shared by the finance ledger pages (Ledger, Rules). Everything the server returns is placed with
// textContent, never as HTML. Money is integer paise; the screens show rupees and convert back with parseRupees, which
// never goes through a float.

/** Build an element: h('div', { class, text, attrs, on }, ...children). */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(props.on ?? {})) el.addEventListener(k, v);
  el.append(...kids.filter((k) => k !== null && k !== undefined));
  return el;
}

export const pill = (text, kind) => h('span', { class: `pill${kind ? ` pill--${kind}` : ''}`, text });
export const button = (text, onClick, cls = 'button button--outline') => h('button', { class: cls, text, attrs: { type: 'button' }, on: { click: onClick } });
export const labelled = (label, input) => h('label', {}, h('span', { text: label }), input);
export const input = (name, attrs = {}) => h('input', { attrs: { name, autocomplete: 'off', ...attrs } });

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 12345 paise -> "₹123.45" */
export const rupees = (paise) => inr.format(paise / 100);
/** "1,234.5" -> 123450; anything else (more than two decimals, letters, empty, zero) -> null. */
export function parseRupees(text) {
  const t = String(text ?? '').replace(/[,\s₹]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return paise > 0 && Number.isSafeInteger(paise) ? paise : null;
}
/** "2026-10-31" -> "31 Oct 2026" */
export const niceDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
/** "2026-10-01" -> "October 2026" */
export const niceMonth = (iso) => new Date(`${String(iso).slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/** Categories as <optgroup>s by type, in the order a person thinks of them. */
const TYPE_LABELS = { opex: 'Running costs', capex: 'Capital purchases', revenue: 'Income', member_contribution: 'Member money', tax: 'Taxes', sinking_fund: 'Sinking fund', interest: 'Interest', reimbursement: 'Reimbursements', transfer: 'Transfers' };
export const typeLabel = (type) => TYPE_LABELS[type] ?? type;
export function categorySelect(categories, { selected = '', blank = 'Choose a category', includeInactive = false } = {}) {
  const sel = h('select', { attrs: { name: 'category' } }, h('option', { text: blank, attrs: { value: '' } }));
  for (const type of Object.keys(TYPE_LABELS)) {
    const group = categories.filter((c) => c.type === type && (c.active || includeInactive || c.id === selected));
    if (!group.length) continue;
    sel.append(h('optgroup', { attrs: { label: TYPE_LABELS[type] } }, ...group.map((c) => h('option', { text: c.active ? c.name : `${c.name} (retired)`, attrs: { value: c.id } }))));
  }
  sel.value = selected;
  return sel;
}
export function partySelect(parties, { selected = '', blank = 'No one in particular' } = {}) {
  const sel = h('select', { attrs: { name: 'party' } }, h('option', { text: blank, attrs: { value: '' } }), ...parties.map((p) => h('option', { text: p.name, attrs: { value: p.id } })));
  sel.value = selected;
  return sel;
}

/** Show a <dialog class="sheet"> with the given content. */
export function present(dlg, closeOnBackdrop, ...kids) {
  dlg.replaceChildren(...kids.filter(Boolean));
  if (!dlg.open) dlg.showModal();
  closeOnBackdrop(dlg);
}

/** Options for a combo from the categories, grouped by type like categorySelect. */
export function categoryOptions(categories, { includeInactive = false, selected = '' } = {}) {
  const out = [];
  for (const type of Object.keys(TYPE_LABELS)) {
    for (const c of categories.filter((x) => x.type === type && (x.active || includeInactive || x.id === selected))) out.push({ value: c.id, label: c.active ? c.name : `${c.name} (retired)`, group: TYPE_LABELS[type] });
  }
  return out;
}
/** Party choices: current ones first, former members after them and marked (`former_since` is set once a member's last household link is gone). */
export const partyOptions = (parties) => [...parties.filter((p) => !p.former_since), ...parties.filter((p) => p.former_since)].map((p) => ({ value: p.id, label: p.former_since ? `${p.name} · former member` : p.name, kind: p.kind }));

/**
 * A picker you can type into, for lists too long to scroll (parties, categories). It looks like a field; focusing it opens a list that narrows as you
 * type (every word must appear), arrow keys and Enter choose, Escape closes. The first entry clears the choice (`blank`). With `addNew` the list always
 * ends in "Add "<what you typed>"…", which calls addNew(typed).
 *
 * It stands in for a <select>: `.value` (an option's value, '' for none), a bubbling-free 'change' event when the person chooses, `.hidden`, `.focus()`.
 * `.input` is the text field (for aria-label and for telling which control has focus), `.setBlank(text)` changes what "none" says, `.setOptions(list)`
 * replaces the list. The list is placed beside the field, outside any scrolling table; inside a dialog it stays in the dialog so it is not hidden behind it.
 * Everything is placed with textContent.
 * With `kinds` ([{ key, label }]) the list has chips above it, one per kind of option (an option's `kind`); the ones switched on limit the list, none on means
 * everything, and a row at the bottom shows how many are hidden. `.setKinds(keys)` switches chips on from outside (the category picks the kind of party).
 * @param {{ kinds?: { key: string, label: string }[] | null, kindNoun?: string, options?: { value: string, label: string, kind?: string, group?: string }[], value?: string, blank?: string, addNew?: ((typed: string) => void) | null, addNewLabel?: string, matcher?: ((options: any[], query: string) => any[]) | null, ariaLabel?: string }} [config]
 */
export function combo({ options = [], value = '', blank = 'Choose…', addNew = null, addNewLabel = 'Add a new entry', matcher = null, ariaLabel = '', kinds = null, kindNoun = 'entries' } = {}) {
  let opts = options;
  let current = value;
  let blankText = blank;
  let active = -1;
  let shown = [];
  let pop = null;
  let activeKinds = new Set();
  const input = h('input', { class: 'combo-input', attrs: { type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) } });
  const caret = h('span', { class: 'combo-caret', text: '▾', attrs: { 'aria-hidden': 'true' } });
  const el = h('div', { class: 'combo' }, input, caret);
  const labelOf = (v) => (v ? opts.find((o) => o.value === v)?.label ?? '' : '');
  const paintText = () => {
    input.value = labelOf(current);
    input.placeholder = blankText;
  };
  const choose = (v) => {
    current = v;
    close();
    paintText();
    el.dispatchEvent(new Event('change'));
  };
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
    if (!pop) return;
    if (pop.classList.contains('combo-pop--inline')) return;
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.min(pop.offsetWidth, 360) - 8))}px`;
    pop.style.minWidth = `${Math.max(r.width, 240)}px`;
    const h2 = Math.min(pop.scrollHeight, 320);
    if (below < h2 + 12 && r.top > below) {
      pop.style.top = '';
      pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
      pop.style.maxHeight = `${Math.min(320, r.top - 12)}px`;
    } else {
      pop.style.bottom = '';
      pop.style.top = `${r.bottom + 4}px`;
      pop.style.maxHeight = `${Math.min(320, below - 12)}px`;
    }
  }
  function render() {
    const typed = input.value.trim();
    const q = pop?.dataset.typing === '1' ? typed : '';
    const inKinds = kinds && activeKinds.size ? opts.filter((o) => activeKinds.has(o.kind)) : opts;
    const hiddenCount = opts.length - inKinds.length;
    const found = (matcher ?? ((list, text) => list.filter((o) => text.toLowerCase().split(/\s+/).every((w) => o.label.toLowerCase().includes(w)))))(inKinds, q);
    shown = [{ value: '', label: blankText, blank: true }, ...found];
    if (hiddenCount > 0) shown.push({ showAll: true, label: `Show all ${kindNoun} (${hiddenCount} more)` });
    if (addNew) shown.push({ add: true, label: q ? `${addNewLabel}: “${q}”` : `${addNewLabel}…`, typed: q });
    if (active >= shown.length) active = shown.length - 1;
    pop.replaceChildren();
    if (kinds) {
      const bar = h('div', { class: 'combo-kinds' });
      for (const k of [...kinds, { key: '', label: `All ${kindNoun}` }]) {
        const on = k.key ? activeKinds.has(k.key) : activeKinds.size === 0;
        const chip = h('button', { class: 'combo-chip', text: k.label, attrs: { type: 'button', 'aria-pressed': String(on) } });
        chip.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (!k.key) activeKinds = new Set();
          else if (activeKinds.has(k.key)) activeKinds.delete(k.key);
          else activeKinds.add(k.key);
          active = 1;
          render();
          place();
        });
        bar.append(chip);
      }
      pop.append(bar);
    }
    let lastGroup = '';
    shown.forEach((o, i) => {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group;
        pop.append(h('div', { class: 'combo-group', text: o.group }));
      }
      const row = h('div', { class: `combo-opt${i === active ? ' is-active' : ''}${o.add ? ' combo-opt--add' : ''}${o.blank ? ' combo-opt--blank' : ''}${!o.add && o.value === current ? ' is-current' : ''}`, text: o.label, attrs: { role: 'option', 'aria-selected': String(i === active), 'data-i': String(i) } });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(o);
      });
      pop.append(row);
    });
    if (!found.length && q) pop.insertBefore(h('div', { class: 'combo-none', text: `Nothing called “${q}”${activeKinds.size ? ' in these' : ''}.` }), pop.querySelector('.combo-opt--blank')?.nextSibling ?? null);
    // Scroll the list itself, never the page (scrollIntoView would also scroll the page when the list is not placed yet).
    const row = pop.querySelector('.is-active');
    if (row) {
      if (row.offsetTop < pop.scrollTop) pop.scrollTop = row.offsetTop - 4;
      else if (row.offsetTop + row.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = row.offsetTop + row.offsetHeight - pop.clientHeight + 4;
    }
  }
  function pick(o) {
    if (o.showAll) {
      activeKinds = new Set();
      active = 1;
      render();
      place();
      return;
    }
    if (o.add) {
      const typed = o.typed ?? '';
      close();
      addNew(typed);
    } else choose(o.value);
  }
  function open() {
    if (pop) return;
    pop = h('div', { class: 'combo-pop', attrs: { role: 'listbox' } });
    pop.style.top = '0px';
    pop.style.left = '0px';
    pop.style.visibility = 'hidden';
    const dlg = el.closest('dialog');
    if (dlg) {
      pop.classList.add('combo-pop--inline');
      el.append(pop);
    } else document.body.append(pop);
    input.setAttribute('aria-expanded', 'true');
    active = Math.max(0, shown.findIndex((o) => !o.add && o.value === current));
    input.select();
    render();
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
    pop.dataset.typing = '1';
    active = 1;
    render();
    place();
  });
  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // the page's own shortcuts (Alt+arrows, Ctrl+Enter)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pop) open();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === 'Enter' && pop) {
      e.preventDefault();
      e.stopPropagation();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === 'Escape' && pop) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close();
  });
  input.addEventListener('blur', () => setTimeout(() => !el.contains(document.activeElement) && close(), 120));
  Object.defineProperties(el, {
    value: { get: () => current, set: (v) => { current = v ?? ''; if (!pop) paintText(); } },
    input: { value: input },
  });
  el.setBlank = (text) => {
    blankText = text;
    if (!pop) paintText();
  };
  el.setOptions = (list) => {
    opts = list;
    if (pop) render();
    else paintText();
  };
  el.setKinds = (keys) => {
    activeKinds = new Set(keys ?? []);
    if (pop) render();
  };
  el.focus = () => input.focus();
  paintText();
  return el;
}
