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
