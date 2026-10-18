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
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearMemberToken();
    throw new MemberAuthError('unauthorized');
  }
  return { status: res.status, data };
}
