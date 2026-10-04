// Cryptographic building blocks for super-admin step-up authentication
// (issue #89): TOTP (RFC 6238), encrypted storage of TOTP secrets, single-use
// recovery codes, and the short-lived signed token a successful step-up
// returns. Pure functions only — no network, no database — so they can be
// tested directly (RFC 6238's published vectors in particular).
//
// One secret, STAFF_MFA_KEY (32+ random bytes, base64), set in Netlify's
// environment by a human and never seen by the assistant. Separate keys are
// derived from it per purpose (HKDF), so the key that encrypts TOTP secrets
// is not the one that signs step-up tokens or hashes recovery codes. Every
// function here throws MfaNotConfiguredError if it is missing or too short,
// and the Function turns that into a 500 — fail closed.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export class MfaNotConfiguredError extends Error {
  constructor() {
    super('STAFF_MFA_KEY is missing or shorter than 32 bytes');
  }
}

function derivedKey(purpose: 'enc' | 'sign' | 'recovery'): Buffer {
  const raw = process.env.STAFF_MFA_KEY;
  const master = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (master.length < 32) throw new MfaNotConfiguredError();
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `tvc-staff-mfa:${purpose}`, 32));
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- base32
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ------------------------------------------------------------------ TOTP
export const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

// RFC 4226 HOTP over HMAC-SHA1, the algorithm every authenticator app uses
// by default.
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

// Returns the matched time step, or null. Accepts one step either side of
// now (clock drift), and refuses any step at or before `lastUsedStep` so a
// code that was already accepted can't be replayed inside its window.
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const supplied = Buffer.from(code);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // No early exit: every candidate step is checked so timing doesn't reveal
  // which one (if any) matched.
  for (const step of [current - 1, current, current + 1]) {
    const ok = safeEqual(supplied, Buffer.from(hotp(secret, step)));
    if (ok && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function otpauthUri(secret: Buffer, accountLabel: string): string {
  const issuer = 'TVC Admin';
  return (
    `otpauth://totp/${encodeURIComponent(`${issuer}:${accountLabel}`)}` +
    `?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}

// ------------------------------------------- secret storage (AES-256-GCM)
export function encryptSecret(plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey('enc'), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(blob: string): Buffer {
  const [version, iv, tag, ct] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognized secret format');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey('enc'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

// ------------------------------------------------------- recovery codes
// Crockford base32 (no I, L, O, U): ten characters is 50 bits, shown as
// XXXXX-XXXXX. Stored only as an HMAC, compared in constant time, single use.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  });
}

// Forgiving of how a person copies a code: case, spaces, hyphen, and the
// look-alike letters Crockford maps (O->0, I/L->1).
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', derivedKey('recovery')).update(normalizeRecoveryCode(code)).digest('hex');
}

// ------------------------------------------------------- step-up tokens
export const STEPUP_TTL_MS = 10 * 60 * 1000;
export type StepUpMethod = 'totp' | 'recovery';

type StepUpClaims = { sid: string; m: StepUpMethod; iat: number; exp: number };

// Stateless: <base64url claims>.<base64url HMAC>. Bound to one staff member
// and expires after ten minutes; the signature key never leaves the server.
export function signStepUp(staffId: string, method: StepUpMethod, nowMs: number): string {
  const claims: StepUpClaims = { sid: staffId, m: method, iat: nowMs, exp: nowMs + STEPUP_TTL_MS };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', derivedKey('sign')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyStepUp(token: string | null | undefined, staffId: string, nowMs: number): { method: StepUpMethod } | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', derivedKey('sign')).update(body).digest();
  if (!safeEqual(Buffer.from(sig, 'base64url'), expected)) return null;
  let claims: StepUpClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (claims.sid !== staffId || typeof claims.exp !== 'number' || claims.exp <= nowMs) return null;
  return { method: claims.m };
}
