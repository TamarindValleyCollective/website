// The gate in front of anything that changes who can do what (the Access
// module, issue #89). Three things must all be true of the caller, checked in
// this order:
//   1. they are an active super admin (requireSuperAdmin — a normal module
//      role is not enough, and it grants no module access by itself);
//   2. they have at least two different second-factor methods enrolled, so a
//      single lost phone can't leave the person who manages access with one
//      point of failure (code MFA_NOT_READY, sends them to /internal/security);
//   3. they have just proven one of those factors, shown by a valid, unexpired
//      step-up token bound to them in the X-Stepup-Token header (code
//      STEP_UP_REQUIRED, sends them to the "Prove it's you" form).
// Reading the Access data needs only (1); this guard is for changes.
import { requireSuperAdmin, type SuperAdmin } from './staff-access';
import { MfaNotConfiguredError, verifyStepUp } from './staff-mfa-crypto';
import { mfaSummary } from './staff-mfa-store';

export type AccessAdminResult =
  | { ok: true; admin: SuperAdmin }
  | { ok: false; status: 401 | 403 | 500; error: string; code?: 'MFA_NOT_READY' | 'STEP_UP_REQUIRED' | 'MFA_NOT_CONFIGURED' };

export function stepUpIsValid(req: Request, staffId: string): boolean {
  return verifyStepUp(req.headers.get('x-stepup-token'), staffId, Date.now()) !== null;
}

export async function requireAccessAdmin(req: Request): Promise<AccessAdminResult> {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth;

  const mfa = await mfaSummary(auth.admin.id);
  if (!mfa.ready) {
    return {
      ok: false,
      status: 403,
      code: 'MFA_NOT_READY',
      error: 'Set up two different second-factor methods before changing access (see /internal/security).',
    };
  }

  try {
    if (!stepUpIsValid(req, auth.admin.id)) {
      return { ok: false, status: 403, code: 'STEP_UP_REQUIRED', error: 'Verify a second factor first.' };
    }
  } catch (err) {
    if (err instanceof MfaNotConfiguredError) {
      console.error('Second factors are not configured:', err.message);
      return { ok: false, status: 500, code: 'MFA_NOT_CONFIGURED', error: 'Second-factor storage is not configured yet (STAFF_MFA_KEY).' };
    }
    throw err;
  }

  return { ok: true, admin: auth.admin };
}
