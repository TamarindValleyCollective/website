// Small browser helpers shared by the finance ledger pages (Ledger, Rules). Everything the server returns is placed with
// textContent, never as HTML. Money is integer paise; the screens show rupees and convert back with parseRupees, which
// never goes through a float.

import { linkedPicker } from './linked-picker.mjs';

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
/** Unit choices: "F-01 · H-10", with the people living there beside it and searchable, so a unit is found by a member's name. */
export const unitOptions = (households) => households.map((x) => ({ value: x.id, label: x.label, sub: (x.people ?? []).join(', '), search: (x.people ?? []).join(' ') }));
export function partyOptions(parties, { unitId = '', unitLabels = new Map() } = {}) {
  // For a unit's maintenance the people in that unit come first (anybody can pay, but they are the likely ones), marked with the unit.
  const inUnit = (p) => Boolean(unitId) && p.household_id === unitId && !p.former_since;
  const ordered = [...parties.filter(inUnit), ...parties.filter((p) => !inUnit(p) && !p.former_since), ...parties.filter((p) => !inUnit(p) && p.former_since)];
  return ordered.map((p) => ({
    value: p.id,
    label: p.former_since ? `${p.name} · former member` : p.name,
    kind: p.kind,
    sub: inUnit(p) ? 'in this unit' : p.kind === 'member' && p.household_id && !p.former_since ? unitLabels.get(p.household_id) ?? '' : '',
  }));
}

/**
 * A picker you can type into, for lists too long to scroll (parties, categories, units). A flat list is the simplest use of the linked picker
 * (scripts/lib/linked-picker.mjs, docs/linked-picker.md), which does the work; this keeps the shape the pages already use:
 * `.value` (an option's value, '' for none), a 'change' event, `.hidden`, `.focus()`, `.input`, `.setBlank(text)`, `.setPlaceholder(text)`, `.setOptions(list)`.
 * With `addNew`, the list always ends in "<addNewLabel>: “typed”", which calls addNew(typed).
 * @param {{ options?: { value: string, label: string, kind?: string, sub?: string, search?: string, group?: string }[], value?: string, blank?: string, addNew?: ((typed: string) => void) | null, addNewLabel?: string, matcher?: ((options: any[], query: string) => any[]) | null, ariaLabel?: string }} [config]
 */
export function combo({ options = [], value = '', blank = 'Choose…', addNew = null, addNewLabel = 'Add a new entry', matcher = null, ariaLabel = '' } = {}) {
  const el = linkedPicker({ nodes: options, path: value ? [value] : [], blank, matcher, ariaLabel, display: 'leaf', addNew: addNew ? { label: addNewLabel, depth: 0, onAdd: (typed) => addNew(typed) } : null });
  el.setOptions = el.setNodes;
  return el;
}
