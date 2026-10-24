// Request handling for the partner API, kept free of Netlify and Supabase
// imports: everything it needs arrives through `deps`, so it is tested with
// fakes (partner-api-core.test.mjs) and netlify/functions/partner-api.mts is a
// thin wrapper that supplies the real ones.
//
// Phase 1 is read-only: GET /api/partner/v1/units and
// GET /api/partner/v1/availability. Order of checks matters and is deliberate:
//   1. unknown path -> 404, wrong method -> 405 (reveals nothing about keys);
//   2. the key -> 401, with ONE message whether the key is missing, malformed,
//      unknown, revoked or expired, so a caller learns nothing from the
//      difference; failed attempts are counted per IP (deps.authFailAllowed);
//   3. the per-key request limit -> 429;
//   4. only then any database work for the partner.
// Responses never contain guest data, and never say who owns a unit or why one
// is unavailable.
import { parseBearerKey, hashPartnerKey, isKeyUsable } from './partner-keys.mjs';
import { toCatalogue, parseWindow, buildAvailability, bookingRange } from './partner-availability.mjs';

export const BASE_PATH = '/api/partner/v1';
const TOUCH_INTERVAL_MS = 10 * 60_000;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
}

const fail = (status, code, message, extra) => json({ error: { code, message } }, status, extra);

export async function handlePartnerRequest(req, deps) {
  const url = new URL(req.url);
  const route = url.pathname.startsWith(`${BASE_PATH}/`) ? url.pathname.slice(BASE_PATH.length) : null;
  if (route !== '/units' && route !== '/availability') return fail(404, 'not_found', 'Not found');
  if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'Only GET is supported', { allow: 'GET' });

  const now = deps.now ? deps.now() : new Date();

  // --- 2. authenticate
  const key = parseBearerKey(req.headers.get('authorization'));
  let keyRow = null;
  if (key) {
    try {
      keyRow = await deps.findKeyByHash(hashPartnerKey(key));
    } catch (err) {
      console.error('[partner-api] key lookup failed', { message: err?.message });
      return fail(502, 'upstream_error', 'The calendar is temporarily unavailable. Try again shortly.');
    }
  }
  if (!isKeyUsable(keyRow, now)) {
    if (!(await deps.authFailAllowed(deps.clientIp(req)))) {
      return fail(429, 'rate_limited', 'Too many failed attempts. Try again later.', { 'retry-after': '300' });
    }
    return fail(401, 'invalid_key', 'Missing or invalid API key', { 'www-authenticate': 'Bearer' });
  }

  // --- 3. rate limit
  if (!(await deps.keyRateAllowed(keyRow.id))) {
    return fail(429, 'rate_limited', 'Too many requests. Slow down.', { 'retry-after': '60' });
  }

  // Throttled, best-effort: a failed write here must never fail the request.
  if (!keyRow.last_used_at || now.getTime() - new Date(keyRow.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
    deps.touchKey(keyRow.id).catch(() => {});
  }

  try {
    const access = await deps.getPartnerAccess(keyRow.partner_id);
    const pools = access.pools.filter((p) => p.active);

    if (route === '/units') return json(toCatalogue({ units: access.units, pools }));

    const window = parseWindow(url.searchParams.get('from'), url.searchParams.get('to'), now);
    if (window.error) return fail(422, 'invalid_window', window.error);

    const units = access.units.filter((u) => u.active);
    const unitIds = [...new Set([...units.map((u) => u.id), ...pools.flatMap((p) => p.units.filter((u) => u.active).map((u) => u.id))])];
    const from = window.dates[0];
    const to = new Date(Date.parse(`${window.dates[window.dates.length - 1]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const [assignments, blockingBookings] = await Promise.all([deps.listAssignments(unitIds, from, to), deps.listBlockingBookings(from, to)]);

    return json({
      ...buildAvailability({ dates: window.dates, units, pools, assignments, blocks: blockingBookings.map(bookingRange) }),
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    console.error('[partner-api] upstream failure', { partner: keyRow.partner_id, route, message: err?.message });
    return fail(502, 'upstream_error', 'The calendar is temporarily unavailable. Try again shortly.');
  }
}
