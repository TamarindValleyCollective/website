// The floating cell and header menu shared by the admin tables (data-table-ui.mjs) and the Ledger (finance/ledger.astro): one list of text
// items opened at the pointer (a right-click or a long press on a cell) or under a header's ▾ button. Styles: styles/admin-controls.css.
// Built with the DOM, never as HTML.
//
//   const menus = createFloatingMenu();
//   menus.open([{ label: 'Sort ascending', run }], x, y, fromButton);   // fromButton: the ▾ that opened it, given back focus on Escape
//   body.addEventListener('contextmenu', (e) => { ...; e.preventDefault(); menus.open(items, e.clientX, e.clientY); });
//   onLongPress(body, { accept: () => !onAPhone });                      // a touch screen has no right-click: a held finger sends one
import { h, rupees } from './finance-ui.mjs';
import { cellFilterText } from './data-table.mjs';

/** @typedef {{ label: string, run: () => void }} MenuItem */

/**
 * @returns {{ open: (items: Array<MenuItem | null | false | undefined>, x: number, y: number, fromEl?: Element | null) => void, close: (refocus?: boolean) => void, isOpen: () => boolean, from: () => Element | null, element: HTMLElement }}
 */
export function createFloatingMenu() {
  const menu = h('div', { class: 'admin-menu', attrs: { role: 'menu', hidden: '' } });
  // On the body, not inside the table: a fixed menu inside a transformed or clipped ancestor would be placed and cut off relative to that.
  document.body.append(menu);
  /** @type {Element | null} */
  let from = null;

  /** @param {boolean} [refocus] */
  function close(refocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (from?.getAttribute?.('aria-haspopup')) from.setAttribute('aria-expanded', 'false');
    if (refocus && from?.isConnected) from.focus();
    from = null;
  }

  /**
   * @param {Array<MenuItem | null | false | undefined>} items
   * @param {number} x
   * @param {number} y
   * @param {Element | null} [fromEl]
   */
  function open(items, x, y, fromEl = null) {
    close();
    const list = items.filter(Boolean);
    if (!list.length) return;
    from = fromEl;
    if (from?.getAttribute?.('aria-haspopup')) from.setAttribute('aria-expanded', 'true');
    menu.replaceChildren(...list.map((it) => h('button', { class: 'admin-menuitem', attrs: { type: 'button', role: 'menuitem', tabindex: '-1' }, text: it.label, on: { click: () => {
      // A menu opened from a cell (not from a ▾ button) hands focus back to that cell before the item runs, so the table that redraws keeps its cursor there.
      const back = from && !from.getAttribute('aria-haspopup') && from.isConnected ? from : null;
      close();
      back?.focus({ preventScroll: true });
      it.run();
    } } })));
    menu.hidden = false;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.firstChild.focus({ preventScroll: true });
  }

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.admin-menuitem')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === 'Home') items[0].focus();
    else if (e.key === 'End') items.at(-1).focus();
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') close();
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  });
  // Captured, so the menu is closed before whatever was clicked (or right-clicked) acts; a click on the ▾ that opened it is that button's own business.
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    if (!menu.hidden && !path.includes(menu) && !(from && path.includes(from))) close();
  }, true);
  document.addEventListener('contextmenu', (e) => { if (!menu.hidden && !e.composedPath().includes(menu)) close(); }, true);
  window.addEventListener('scroll', () => close(), true);
  window.addEventListener('resize', () => close());

  return { open, close, isOpen: () => !menu.hidden, from: () => from, element: menu };
}

/**
 * iOS never sends a right-click, so a finger held still on `el` for `ms` sends the same `contextmenu` event. Touch only; any movement or
 * lifting the finger cancels it. `accept()` can say no (the Ledger's phone cards have no cell menu).
 *
 * @param {Element} el
 * @param {{ ms?: number, accept?: () => boolean }} [options]
 */
export function onLongPress(el, { ms = 550, accept = () => true } = {}) {
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !accept()) return;
    const { clientX, clientY, target } = e;
    cancel();
    timer = setTimeout(() => { timer = null; target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })); }, ms);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointermove']) el.addEventListener(t, cancel);
}

/**
 * "Filter to this value" and "filter out this value" for a cell, as menu items. `type` is the column's ('text', 'amount', 'count', 'date'), `raw`
 * what the cell holds (paise for an amount), and `apply(text)` receives the condition to put in that column's filter box (cellFilterText).
 * A cell the filter language cannot describe (an empty amount or date; "not this date") simply has no item for it.
 *
 * @param {{ type?: string, raw: unknown, apply: (text: string) => void }} options
 * @returns {MenuItem[]}
 */
export function valueFilterItems({ type = 'text', raw, apply }) {
  const text = type === 'amount' && raw != null && raw !== '' ? rupees(raw) : String(raw ?? '').trim();
  const quoted = text ? `“${text.length > 28 ? `${text.slice(0, 27)}…` : text}”` : 'empty';
  const to = cellFilterText(type, raw);
  const out = cellFilterText(type, raw, true);
  return [to ? { label: `Filter to ${quoted}`, run: () => apply(to) } : null, out ? { label: `Filter out ${quoted}`, run: () => apply(out) } : null].filter(Boolean);
}

/**
 * True over something the browser's own menu is for: a link, a button, a field, or text the person has selected. `ignore` is a selector for
 * buttons that are really the cell's text (the Ledger's date and category buttons), which do not count. A long press is our own event, so a
 * word the finger has just selected does not count either.
 *
 * @param {MouseEvent | KeyboardEvent} e
 * @param {string} [ignore]
 * @returns {boolean}
 */
export function leaveToBrowser(e, ignore = '') {
  const hit = e.target.closest('a, button, input, select, textarea, label');
  if (hit && !(ignore && hit.matches(ignore))) return true;
  return e.isTrusted && String(window.getSelection()).trim() !== '';
}
