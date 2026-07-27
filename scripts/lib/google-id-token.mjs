// Verifies a Google Identity Services ID token (the JWT a curator gets after
// signing in with "Sign in with Google" on /internal/photo-pool). This is
// the reverse direction of google-drive.mjs's hand-rolled service-account
// JWT *signing* (which authenticates *to* Google's APIs) — here we're
// *verifying* a token Google already signed, using the same hand-rolled,
// Node-crypto-only approach rather than adding google-auth-library/
// jsonwebtoken, consistent with this repo's preference for small hand-rolled
// implementations over heavy libraries for well-defined tasks.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000; // fallback if the response has no Cache-Control

let cachedJwks = null; // { keys: Map<kid, KeyObject>, expiresAt }

function base64urlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function parseMaxAge(cacheControl) {
  const match = cacheControl?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) * 1000 : null;
}

async function getJwks({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedJwks && cachedJwks.expiresAt > Date.now()) {
    return cachedJwks.keys;
  }

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
  const data = await res.json();

  const keys = new Map();
  for (const jwk of data.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  }

  const ttl = parseMaxAge(res.headers.get('cache-control')) ?? DEFAULT_JWKS_TTL_MS;
  cachedJwks = { keys, expiresAt: Date.now() + ttl };
  return keys;
}

// Returns the verified payload ({ email, email_verified, name, exp, ... }) or
// throws with a message safe to log (never includes the token itself).
export async function verifyGoogleIdToken(idToken, { audience }) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64urlDecode(headerB64).toString('utf-8'));
  // Hardcode the expected algorithm rather than trusting the token's own
  // header - the standard defense against algorithm-confusion attacks (e.g.
  // a forged token claiming HS256 and using this public key as an HMAC
  // secret would otherwise be accepted).
  if (header.alg !== 'RS256') throw new Error(`Unexpected ID token algorithm: ${header.alg}`);

  let keys = await getJwks();
  let key = keys.get(header.kid);
  if (!key) {
    // Google rotates signing keys infrequently; a cache miss might just mean
    // ours is stale, not that the token is invalid - refetch once before
    // failing closed.
    keys = await getJwks({ forceRefresh: true });
    key = keys.get(header.kid);
  }
  if (!key) throw new Error('No matching JWKS key for ID token');

  const signature = base64urlDecode(signatureB64);
  const signedData = `${headerB64}.${payloadB64}`;
  if (!cryptoVerify('RSA-SHA256', Buffer.from(signedData), key, signature)) {
    throw new Error('ID token signature verification failed');
  }

  const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('ID token expired');
  if (!VALID_ISSUERS.has(payload.iss)) throw new Error(`Unexpected ID token issuer: ${payload.iss}`);
  if (payload.aud !== audience) throw new Error('ID token audience mismatch');
  if (payload.email_verified !== true) throw new Error('ID token email not verified');

  return payload;
}
