// Browser-side helpers shared by every internal staff page: /internal
// (landing), /internal/access, /internal/security, and the four tools (photo
// pool, WhatsApp, event payments, accommodation calendar), which import
// TOKEN_KEY from here. One Google sign-in is kept in sessionStorage under a
// shared key, so signing in on any of these pages carries to all the others for
// as long as the tab is open, and one step-up proof (used by Access and
// Security) is kept under another.
//
// Nothing here is a security boundary: the server re-checks the Google token
// and the step-up token on every request. This only stores them for the tab
// and attaches them.
export const TOKEN_KEY = 'tvc-staff-idtoken';
export const STEPUP_KEY = 'tvc-staff-stepup';

// A response code that means "signed in, but something more is needed" — as
// opposed to a plain 403, which means "this account isn't allowed here".
const NEEDS_MORE = new Set(['STEP_UP_REQUIRED', 'MFA_NOT_READY', 'MFA_NOT_CONFIGURED']);

export class StaffAuthError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // 'unauthorized' (session ended) | 'forbidden' (not allowed here)
  }
}

function storage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // blocked storage: pages then just ask to sign in again
  }
}

export const getToken = () => storage()?.getItem(TOKEN_KEY) ?? null;
export const setToken = (token) => storage()?.setItem(TOKEN_KEY, token);
export const clearToken = () => storage()?.removeItem(TOKEN_KEY);

export function saveStepUp(token, expiresInSeconds) {
  storage()?.setItem(STEPUP_KEY, JSON.stringify({ token, exp: Date.now() + expiresInSeconds * 1000 }));
}

function readStepUp() {
  try {
    const saved = JSON.parse(storage()?.getItem(STEPUP_KEY) ?? 'null');
    if (saved && typeof saved.token === 'string' && saved.exp > Date.now()) return saved;
  } catch {
    // fall through: treated as no step-up
  }
  storage()?.removeItem(STEPUP_KEY);
  return null;
}

export const getStepUp = () => readStepUp()?.token ?? null;
// Milliseconds since the epoch at which the step-up lapses, or null if none.
export const stepUpExpiry = () => readStepUp()?.exp ?? null;
export const clearStepUp = () => storage()?.removeItem(STEPUP_KEY);

// Only for telling the person which account they are signed in as. Decoded
// without verification — the server does the real checking.
export function decodeTokenEmail(token) {
  const payloadB64 = token.split('.')[1] ?? '';
  const base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), '=');
  try {
    return JSON.parse(atob(base64)).email ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// fetch with the sign-in (and step-up, if there is one) attached. Resolves to
// { status, data } for everything the page can act on, including a
// "step-up needed" 403 or a wrong-code 400. Throws StaffAuthError only when
// the whole session needs replacing: a 401 clears the stored token, a plain
// 403 leaves it (re-signing in would likely pick the same account).
/** @param {string} path @param {{ method?: string, body?: unknown }} [options] */
export async function staffFetch(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const stepUp = getStepUp();
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token ?? ''}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(stepUp ? { 'x-stepup-token': stepUp } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearToken();
    throw new StaffAuthError('unauthorized');
  }
  if (res.status === 403 && !NEEDS_MORE.has(data.code)) throw new StaffAuthError('forbidden');
  return { status: res.status, data };
}

// "5 minutes" / "1 minute", for the step-up countdown and lockout messages.
export function minutesLabel(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// One-time-code entry shared by every "prove it's you" form. Built so password
// managers and phones can fill it: a single numeric field marked as a
// one-time-code (no "method" dropdown in front of it), submitted automatically
// once six digits are in, so a filled-in code needs no extra tap. A recovery
// code is the rarer path and switches the same field to plain text.
// `toggle` is optional (the setup confirm form has no recovery option).
/** @param {{ form: HTMLFormElement, input: HTMLInputElement, toggle?: HTMLElement }} parts */
export function wireCodeEntry({ form, input, toggle }) {
  let recovery = false;
  const apply = () => {
    input.setAttribute('inputmode', recovery ? 'text' : 'numeric');
    input.setAttribute('autocomplete', recovery ? 'off' : 'one-time-code');
    input.setAttribute('maxlength', recovery ? '40' : '7'); // "123 456" with the space some apps show
    input.setAttribute('placeholder', recovery ? 'Recovery code' : '6-digit code');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    if (toggle) toggle.textContent = recovery ? 'Use the authenticator code instead' : 'Use a recovery code';
  };
  apply();
  input.addEventListener('input', () => {
    if (!recovery && /^\d{6}$/.test(input.value.replace(/\s/g, ''))) form.requestSubmit();
  });
  toggle?.addEventListener('click', () => {
    recovery = !recovery;
    input.value = '';
    apply();
    input.focus();
  });
  return {
    method: () => (recovery ? 'recovery' : 'totp'),
    setRecovery(value) {
      if (recovery === value) return;
      recovery = value;
      input.value = '';
      apply();
    },
  };
}

// ---------------------------------------------------------------- passkeys
// Thin glue between the server's WebAuthn JSON (lib/staff-webauthn.ts) and the
// browser's navigator.credentials, which wants binary buffers. `api` is the
// page's own fetch helper: (path, { method, body }) -> { status, data }.
const b64urlToBuffer = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const bufferToB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const passkeysSupported = () => typeof window !== 'undefined' && Boolean(window.PublicKeyCredential) && Boolean(navigator.credentials);

// The person closed the prompt or the device said no: not an error worth shouting about.
const isCancelled = (err) => err && (err.name === 'NotAllowedError' || err.name === 'AbortError');

// Asks the device to make a passkey, returns { status, data } from the server
// (201 on success, possibly with recovery codes), or { cancelled: true }.
export async function registerPasskey(api, name) {
  const first = await api('/api/staff-mfa/passkey/register-options', { method: 'POST', body: {} });
  if (first.status !== 200) return first;
  const o = first.data.options;
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: b64urlToBuffer(o.challenge),
        user: { ...o.user, id: b64urlToBuffer(o.user.id) },
        excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })),
      },
    });
  } catch (err) {
    if (isCancelled(err)) return { cancelled: true };
    throw err;
  }
  if (!cred) return { cancelled: true };
  return api('/api/staff-mfa/passkey/register-verify', {
    method: 'POST',
    body: {
      name,
      response: {
        id: cred.id,
        rawId: bufferToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
          attestationObject: bufferToB64url(cred.response.attestationObject),
          transports: cred.response.getTransports?.() ?? [],
        },
        clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      },
    },
  });
}

// Proves a second factor with a passkey. Returns the server's { status, data }
// (200 carries the step-up token, like the code route), or { cancelled: true }.
export async function passkeyStepUp(api) {
  const first = await api('/api/staff-mfa/passkey/auth-options', { method: 'POST', body: {} });
  if (first.status !== 200) return first;
  const o = first.data.options;
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { ...o, challenge: b64urlToBuffer(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })) },
    });
  } catch (err) {
    if (isCancelled(err)) return { cancelled: true };
    throw err;
  }
  if (!cred) return { cancelled: true };
  return api('/api/staff-mfa/passkey/auth-verify', {
    method: 'POST',
    body: {
      response: {
        id: cred.id,
        rawId: bufferToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
          authenticatorData: bufferToB64url(cred.response.authenticatorData),
          signature: bufferToB64url(cred.response.signature),
          userHandle: cred.response.userHandle ? bufferToB64url(cred.response.userHandle) : undefined,
        },
        clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      },
    },
  });
}
