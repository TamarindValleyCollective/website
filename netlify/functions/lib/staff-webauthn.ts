// Passkey (WebAuthn) support for super-admin second factors (issue #89), used
// by staff-mfa.mts. The protocol work (attestation/assertion parsing, signature
// and origin checks) is done by @simplewebauthn/server; this file decides what
// to expect: which site a passkey belongs to, which origins may use it, and
// that each challenge is accepted once.
//
// A passkey is bound to the site it was created on (the "relying party id").
// Ours is tvc.farm, so a passkey cannot be used from, or phished by, any other
// domain. Deploy previews and other hosts are refused rather than guessed at;
// `localhost` is allowed so the flow can be tried in local development.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { rest } from './staff-mfa-store';

const RP_NAME = 'TVC Admin';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type StoredPasskey = {
  id: string; // base64url credential id
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: string[];
};

export class WebAuthnOriginError extends Error {}

// The relying-party id and the one origin this request is allowed to come from.
export function relyingParty(req: Request): { rpID: string; origin: string } {
  const origin = req.headers.get('origin') ?? '';
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new WebAuthnOriginError('Passkeys need a browser request from the site itself.');
  }
  if (url.protocol === 'https:' && (url.hostname === 'tvc.farm' || url.hostname === 'www.tvc.farm')) return { rpID: 'tvc.farm', origin: url.origin };
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return { rpID: url.hostname, origin: url.origin };
  throw new WebAuthnOriginError('Passkeys only work on tvc.farm (not on previews or other addresses).');
}

const toB64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64url'));

// ------------------------------------------------------------- challenges
async function issueChallenge(staffId: string, purpose: 'register' | 'verify', challenge: string): Promise<void> {
  await rest(`/staff_webauthn_challenges?staff_id=eq.${staffId}&purpose=eq.${purpose}`, { method: 'DELETE' });
  await rest('/staff_webauthn_challenges', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ staff_id: staffId, purpose, challenge }),
  });
}

// Deleting is the consuming step, so a response replayed or raced a second time
// finds nothing. Returns false for a challenge that was never issued to this
// person for this purpose, was already used, or has expired.
async function consumeChallenge(staffId: string, purpose: 'register' | 'verify', challenge: string): Promise<boolean> {
  const res = await rest(`/staff_webauthn_challenges?staff_id=eq.${staffId}&purpose=eq.${purpose}&challenge=eq.${encodeURIComponent(challenge)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });
  const [row] = (await res.json()) as { created_at: string }[];
  return Boolean(row) && Date.now() - Date.parse(row.created_at) <= CHALLENGE_TTL_MS;
}

// The challenge the browser signed, read from its clientDataJSON. It is only
// a lookup key: it counts for nothing unless we issued it to this person.
function challengeFrom(response: { response?: { clientDataJSON?: string } }): string | null {
  try {
    const data = JSON.parse(Buffer.from(String(response.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ registration
export async function startRegistration(req: Request, staff: { id: string; label: string }, existing: StoredPasskey[]) {
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: staff.label,
    userID: new TextEncoder().encode(staff.id),
    attestationType: 'none', // we want a key we can verify later, not a statement about the device
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    // User verification (Face ID / Touch ID / PIN) is required: a stolen, unlocked device alone is not enough.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await issueChallenge(staff.id, 'register', options.challenge);
  return options;
}

export async function finishRegistration(req: Request, staffId: string, response: RegistrationResponseJSON): Promise<StoredPasskey | null> {
  const { rpID, origin } = relyingParty(req);
  const challenge = challengeFrom(response);
  if (!challenge || !(await consumeChallenge(staffId, 'register', challenge))) return null;
  try {
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!result.verified) return null;
    const { credential } = result.registrationInfo;
    return { id: credential.id, publicKey: toB64url(credential.publicKey), counter: credential.counter, transports: credential.transports as string[] | undefined };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- authentication
export async function startAuthentication(req: Request, staffId: string, passkeys: StoredPasskey[]) {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: 'required',
  });
  await issueChallenge(staffId, 'verify', options.challenge);
  return options;
}

// Returns the passkey used and its new counter, or null for anything wrong.
export async function finishAuthentication(
  req: Request,
  staffId: string,
  response: AuthenticationResponseJSON,
  passkeys: StoredPasskey[],
): Promise<{ passkey: StoredPasskey; newCounter: number } | null> {
  const { rpID, origin } = relyingParty(req);
  const passkey = passkeys.find((c) => c.id === response.id);
  const challenge = challengeFrom(response);
  if (!passkey || !challenge || !(await consumeChallenge(staffId, 'verify', challenge))) return null;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: passkey.id, publicKey: fromB64url(passkey.publicKey), counter: passkey.counter, transports: passkey.transports as never },
      requireUserVerification: true,
    });
    return result.verified ? { passkey, newCounter: result.authenticationInfo.newCounter } : null;
  } catch {
    return null;
  }
}
