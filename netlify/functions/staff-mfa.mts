// Netlify Function (v2 API) for super-admin second factors and step-up
// authentication (issue #89). Backs /internal/security. A super admin signs in
// with Google as usual (first factor), then proves a second factor to get a
// short-lived step-up token that the surfaces managing access itself require.
//
// Methods a person can hold at once: an authenticator app (TOTP, RFC 6238)
// and single-use recovery codes today; passkeys are the planned third (the
// table already has room for them). The Access module will only unlock for
// someone with at least two different methods enrolled — `ready` below — and
// a second super admin can reset someone's enrolment if they lose both.
//
// Everything here needs an active super admin (requireSuperAdmin) — a normal
// module role is not enough, and a super admin gets no module access from it.
// Secrets: TOTP secrets are stored AES-GCM encrypted, recovery codes only as
// an HMAC, both keyed from STAFF_MFA_KEY (lib/staff-mfa-crypto.ts). If that
// variable is missing every keyed operation fails closed with a clear error.
// Guessing is bounded: five wrong codes lock the person out for 15 minutes.
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { requireSuperAdmin, logStaffAction, type SuperAdmin } from './lib/staff-access';
import {
  MfaNotConfiguredError,
  STEPUP_TTL_MS,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  newTotpSecret,
  otpauthUri,
  signStepUp,
  verifyStepUp,
  verifyTotp,
  type StepUpMethod,
} from './lib/staff-mfa-crypto';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Factor = {
  id: string;
  staff_id: string;
  type: 'totp' | 'passkey';
  label: string | null;
  secret_encrypted: string | null;
  confirmed_at: string | null;
  last_used_step: number | null;
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // Responses can carry a secret or recovery codes: never cache them.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${base}/rest/v1${path}`, { ...init, headers: restHeaders(init.headers as Record<string, string>) });
  if (!res.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
  return res;
}

// ---------------------------------------------------------------- queries
async function getFactors(staffId: string): Promise<Factor[]> {
  const res = await rest(`/staff_mfa_factors?staff_id=eq.${staffId}&select=id,staff_id,type,label,secret_encrypted,confirmed_at,last_used_step&order=created_at.desc`);
  return (await res.json()) as Factor[];
}

async function unusedRecoveryCodeCount(staffId: string): Promise<number> {
  const res = await rest(`/staff_recovery_codes?staff_id=eq.${staffId}&used_at=is.null&select=id`);
  return ((await res.json()) as unknown[]).length;
}

async function getLockedUntil(staffId: string): Promise<number | null> {
  const res = await rest(`/staff_mfa_state?staff_id=eq.${staffId}&select=failed_attempts,locked_until`);
  const [state] = (await res.json()) as { failed_attempts: number; locked_until: string | null }[];
  const until = state?.locked_until ? Date.parse(state.locked_until) : null;
  return until && until > Date.now() ? until : null;
}

// Read-modify-write: two simultaneous wrong guesses could both read the same
// count, so a determined attacker might squeeze in a few attempts beyond the
// limit. Still bounded, and a second layer (the Google sign-in itself) sits in
// front; an atomic counter in SQL would close it fully.
async function registerFailure(staffId: string): Promise<{ lockedUntil: number | null }> {
  const res = await rest(`/staff_mfa_state?staff_id=eq.${staffId}&select=failed_attempts`);
  const [state] = (await res.json()) as { failed_attempts: number }[];
  const failed = (state?.failed_attempts ?? 0) + 1;
  const lockedUntil = failed >= MAX_FAILURES ? Date.now() + LOCK_MS : null;
  await rest('/staff_mfa_state?on_conflict=staff_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      staff_id: staffId,
      failed_attempts: lockedUntil ? 0 : failed,
      locked_until: lockedUntil ? new Date(lockedUntil).toISOString() : null,
    }),
  });
  return { lockedUntil };
}

async function clearFailures(staffId: string): Promise<void> {
  await rest('/staff_mfa_state?on_conflict=staff_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ staff_id: staffId, failed_attempts: 0, locked_until: null }),
  });
}

async function storeRecoveryCodes(staffId: string): Promise<string[]> {
  await rest(`/staff_recovery_codes?staff_id=eq.${staffId}`, { method: 'DELETE' });
  const codes = generateRecoveryCodes();
  await rest('/staff_recovery_codes', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(codes.map((code) => ({ staff_id: staffId, code_hash: hashRecoveryCode(code) }))),
  });
  return codes;
}

// ----------------------------------------------------------------- audit
// Security events carry ids and method names only — never a code or secret.
// Changes to what protects an account are logged first and refused if the log
// can't be written; routine verifications are logged best-effort so an audit
// outage can't lock every super admin out.
async function auditStrict(admin: SuperAdmin, action: string, detail?: Record<string, unknown>, targetId?: string): Promise<boolean> {
  try {
    await logStaffAction({ actorId: admin.id, action, detail, targetId });
    return true;
  } catch (err) {
    console.error('Failed to write staff audit log', err);
    return false;
  }
}
async function auditSoft(admin: SuperAdmin, action: string, detail?: Record<string, unknown>): Promise<void> {
  await auditStrict(admin, action, detail);
}

function stepUpHeader(req: Request): string | null {
  return req.headers.get('x-stepup-token');
}

function hasValidStepUp(req: Request, admin: SuperAdmin): boolean {
  return verifyStepUp(stepUpHeader(req), admin.id, Date.now()) !== null;
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function lockedResponse(until: number): Response {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  return jsonResponse({ error: 'Too many wrong codes. Try again later.', code: 'LOCKED', retryAfterSeconds: seconds }, 429, { 'retry-after': String(seconds) });
}

// ---------------------------------------------------------------- handlers
async function methodsFor(staffId: string) {
  const [factors, recoveryRemaining] = await Promise.all([getFactors(staffId), unusedRecoveryCodeCount(staffId)]);
  const totp = factors.some((f) => f.type === 'totp' && f.confirmed_at);
  const passkey = factors.some((f) => f.type === 'passkey' && f.confirmed_at);
  const recovery = recoveryRemaining > 0;
  const methodCount = [totp, recovery, passkey].filter(Boolean).length;
  return { factors, totp, passkey, recovery, recoveryRemaining, methodCount, ready: methodCount >= 2 };
}

async function handleStatus(req: Request, admin: SuperAdmin): Promise<Response> {
  const mine = await methodsFor(admin.id);
  const lockedUntil = await getLockedUntil(admin.id);

  // The other super admins, by name or an opaque tag (never an email), so a
  // second one can be asked to reset someone who has lost their methods.
  const res = await rest('/staff_users?is_super_admin=is.true&active=is.true&select=id,name');
  const others = ((await res.json()) as { id: string; name: string | null }[]).filter((a) => a.id !== admin.id);
  const admins = await Promise.all(
    others.map(async (a) => {
      const m = await methodsFor(a.id);
      return { id: a.id, label: a.name ?? `Super admin ${a.id.slice(0, 4).toUpperCase()}`, methodCount: m.methodCount, ready: m.ready };
    }),
  );

  return jsonResponse({
    methods: { totp: mine.totp, recovery: mine.recovery, recoveryCodesRemaining: mine.recoveryRemaining, passkey: mine.passkey },
    pendingTotp: mine.factors.some((f) => f.type === 'totp' && !f.confirmed_at),
    methodCount: mine.methodCount,
    ready: mine.ready,
    stepUpValid: hasValidStepUp(req, admin),
    lockedUntil: lockedUntil ? new Date(lockedUntil).toISOString() : null,
    admins,
  });
}

async function handleTotpStart(req: Request, admin: SuperAdmin): Promise<Response> {
  const factors = await getFactors(admin.id);
  // Replacing a working authenticator must be proven with a second factor, or
  // anyone holding a stolen Google session could swap it out.
  if (factors.some((f) => f.type === 'totp' && f.confirmed_at) && !hasValidStepUp(req, admin)) {
    return jsonResponse({ error: 'Verify a second factor before replacing your authenticator.', code: 'STEP_UP_REQUIRED' }, 403);
  }
  if (!(await auditStrict(admin, 'staff_mfa.totp_started'))) return jsonResponse({ error: 'Could not write the audit log.' }, 500);

  await rest(`/staff_mfa_factors?staff_id=eq.${admin.id}&type=eq.totp&confirmed_at=is.null`, { method: 'DELETE' });
  const secret = newTotpSecret();
  const label = admin.name ?? admin.googleName ?? `Super admin ${admin.id.slice(0, 4).toUpperCase()}`;
  await rest('/staff_mfa_factors', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ staff_id: admin.id, type: 'totp', label, secret_encrypted: encryptSecret(secret) }),
  });
  // Shown once, to its owner, so they can add it to an authenticator app.
  return jsonResponse({ secret: base32Encode(secret), otpauthUri: otpauthUri(secret, label) });
}

async function handleTotpConfirm(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ code?: string }>(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);
  const lockedUntil = await getLockedUntil(admin.id);
  if (lockedUntil) return lockedResponse(lockedUntil);

  const pending = (await getFactors(admin.id)).find((f) => f.type === 'totp' && !f.confirmed_at && f.secret_encrypted);
  if (!pending) return jsonResponse({ error: 'Start setting up an authenticator first.', code: 'NOTHING_PENDING' }, 409);

  const step = verifyTotp(decryptSecret(pending.secret_encrypted!), String(body.code ?? '').replace(/\s/g, ''), Date.now(), null);
  if (step === null) {
    const { lockedUntil: locked } = await registerFailure(admin.id);
    await auditSoft(admin, 'staff_mfa.failed', { method: 'totp', during: 'enrolment', locked: Boolean(locked) });
    return locked ? lockedResponse(locked) : jsonResponse({ error: 'That code did not match. Check the app and try the next code.' }, 400);
  }

  await rest(`/staff_mfa_factors?id=eq.${pending.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ confirmed_at: new Date().toISOString(), last_used_step: step, last_used_at: new Date().toISOString() }),
  });
  // Any earlier, replaced authenticator stops working now.
  await rest(`/staff_mfa_factors?staff_id=eq.${admin.id}&type=eq.totp&id=neq.${pending.id}`, { method: 'DELETE' });
  await clearFailures(admin.id);

  // The first authenticator comes with a set of recovery codes (the second
  // method), shown once.
  const hasRecovery = (await unusedRecoveryCodeCount(admin.id)) > 0;
  const recoveryCodes = hasRecovery ? undefined : await storeRecoveryCodes(admin.id);
  await auditSoft(admin, 'staff_mfa.totp_confirmed', { recoveryCodesIssued: Boolean(recoveryCodes) });
  return jsonResponse({ ok: true, recoveryCodes });
}

async function handleVerify(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ method?: string; code?: string }>(req);
  if (!body || (body.method !== 'totp' && body.method !== 'recovery')) {
    return jsonResponse({ error: 'method must be "totp" or "recovery"' }, 400);
  }
  const method: StepUpMethod = body.method;
  const code = String(body.code ?? '').trim();

  const lockedUntil = await getLockedUntil(admin.id);
  if (lockedUntil) return lockedResponse(lockedUntil);

  let ok = false;
  if (method === 'totp') {
    const factor = (await getFactors(admin.id)).find((f) => f.type === 'totp' && f.confirmed_at && f.secret_encrypted);
    const step = factor ? verifyTotp(decryptSecret(factor.secret_encrypted!), code.replace(/\s/g, ''), Date.now(), factor.last_used_step) : null;
    if (factor && step !== null) {
      // Atomic replay guard: only the request that moves last_used_step
      // forward wins, so a code accepted once can't be accepted again, even
      // by a request racing this one.
      const res = await rest(`/staff_mfa_factors?id=eq.${factor.id}&or=(last_used_step.is.null,last_used_step.lt.${step})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ last_used_step: step, last_used_at: new Date().toISOString() }),
      });
      ok = ((await res.json()) as unknown[]).length > 0;
    }
  } else {
    // Single use: marking it used and checking it was unused is one statement.
    const res = await rest(`/staff_recovery_codes?staff_id=eq.${admin.id}&code_hash=eq.${hashRecoveryCode(code)}&used_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });
    ok = ((await res.json()) as unknown[]).length > 0;
  }

  if (!ok) {
    const { lockedUntil: locked } = await registerFailure(admin.id);
    await auditSoft(admin, 'staff_mfa.failed', { method, locked: Boolean(locked) });
    // 400, not 401: the caller's session is fine, the code is what's wrong.
    return locked ? lockedResponse(locked) : jsonResponse({ error: 'That code did not work.', code: 'WRONG_CODE' }, 400);
  }

  await clearFailures(admin.id);
  await auditSoft(admin, 'staff_mfa.verified', { method });
  return jsonResponse({
    stepUpToken: signStepUp(admin.id, method, Date.now()),
    expiresInSeconds: STEPUP_TTL_MS / 1000,
    method,
    recoveryCodesRemaining: await unusedRecoveryCodeCount(admin.id),
  });
}

async function handleRegenerateRecovery(req: Request, admin: SuperAdmin): Promise<Response> {
  if (!hasValidStepUp(req, admin)) return jsonResponse({ error: 'Verify a second factor first.', code: 'STEP_UP_REQUIRED' }, 403);
  if (!(await auditStrict(admin, 'staff_mfa.recovery_regenerated'))) return jsonResponse({ error: 'Could not write the audit log.' }, 500);
  return jsonResponse({ recoveryCodes: await storeRecoveryCodes(admin.id) });
}

// A second super admin clears someone's enrolment (a lost phone and lost
// codes), after which that person enrols again from scratch.
async function handleReset(req: Request, admin: SuperAdmin): Promise<Response> {
  if (!hasValidStepUp(req, admin)) return jsonResponse({ error: 'Verify a second factor first.', code: 'STEP_UP_REQUIRED' }, 403);
  const body = await readJson<{ targetId?: string }>(req);
  const targetId = body?.targetId ?? '';
  if (!UUID.test(targetId)) return jsonResponse({ error: 'targetId must be a UUID' }, 400);
  if (targetId === admin.id) return jsonResponse({ error: 'Another super admin has to reset your enrolment.' }, 400);

  const res = await rest(`/staff_users?id=eq.${targetId}&is_super_admin=is.true&active=is.true&select=id`);
  if (((await res.json()) as unknown[]).length === 0) return jsonResponse({ error: 'Super admin not found' }, 404);

  if (!(await auditStrict(admin, 'staff_mfa.reset', undefined, targetId))) return jsonResponse({ error: 'Could not write the audit log.' }, 500);
  await rest(`/staff_mfa_factors?staff_id=eq.${targetId}`, { method: 'DELETE' });
  await rest(`/staff_recovery_codes?staff_id=eq.${targetId}`, { method: 'DELETE' });
  await rest(`/staff_mfa_state?staff_id=eq.${targetId}`, { method: 'DELETE' });
  return jsonResponse({ ok: true });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  type Route = (admin: SuperAdmin) => Promise<Response>;
  const route: Route | null =
    url.pathname === '/api/staff-mfa/status' && req.method === 'GET'
      ? (a) => handleStatus(req, a)
      : url.pathname === '/api/staff-mfa/totp/start' && req.method === 'POST'
        ? (a) => handleTotpStart(req, a)
        : url.pathname === '/api/staff-mfa/totp/confirm' && req.method === 'POST'
          ? (a) => handleTotpConfirm(req, a)
          : url.pathname === '/api/staff-mfa/verify' && req.method === 'POST'
            ? (a) => handleVerify(req, a)
            : url.pathname === '/api/staff-mfa/recovery-codes' && req.method === 'POST'
              ? (a) => handleRegenerateRecovery(req, a)
              : url.pathname === '/api/staff-mfa/reset' && req.method === 'POST'
                ? (a) => handleReset(req, a)
                : null;
  if (!route) return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  try {
    return await route(auth.admin);
  } catch (err) {
    if (err instanceof MfaNotConfiguredError) {
      console.error('Second factors are not configured:', err.message);
      return jsonResponse({ error: 'Second-factor storage is not configured yet (STAFF_MFA_KEY).', code: 'MFA_NOT_CONFIGURED' }, 500);
    }
    console.error('staff-mfa request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = {
  path: [
    '/api/staff-mfa/status',
    '/api/staff-mfa/totp/start',
    '/api/staff-mfa/totp/confirm',
    '/api/staff-mfa/verify',
    '/api/staff-mfa/recovery-codes',
    '/api/staff-mfa/reset',
  ],
};
