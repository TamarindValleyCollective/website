// Netlify Function (v2 API) behind /api/partner/v1/*: the partner API Linger
// uses to read TVC's accommodation calendar. Phase 1 is read-only (GET /units,
// GET /availability); holds and bookings arrive in phase 2. Design:
// the "Partner Calendar API: Technical Spec" doc and ARCHITECTURE.md.
//
// All the logic lives in scripts/lib/partner-api-core.mjs (tested with fakes);
// this file only wires in the real database, rate limiter and client IP.
//
// Auth is a per-partner bearer key (scripts/lib/partner-keys.mjs), not Google
// Sign-In: this is machine-to-machine, so none of the admin tools'
// requireStaff machinery applies. The function can read booking dates and
// nothing else: it never touches the guest tables.
import { handlePartnerRequest } from '../../scripts/lib/partner-api-core.mjs';
import { findKeyByHash, touchKey, getPartnerAccess, listAssignments, listBlockingBookings } from '../../scripts/lib/partner-db.mjs';
import { checkIpRateLimit, clientIp } from './lib/rate-limit';

const STORE = 'partner-api-rate-limit';

// Same stance as chat.mts: if the limiter's store is down, let the request
// through (and say so) rather than locking a paying partner out.
async function allowed(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (err) {
    console.error('[partner-api] Rate limiter unavailable, allowing request', err);
    return true;
  }
}

export default async (req: Request): Promise<Response> =>
  handlePartnerRequest(req, {
    findKeyByHash,
    touchKey,
    getPartnerAccess,
    listAssignments,
    listBlockingBookings,
    clientIp,
    // 60 requests a minute per key.
    keyRateAllowed: (keyId: string) => allowed(() => checkIpRateLimit(STORE, `key:${keyId}`, 60_000, 60, { strong: true })),
    // 20 failed attempts per IP in 5 minutes.
    authFailAllowed: (ip: string) => allowed(() => checkIpRateLimit(`${STORE}-auth`, ip, 5 * 60_000, 20, { strong: true })),
  });

export const config = {
  path: ['/api/partner/v1/*'],
};
