// The member portal's last /api/members-me/home answer, kept in this browser so the portal can draw at once the next
// time the same member signs in, while the real answer is fetched in the background (src/pages/members/index.astro).
// Sign-in costs a few seconds of skeleton cards otherwise; for a returning member that wait is mostly avoidable.
//
// Nothing here is a security boundary. The server still verifies the Google token and the invitation on every
// request, and the refresh that follows replaces or discards whatever was drawn from here (a 401/403 clears it).
// The email in the token is read WITHOUT verifying it, only to choose whose cache to show: it can't reveal anything
// the browser's own storage doesn't already hold. What is stored is what the portal itself shows that member (their own
// email and mobile in full, others in their unit masked), so it is kept per email, for a day, and removed on sign-out
// and whenever the server refuses them. The privacy-notice answer (no household data) is never stored.
export const HOME_CACHE_KEY = 'tvc-member-home';
export const HOME_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VERSION = 1;

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // blocked storage: the portal just waits for the network as before
  }
}

function payloadOf(token) {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// The email inside a Google ID token, lower-cased; null when it isn't a readable token. Not verified (see above).
export function emailFromToken(token) {
  const email = payloadOf(token)?.email;
  return typeof email === 'string' && email ? email.toLowerCase() : null;
}

// A token whose own expiry has passed will be refused, so nothing is drawn from the cache for it (the member would see
// their portal for a moment and then be sent to sign in). Unverified, like the email: it only decides what to show first.
function expired(token, now) {
  const exp = payloadOf(token)?.exp;
  return typeof exp === 'number' && exp * 1000 <= now;
}

// Only a real, complete answer is worth drawing from: signed-in data, not the privacy notice stub.
export function cacheable(data) {
  return Boolean(data && !data.privacyNoticeRequired && data.me && typeof data.me.personId === 'string' && Array.isArray(data.households));
}

export function readHomeCache(token, { now = Date.now(), storage = defaultStorage() } = {}) {
  const email = emailFromToken(token);
  if (!email || !storage || expired(token, now)) return null;
  try {
    const saved = JSON.parse(storage.getItem(HOME_CACHE_KEY) ?? 'null');
    if (!saved || saved.v !== VERSION || saved.email !== email) return null;
    if (typeof saved.at !== 'number' || now - saved.at > HOME_CACHE_MAX_AGE_MS || now < saved.at) return null;
    return cacheable(saved.data) ? saved.data : null;
  } catch {
    return null;
  }
}

export function writeHomeCache(token, data, { now = Date.now(), storage = defaultStorage() } = {}) {
  const email = emailFromToken(token);
  if (!email || !storage || !cacheable(data)) return;
  try {
    storage.setItem(HOME_CACHE_KEY, JSON.stringify({ v: VERSION, email, at: now, data }));
  } catch {
    // storage full or blocked: the next sign-in just waits for the network
  }
}

export function clearHomeCache({ storage = defaultStorage() } = {}) {
  try {
    storage?.removeItem(HOME_CACHE_KEY);
  } catch {
    // nothing to clear
  }
}
