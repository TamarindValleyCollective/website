// Shared authentication + authorization for the internal admin Functions
// (issue #89), replacing the per-function copies of "verify Google ID token,
// check a Sheet allow-list" in photo-pool.mts, whatsapp-admin.mts,
// event-payments-admin.mts and accommodation-admin.mts.
//
// Google Sign-In is still only the identity proof (verifyGoogleIdToken);
// authorization comes from staff_users / staff_module_roles in the TVC ERP
// Supabase project (supabase/migrations/0028_staff_access.sql), read with the
// service_role key — RLS denies everything else. What each role may do is in
// staff-registry.ts.
//
// Fails closed throughout: a lookup error is a 500, never a pass-through. A
// `super_admin` flag does NOT grant module access — it only manages access
// (a separate, step-up-protected surface), so a super admin who wants to use
// a module needs an ordinary role row there, which is audited.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';
import { verifyGoogleIdToken } from '../../../scripts/lib/google-id-token.mjs';
import { roleHasCapability, type Capability, type ModuleId, type Role } from './staff-registry';

// Addresses on these domains belong to a Google Workspace we administer, so
// the token's `hd` (hosted domain) claim must match — a Google account that
// merely *has* an address like this but isn't org-managed carries no `hd`
// and is rejected. Everyone else (personal Gmail) is identified by the
// allow-listed address alone.
const MANAGED_DOMAINS = new Set(['tvc.farm', 'syntropic.in']);

// Short, so revoking a user or role takes effect within seconds, while a
// dashboard that polls every few seconds doesn't hit Supabase on every poll.
const CACHE_TTL_MS = 30 * 1000;

export type RoleScope = { allowedTypes?: string[] } | null;

export type StaffIdentity = {
  id: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
};

// googleName is the profile name on the Google ID token for *this* request
// (null if the account has none) — not stored, and distinct from `name`, the
// one registered in staff_users. Callers that need a display name fall back
// from `name` to this.
export type StaffGrant = StaffIdentity & { role: Role; scope: RoleScope; googleName: string | null };

export type StaffAuthResult =
  | { ok: true; staff: StaffGrant }
  | { ok: false; status: 401 | 403 | 500; error: string };

type StaffRow = {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
  is_super_admin: boolean;
  staff_module_roles: { role: Role; scope: RoleScope }[];
};

const cache = new Map<string, { row: StaffRow | null; expiresAt: number }>();

async function lookupStaff(email: string, module: ModuleId): Promise<StaffRow | null> {
  const key = `${module}:${email}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.row;

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  // Two plain queries, not one embedded select: staff_module_roles has two
  // foreign keys to staff_users (staff_id and granted_by), so PostgREST can't
  // infer which one an `staff_module_roles(...)` embed means and answers
  // PGRST201 / HTTP 300. That broke every admin page when this first shipped.
  const userRes = await fetch(
    `${supabaseUrl}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}` +
      `&select=id,email,name,active,is_super_admin`,
    { headers: restHeaders() },
  );
  if (!userRes.ok) throw new Error(`staff_users lookup failed: ${userRes.status}`);
  const user = ((await userRes.json()) as Omit<StaffRow, 'staff_module_roles'>[])[0];

  let row: StaffRow | null = null;
  if (user) {
    // A known user with no role in this module gets an empty array, which
    // requireStaff turns into the same 403 as an unknown user.
    const roleRes = await fetch(
      `${supabaseUrl}/rest/v1/staff_module_roles?staff_id=eq.${user.id}` +
        `&module=eq.${encodeURIComponent(module)}&select=role,scope`,
      { headers: restHeaders() },
    );
    if (!roleRes.ok) throw new Error(`staff_module_roles lookup failed: ${roleRes.status}`);
    row = { ...user, staff_module_roles: (await roleRes.json()) as StaffRow['staff_module_roles'] };
  }
  cache.set(key, { row, expiresAt: Date.now() + CACHE_TTL_MS });
  return row;
}

// First sign-in with an empty registered name: copy the name from their Google
// account (the ID token's `name` claim). `name=is.null` in the filter makes
// this safe against a race and means a name already on file is never
// overwritten. Best-effort — a failure only leaves the name empty for now.
async function fillNameIfEmpty(staffId: string, name: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${supabaseUrl}/rest/v1/staff_users?id=eq.${staffId}&name=is.null`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`staff_users name update failed: ${res.status}`);
}

// Verifies the caller's Google ID token and checks that they hold a role in
// `module` that carries `capability`. The one call every admin Function
// makes before doing anything.
export async function requireStaff<M extends ModuleId>(
  req: Request,
  module: M,
  capability: Capability<M>,
): Promise<StaffAuthResult> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Sign-in required' };

  const clientId = process.env.PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('Missing PUBLIC_GOOGLE_CLIENT_ID');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  let email: string;
  let googleName: string | null = null;
  try {
    const payload = await verifyGoogleIdToken(token, { audience: clientId });
    email = String(payload.email).toLowerCase();
    googleName = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
    const domain = email.split('@')[1];
    if (MANAGED_DOMAINS.has(domain) && payload.hd !== domain) {
      return { ok: false, status: 403, error: 'Not authorized' };
    }
  } catch (err) {
    console.error('ID token verification failed', err);
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  let row: StaffRow | null;
  try {
    row = await lookupStaff(email, module);
  } catch (err) {
    console.error('Failed to look up staff access', err);
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  // Same message for "unknown", "deactivated", "no role here" and "role lacks
  // this capability" — the response shouldn't reveal which people exist.
  const grant = row?.active ? row.staff_module_roles[0] : undefined;
  if (!row || !grant || !roleHasCapability(module, grant.role, capability)) {
    return { ok: false, status: 403, error: 'Not authorized' };
  }

  // Only for someone who passed every check above, so an unauthorized
  // Google account can never cause a write.
  if (!row.name && googleName) {
    try {
      await fillNameIfEmpty(row.id, googleName);
      row.name = googleName; // the cached row, so the next request skips this
    } catch (err) {
      console.error('Failed to fill the staff name from Google', err);
    }
  }

  return {
    ok: true,
    staff: {
      id: row.id,
      email: row.email,
      name: row.name,
      isSuperAdmin: row.is_super_admin,
      role: grant.role,
      scope: grant.scope,
      googleName,
    },
  };
}

// Appends to staff_audit_log. Throws on failure so a caller doing something
// sensitive (a refund, a grant) can refuse to proceed unlogged. `detail`
// must never contain raw PII — ids and field names, not values.
export async function logStaffAction(entry: {
  actorId: string;
  action: string;
  module?: ModuleId;
  targetId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${supabaseUrl}/rest/v1/staff_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      actor_id: entry.actorId,
      action: entry.action,
      module: entry.module ?? null,
      target_id: entry.targetId ?? null,
      detail: entry.detail ?? null,
    }),
  });
  if (!res.ok) throw new Error(`staff_audit_log insert failed: ${res.status}`);
}
