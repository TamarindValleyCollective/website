// API keys for partners (Linger) calling netlify/functions/partner-api.mts.
//
// A key is 256 random bits, so a plain SHA-256 hash is enough to store it
// (unlike a human password there is nothing to brute-force). Only the hash and
// a short display prefix are kept in partner_api_keys; the key itself is shown
// once, when it is issued, and cannot be recovered. Plain ESM, node:crypto
// only, so both the Netlify Function bundle and scripts/partner-key.mjs can
// import it.
import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'tvcp_';
// 32 bytes -> 43 base64url characters.
const KEY_PATTERN = /^tvcp_[A-Za-z0-9_-]{43}$/;

export function generatePartnerKey() {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 4), hash: hashPartnerKey(key) };
}

export function hashPartnerKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

// The key from an `Authorization: Bearer <key>` header, or null when the
// header is missing or the value cannot be one of our keys (cheap rejection
// before any database lookup).
export function parseBearerKey(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !KEY_PATTERN.test(match[1])) return null;
  return match[1];
}

// Whether a key row from partner_api_keys may be used right now.
export function isKeyUsable(row, now = new Date()) {
  if (!row || row.revoked_at) return false;
  if (row.expires_at && new Date(row.expires_at) <= now) return false;
  return true;
}
