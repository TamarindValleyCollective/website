// Browser-side session for the member portal (src/pages/members/index.astro).
// Kept apart from staff-client.mjs on purpose: a member's Google sign-in is
// stored under its own key, so signing in or out of the portal never touches a
// staff session on the same browser, and the member pages never send a staff
// step-up token.
//
// Nothing here is a security boundary: the server (lib/member-access.ts)
// re-verifies the Google token and the invitation on every request. This only
// stores the token for the tab and attaches it.
export const MEMBER_TOKEN_KEY = 'tvc-member-idtoken';

function storage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // blocked storage: the page then just asks to sign in again
  }
}

export const getMemberToken = () => storage()?.getItem(MEMBER_TOKEN_KEY) ?? null;
export const setMemberToken = (token) => storage()?.setItem(MEMBER_TOKEN_KEY, token);
export const clearMemberToken = () => storage()?.removeItem(MEMBER_TOKEN_KEY);

// 'unauthorized' = no session or it expired (ask them to sign in again).
// A 403 (not invited) is returned as a normal result so the page can show the
// server's message.
export class MemberAuthError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function memberFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${getMemberToken() ?? ''}`,
      // FormData (a file upload) sets its own multipart content-type, with the boundary.
      ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearMemberToken();
    throw new MemberAuthError('unauthorized');
  }
  return { status: res.status, data };
}

// A story photo as something an <img> can show. A path on the public site is used as it is; an
// uploaded photo is fetched with the member's sign-in (the portal serves nothing without it) and
// shown from a blob URL, so it never needs a public address. Remembered per tab; a failure is not.
const photoCache = new Map();
/** @param {string} ref @param {'square' | 'full'} [size] @returns {Promise<string>} */
export function memberPhotoSrc(ref, size = 'square') {
  if (typeof ref !== 'string' || !ref) return Promise.reject(new Error('no photo'));
  if (ref.startsWith('/images/')) return Promise.resolve(ref);
  const key = `${ref}|${size}`;
  if (!photoCache.has(key)) {
    const loading = fetch(`/api/members-me/photo?id=${encodeURIComponent(ref)}&size=${size}`, {
      headers: { authorization: `Bearer ${getMemberToken() ?? ''}` },
    }).then(async (res) => {
      if (res.status === 401) {
        clearMemberToken();
        throw new MemberAuthError('unauthorized');
      }
      if (!res.ok) throw new Error('photo unavailable');
      return URL.createObjectURL(await res.blob());
    });
    photoCache.set(key, loading);
    loading.catch(() => photoCache.delete(key));
  }
  return photoCache.get(key);
}
