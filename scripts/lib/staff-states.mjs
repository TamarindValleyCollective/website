// Loading, failure and empty states for the admin pages. Each says what happened and what to do next, instead of a bare
// line of grey text: a failed load gets a "Try again" button, an empty list gets its next step. The container is a polite
// live region (aria-live on the element), and a failure is inserted as role="alert", so a screen reader announces both.
// Everything is placed with textContent, never as HTML. Used by the Finance pages; any admin page can use it.

const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** @param {string} role @param {string} title @param {string} text @param {{ label: string, onClick: () => void }} [action] */
function panel(role, title, text, action) {
  const card = make('div', 'card');
  card.setAttribute('role', role);
  card.append(make('h2', '', title), make('p', 'hint', text));
  if (action) {
    const button = make('button', 'button button--primary', action.label);
    button.type = 'button';
    button.addEventListener('click', action.onClick);
    const row = make('div');
    row.append(button);
    card.append(row);
  }
  return card;
}

// A quiet "Loading…" line.
export function showLoading(el, text = 'Loading…') {
  el.hidden = false;
  el.className = 'hint';
  el.replaceChildren(document.createTextNode(text));
}

// Nothing to say any more: empty and hide the container.
export function clearState(el) {
  el.hidden = true;
  el.className = '';
  el.replaceChildren();
}

// Something failed to load: say so plainly, say nothing was changed, and offer to try again.
/** @param {HTMLElement} el @param {{ title: string, text: string, onRetry?: () => void }} opts */
export function showFailure(el, { title, text, onRetry }) {
  el.hidden = false;
  el.className = '';
  el.replaceChildren(panel('alert', title, text, onRetry ? { label: 'Try again', onClick: onRetry } : undefined));
}

// A list with nothing in it: say why and what to do. `action` is { label, onClick } (optional).
/** @param {HTMLElement} el @param {{ title: string, text: string, action?: { label: string, onClick: () => void } }} opts */
export function showEmpty(el, { title, text, action }) {
  el.hidden = false;
  el.className = '';
  el.replaceChildren(panel('status', title, text, action));
}
