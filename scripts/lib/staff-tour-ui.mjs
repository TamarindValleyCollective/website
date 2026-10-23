// Draws the admin portal's tour (steps and rules: scripts/lib/staff-tour.mjs): a dimmed page, a ring
// round the element a step is about, a card beside it, and the "What's new" card for someone who has
// seen the tour before. The same behaviour as the member portal's tour (src/pages/members/index.astro),
// without its routes: every step here points at the shell or the Home page, which are both on screen.
//
// Styles are global, in StaffLayout.astro (.tour*, .whatsnew*): this builds its DOM at run time, and
// Astro's scoped CSS never reaches elements made that way.
import { fullTourFor, tourLatest, tourStepsFor } from './staff-tour.mjs';

function el(tag, className, text, ...kids) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.append(...kids);
  return node;
}

function button(className, text, onClick) {
  const b = el('button', className, text);
  b.setAttribute('type', 'button');
  b.addEventListener('click', onClick);
  return b;
}

// ---- what this browser has seen, per account and page. Undefined = storage blocked, which shows no tour.
const seenKey = (email, page) => `tvc-staff-tour:${email}:${page}`;

export function readSeenThrough(email, page) {
  try {
    const raw = localStorage.getItem(seenKey(email, page));
    return raw === null ? null : Number(raw);
  } catch {
    return undefined;
  }
}

export function markSeen(email, page) {
  try {
    localStorage.setItem(seenKey(email, page), String(tourLatest(page)));
  } catch {
    // the tour simply comes back next visit
  }
}

// What to do when a page opens, once we know who is signed in:
//   `?tour` in the address  the whole tour for this page, recording nothing;
//   never seen this page    the whole tour, started for them;
//   seen it, steps since    on Home the "What's new" card (if the page has a #whats-new slot), elsewhere
//                           just those steps as a short tour.
// Closing, skipping or finishing counts as seen. Returns nothing; safe to call on every sign-in.
let offered = false;
export function offerTour({ page, isSuperAdmin, email }) {
  if (offered) return;
  offered = true;
  if (new URLSearchParams(location.search).has('tour')) return startTour(fullTourFor(page, isSuperAdmin));
  const seen = readSeenThrough(email, page);
  const pending = tourStepsFor({ page, isSuperAdmin, seenThrough: seen });
  if (!pending.length) return;
  const slot = document.getElementById('whats-new');
  const finished = () => {
    markSeen(email, page);
    slot?.replaceChildren();
  };
  if (seen !== null && slot) slot.replaceChildren(whatsNewCard(pending, { onShow: () => startTour(pending, { onFinish: finished }), onDismiss: finished }));
  else startTour(pending, { onFinish: finished });
}

// ---- the "What's new" card, for someone who has seen the tour before
export function whatsNewCard(steps, { onShow, onDismiss }) {
  const heading = steps.length > 1 ? `What's new · ${steps.length} things` : "What's new";
  const close = button('whatsnew-close', '×', onDismiss);
  close.setAttribute('aria-label', "Dismiss what's new");
  const card = el(
    'section',
    'whatsnew',
    undefined,
    el(
      'div',
      'whatsnew-head',
      undefined,
      el('div', '', undefined, el('p', 'whatsnew-eyebrow', heading), el('h2', '', 'Since you last visited')),
      close,
    ),
    el('ul', 'whatsnew-list', undefined, ...steps.map((s) => el('li', '', undefined, el('span', 'whatsnew-tag', s.tag), el('span', '', undefined, el('strong', '', s.title), ' ', s.text)))),
    el('div', 'whatsnew-actions', undefined, button('button', `Show me${steps.length > 1 ? ` (${steps.length} steps)` : ''}`, onShow), button('button button--outline', 'Got it', onDismiss)),
  );
  card.setAttribute('aria-label', "What's new in the admin portal");
  return card;
}

// ---- the tour. onFinish runs when it is closed, skipped or completed.
export function startTour(steps, { onFinish } = {}) {
  if (!steps.length) return;
  document.querySelector('.tour')?.remove();
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = el('div', 'tour');
  const spot = el('div', 'tour-spot');
  spot.hidden = true;
  const card = el('div', 'tour-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');
  layer.append(el('div', 'tour-block'), spot, card);
  document.body.append(layer);

  const phone = window.matchMedia('(max-width: 560px)');
  const onScreen = (node) => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
  };
  let target = null;
  let run = 0;

  function place() {
    layer.classList.toggle('tour--spot', !!target);
    spot.hidden = !target;
    card.classList.toggle('tour-card--centre', !target);
    card.style.cssText = '';
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    if (phone.matches) return; // a sheet along the bottom, set in CSS
    const w = card.offsetWidth;
    const ht = card.offsetHeight;
    const room = 16;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let left = r.right + room;
    let top = clamp(r.top, 12, window.innerHeight - ht - 12);
    if (left + w > window.innerWidth - 12) left = r.left - room - w; // no room to the right: to the left
    if (left < 12) {
      left = clamp(r.left, 12, window.innerWidth - w - 12); // neither: below, else above
      top = r.bottom + room + ht < window.innerHeight ? r.bottom + room : Math.max(12, r.top - room - ht);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function finish() {
    run++;
    layer.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    onFinish?.();
    if (returnTo?.isConnected) returnTo.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    } else if (e.key === 'Tab') {
      const stops = [...card.querySelectorAll('button')].filter((b) => !b.hidden);
      if (!stops.length) return;
      const i = stops.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : i === stops.length - 1 ? 0 : i + 1;
      e.preventDefault();
      stops[next].focus();
    }
  }

  async function show(n) {
    const mine = ++run;
    const step = steps[n];
    // A tool fills in a while after sign-in (its data loads first), so an element inside the page gets about
    // three seconds to show up; the shell is already there, so anything else gets a moment. Then a centred card.
    target = null;
    const inPage = !!document.querySelector(`[data-tour="${step.target}"]`)?.closest('#staff-main');
    for (let tries = 0; tries < (inPage ? 60 : 4); tries++) {
      await new Promise((r) => setTimeout(r, tries ? 50 : 30));
      if (mine !== run) return;
      const found = document.querySelector(`[data-tour="${step.target}"]`);
      if (found && onScreen(found)) {
        target = found;
        break;
      }
    }
    target?.scrollIntoView({ block: 'center' });

    const last = n === steps.length - 1;
    const back = button('button button--outline', 'Back', () => show(n - 1));
    back.hidden = n === 0;
    const skip = button('tour-skip', 'Skip tour', finish);
    skip.hidden = last;
    const next = button('button', last ? 'Done' : 'Next', () => (last ? finish() : show(n + 1)));
    const title = el('h2', '', step.title);
    title.id = 'tour-title';
    card.replaceChildren(
      el('p', 'tour-count', `Step ${n + 1} of ${steps.length}`),
      title,
      el('p', 'tour-text', step.text),
      el('div', 'tour-foot', undefined, el('div', 'tour-dots', undefined, ...steps.map((_, i) => el('span', i === n ? 'on' : ''))), el('div', 'tour-buttons', undefined, skip, back, next)),
    );
    place();
    next.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  show(0);
}
