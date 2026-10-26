// The behaviour behind StepUpSheet.astro: the lock in the toolbar says whether changes are unlocked and for how long,
// and the sheet it opens takes an authenticator or recovery code, or a passkey, and keeps the step-up token for the
// tab (staff-client.mjs). A page gives it `getMe` (the server's `me`: { ready, hasPasskey }) and `onChange` (redraw
// whatever depends on whether changes are unlocked). Same flow as the Access page's own copy.
import { clearStepUp, closeOnBackdrop, minutesLabel, passkeyStepUp, passkeysSupported, saveStepUp, showToast, staffFetch, StaffAuthError, stepUpExpiry, wireCodeEntry } from './staff-client.mjs';

const LOCK_SHUT = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const LOCK_OPEN = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>';

export function initStepUpLock({ getMe, onChange }) {
  const $ = (id) => document.getElementById(id);
  const lockBtn = $('lock');
  const dialog = $('stepup');
  const text = $('stepup-text');
  const form = $('verify-form');
  const code = $('verify-code');
  const passkeyBtn = $('verify-passkey');
  const error = $('verify-error');
  const link = $('stepup-link');
  const lockNow = $('lock-now');
  const entry = wireCodeEntry({ form, input: code, toggle: $('verify-switch') });

  const canEdit = () => Boolean(getMe()?.ready) && stepUpExpiry() !== null;
  const showError = (message) => {
    error.hidden = false;
    error.textContent = message;
  };

  function setPill(kind, label) {
    lockBtn.hidden = false;
    lockBtn.dataset.state = kind;
    lockBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${kind === 'open' ? LOCK_OPEN : LOCK_SHUT}</svg>`;
    lockBtn.append(label); // a text node, so the label is never read as markup
    lockBtn.setAttribute('aria-label', kind === 'open' ? `${label}. Open for details or to lock again.` : kind === 'setup' ? 'Editing is locked until you set up two second factors. Open for details.' : 'Editing is locked. Open to unlock it.');
  }

  function render() {
    const me = getMe();
    if (!me) return;
    const exp = stepUpExpiry();
    error.hidden = true;
    lockNow.hidden = !(me.ready && exp);
    if (!me.ready) {
      setPill('setup', 'Set up to edit');
      text.textContent = 'You need two different second-factor methods set up before you can change anything. You can look around in the meantime.';
      form.hidden = true;
      link.hidden = false;
    } else if (exp) {
      setPill('open', `Editing unlocked · ${minutesLabel(exp - Date.now())}`);
      text.textContent = `Changes are unlocked for about ${minutesLabel(exp - Date.now())}.`;
      form.hidden = true;
      link.hidden = true;
    } else {
      setPill('locked', 'Unlock editing');
      text.textContent = 'Viewing only. Enter the code from your authenticator app to make changes.';
      form.hidden = false;
      passkeyBtn.hidden = !(me.hasPasskey && passkeysSupported());
      link.hidden = true;
    }
  }

  const open = () => {
    render();
    dialog.showModal();
    if (!form.hidden) code.focus();
  };
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const unlocked = () => {
    render();
    onChange();
    close();
    showToast('Editing unlocked.');
  };

  lockBtn.addEventListener('click', open);
  $('stepup-close').addEventListener('click', close);
  closeOnBackdrop(dialog, close); // a tap on the dimmed area outside the sheet
  lockNow.addEventListener('click', () => {
    clearStepUp();
    render();
    onChange();
    close();
    showToast('Editing locked.');
  });
  // The label counts minutes down; keep it honest while the sheet is closed.
  window.setInterval(() => {
    if (getMe() && !dialog.open) render();
  }, 20000);

  passkeyBtn.addEventListener('click', async () => {
    error.hidden = true;
    passkeyBtn.disabled = true;
    try {
      const result = await passkeyStepUp(staffFetch);
      if (result.cancelled) return;
      if (result.status === 200) {
        saveStepUp(result.data.stepUpToken, result.data.expiresInSeconds);
        unlocked();
      } else if (result.status === 429) {
        showError(`Too many wrong attempts. Try again in about ${minutesLabel((result.data.retryAfterSeconds ?? 900) * 1000)}.`);
      } else {
        showError(result.data?.error ?? 'That passkey did not work.');
      }
    } catch (err) {
      if (!(err instanceof StaffAuthError)) showError('Your device could not use the passkey. Try again, or enter a code.');
    } finally {
      passkeyBtn.disabled = false;
    }
  });

  // One request at a time: a slow response must not invite a second tap or a second auto-submit with the same code.
  let verifying = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (verifying) return;
    verifying = true;
    const submit = form.querySelector('button[type="submit"]');
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Checking…';
    error.hidden = true;
    try {
      const { status, data } = await staffFetch('/api/staff-mfa/verify', { method: 'POST', body: { method: entry.method(), code: code.value } });
      if (status === 200) {
        saveStepUp(data.stepUpToken, data.expiresInSeconds);
        code.value = '';
        unlocked();
      } else if (status === 429) {
        showError(`Too many wrong codes. Try again in about ${minutesLabel((data.retryAfterSeconds ?? 900) * 1000)}.`);
      } else {
        showError(data.error ?? 'That code did not work.');
      }
    } catch (err) {
      if (!(err instanceof StaffAuthError)) showError('Could not reach the server — try again.');
    } finally {
      verifying = false;
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  return { render, canEdit, open };
}
