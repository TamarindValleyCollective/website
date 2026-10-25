// A button that is waiting on the server says so: it shows a spinner (styles/global.css, [aria-busy="true"]),
// changes its label to what is happening, and after a few seconds tells the person it is still going, so a slow
// save never looks like a button that did nothing. Used by every page that posts and waits.

const STILL_WORKING_AFTER_MS = 4000;

/**
 * Put a button into its waiting state. Returns a function that puts it back; call it when the work ends
 * (it is safe to call twice, and when the button is gone from the page).
 * @param {HTMLButtonElement} button
 * @param {string} [label] what is happening, e.g. 'Saving…'. Without one the button keeps its own label.
 * @returns {() => void}
 */
export function setBusy(button, label) {
  const original = Array.from(button.childNodes);
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) button.replaceChildren(label);
  const timer = setTimeout(() => {
    if (label) button.replaceChildren('Still working…');
  }, STILL_WORKING_AFTER_MS);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    button.removeAttribute('aria-busy');
    button.disabled = wasDisabled;
    if (label) button.replaceChildren(...original);
  };
}

/**
 * Run `work` while the button shows its waiting state, then restore it whether the work succeeded or threw.
 * @template T
 * @param {HTMLButtonElement} button
 * @param {string | undefined} label
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withBusy(button, label, work) {
  const done = setBusy(button, label);
  try {
    return await work();
  } finally {
    done();
  }
}

// For a handler that does not hold its button (a click handler written inline on a list of buttons): the button
// pressed a moment ago is the one to show as working. Call it synchronously at the start of the work.
let lastPress = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'click',
    (e) => {
      const button = e.target instanceof Element ? e.target.closest('button') : null;
      lastPress = button ? { button, at: Date.now() } : null;
    },
    true,
  );
}

/**
 * @param {string} [label]
 * @returns {() => void} puts the button back; does nothing when no button was just pressed
 */
export function busyForPress(label) {
  const press = lastPress;
  lastPress = null;
  if (!press || Date.now() - press.at > 5000 || !press.button.isConnected || press.button.disabled) return () => {};
  return setBusy(press.button, label);
}
