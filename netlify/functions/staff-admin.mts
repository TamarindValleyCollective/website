// Netlify Function (v2 API) behind the Access module (issue #89): see who is
// in the system, give or take away module roles, add a person, and deactivate
// or reactivate someone. Backs /internal/access.
//
// Who may use it: super admins only. Reading needs a signed-in super admin;
// every change goes through requireAccessAdmin (lib/staff-admin-guard.ts):
// the caller must also have two different second-factor methods enrolled and
// must have just proven one (a valid step-up token).
//
// What it deliberately does not do:
//   * create, promote or remove super admins — that stays a manual database
//     step, being the most powerful and the rarest action;
//   * delete anyone — people are deactivated, so history keeps its names;
//   * show anyone's email. An address is typed once to add a person and is
//     never read back: no response from this Function contains one.
// Each change is written to staff_audit_log *before* it is made and refused if
// the log can't be written, so nothing happens unrecorded. Staff are recorded
// by id; the log holds ids, module names, roles and booking types only.
import { requireSuperAdmin, logStaffAction, type SuperAdmin } from './lib/staff-access';
import { maskEmail } from './lib/staff-masking';
import { requireAccessAdmin, stepUpIsValid } from './lib/staff-admin-guard';
import { MfaNotConfiguredError } from './lib/staff-mfa-crypto';
import { mfaSummary, rest } from './lib/staff-mfa-store';
import {
  BOOKING_TYPES,
  MODULES,
  MODULE_INFO,
  ROLES,
  capabilitiesForRole,
  isModuleId,
  isRole,
  type ModuleId,
  type Role,
} from './lib/staff-registry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RoleScope = { allowedTypes?: string[] } | null;
type PersonRow = { id: string; name: string | null; email?: string | null; active: boolean; is_super_admin: boolean };
type RoleRow = { staff_id: string; module: string; role: Role; scope: RoleScope };

function jsonResponse(body: unknown, status = 200): Response {
  // Never cached: these responses describe who can do what right now.
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// A person is shown by name. Until Google fills one in on their first sign-in
// they are shown by their address with all but the first character of the
// local part hidden ("p••••@tvc.farm"), so the person who added them can tell
// who it is without the address ever being sent. The address is read only to be
// masked here; the full value never appears in a response. With no address to
// go on, a short opaque tag is used.
function labelFor(p: { id: string; name: string | null; email?: string | null }): string {
  return p.name ?? (p.email ? maskEmail(p.email) : `Person ${p.id.slice(0, 4).toUpperCase()}`);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function audit(admin: SuperAdmin, action: string, opts: { module?: ModuleId; targetId?: string; detail?: Record<string, unknown> }): Promise<boolean> {
  try {
    await logStaffAction({ actorId: admin.id, action, ...opts });
    return true;
  } catch (err) {
    console.error('Failed to write staff audit log', err);
    return false;
  }
}

async function getPerson(id: string): Promise<PersonRow | null> {
  const res = await rest(`/staff_users?id=eq.${id}&select=id,name,active,is_super_admin`);
  return ((await res.json()) as PersonRow[])[0] ?? null;
}

// ----------------------------------------------------------------- catalog
// What the screen needs to explain a choice: each module, its roles, and in
// plain words what each role allows. Descriptions come from MODULE_INFO; a
// capability with no sentence falls back to its own name rather than hiding
// the module.
function moduleCatalog() {
  return (Object.keys(MODULES) as ModuleId[]).map((module) => ({
    id: module,
    label: MODULE_INFO[module].label,
    roles: ROLES.map((role) => ({
      role,
      capabilities: capabilitiesForRole(module, role).map((c) => ({ id: c, description: MODULE_INFO[module].capabilities[c] ?? c })),
    })),
    // Only the accommodation calendar lets a `user` be limited to booking types.
    scopeTypes: module === 'accommodation' ? [...BOOKING_TYPES] : null,
  }));
}

// -------------------------------------------------------------------- reads
async function handleList(req: Request, admin: SuperAdmin): Promise<Response> {
  // The address is selected only so an unnamed person can be shown masked (labelFor); it is not sent.
  const [peopleRes, rolesRes] = await Promise.all([
    rest('/staff_users?select=id,name,email,active,is_super_admin&order=created_at.asc'),
    rest('/staff_module_roles?select=staff_id,module,role,scope'),
  ]);
  const people = (await peopleRes.json()) as PersonRow[];
  const roles = (await rolesRes.json()) as RoleRow[];

  // Second-factor readiness is shown for super admins only (they are the ones
  // it applies to); a handful of small queries, not one per visitor.
  const mfaById = new Map<string, { methodCount: number; ready: boolean; passkey: boolean }>();
  await Promise.all(
    people
      .filter((p) => p.is_super_admin && p.active)
      .map(async (p) => {
        const m = await mfaSummary(p.id);
        mfaById.set(p.id, { methodCount: m.methodCount, ready: m.ready, passkey: m.passkey });
      }),
  );

  let stepUpValid = false;
  try {
    stepUpValid = stepUpIsValid(req, admin.id);
  } catch (err) {
    if (!(err instanceof MfaNotConfiguredError)) throw err;
  }

  return jsonResponse({
    me: { id: admin.id, ready: mfaById.get(admin.id)?.ready ?? false, hasPasskey: mfaById.get(admin.id)?.passkey ?? false, stepUpValid },
    modules: moduleCatalog(),
    people: people.map((p) => ({
      id: p.id,
      label: labelFor(p),
      // Shown under the name so two people with the same name can be told apart.
      // Null while the name is missing, because the label is then the masked
      // address already. Masked here; the full address is never sent.
      maskedEmail: p.name && p.email ? maskEmail(p.email) : null,
      active: p.active,
      isSuperAdmin: p.is_super_admin,
      isMe: p.id === admin.id,
      mfa: mfaById.get(p.id) ?? null,
      roles: roles
        .filter((r) => r.staff_id === p.id && isModuleId(r.module))
        .map((r) => ({
          module: r.module,
          role: r.role,
          scope: r.scope,
          capabilities: capabilitiesForRole(r.module as ModuleId, r.role),
        })),
    })),
  });
}

async function handleActivity(url: URL): Promise<Response> {
  const limitParam = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;
  const beforeParam = url.searchParams.get('before');
  if (beforeParam !== null && !/^\d+$/.test(beforeParam)) return jsonResponse({ error: 'before must be a number' }, 400);

  const res = await rest(
    `/staff_audit_log?select=id,at,actor_id,action,module,target_id,detail&order=id.desc&limit=${limit}` +
      (beforeParam !== null ? `&id=lt.${beforeParam}` : ''),
  );
  const rows = (await res.json()) as {
    id: number;
    at: string;
    actor_id: string | null;
    action: string;
    module: string | null;
    target_id: string | null;
    detail: unknown;
  }[];

  // Turn ids into names for display. Ids come from our own table, but are
  // checked anyway before being placed in a query.
  const ids = [...new Set(rows.flatMap((r) => [r.actor_id, r.target_id]).filter((x): x is string => Boolean(x) && UUID.test(x as string)))];
  const labels = new Map<string, string>();
  const masked = new Map<string, string>();
  if (ids.length) {
    const peopleRes = await rest(`/staff_users?id=in.(${ids.join(',')})&select=id,name,email`);
    for (const p of (await peopleRes.json()) as { id: string; name: string | null; email: string | null }[]) {
      labels.set(p.id, labelFor(p));
      // Same rule as the people list: only alongside a name, masked here, never the full address.
      if (p.name && p.email) masked.set(p.id, maskEmail(p.email));
    }
  }
  const who = (id: string | null) =>
    id ? { id, label: labels.get(id) ?? `Person ${id.slice(0, 4).toUpperCase()}`, maskedEmail: masked.get(id) ?? null } : null;

  return jsonResponse({
    events: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, module: r.module, actor: who(r.actor_id), target: who(r.target_id), detail: r.detail })),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

// ------------------------------------------------------------------ changes
async function handleAddPerson(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ email?: string; name?: string }>(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400);
  const name = String(body.name ?? '').trim().slice(0, 100) || null;

  // Seen by super admins only. It names the person but never shows the address.
  const existing = await rest(`/staff_users?email=eq.${encodeURIComponent(email)}&select=id,name,email`);
  const found = ((await existing.json()) as { id: string; name: string | null; email: string | null }[])[0];
  if (found) return jsonResponse({ error: 'This person is already in the system.', code: 'EXISTS', personId: found.id, label: labelFor(found) }, 409);

  const created = await rest('/staff_users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ email, name, created_by: admin.id }),
  });
  const person = ((await created.json()) as PersonRow[])[0];

  // The new row is the target of its own log entry, so it has to exist first;
  // if the entry can't be written the row is taken straight back out.
  if (!(await audit(admin, 'staff.person_added', { targetId: person.id }))) {
    await rest(`/staff_users?id=eq.${person.id}`, { method: 'DELETE' });
    return jsonResponse({ error: 'Could not write the audit log; nobody was added.' }, 500);
  }
  return jsonResponse({ person: { id: person.id, label: labelFor(person), active: true, isSuperAdmin: false, roles: [] } }, 201);
}

function normalizeScope(module: ModuleId, role: Role, scope: unknown): { ok: true; scope: RoleScope } | { ok: false; error: string } {
  if (scope === undefined || scope === null) return { ok: true, scope: null };
  if (module !== 'accommodation' || role !== 'user') {
    return { ok: false, error: 'Booking-type limits only apply to a user in the accommodation calendar.' };
  }
  const types = (scope as { allowedTypes?: unknown }).allowedTypes;
  if (!Array.isArray(types) || types.length === 0) return { ok: false, error: 'Choose at least one booking type, or give no limit.' };
  const known = new Set<string>(BOOKING_TYPES);
  if (!types.every((t) => typeof t === 'string' && known.has(t))) return { ok: false, error: 'Unknown booking type.' };
  // Stored in the registry's order and without repeats.
  return { ok: true, scope: { allowedTypes: BOOKING_TYPES.filter((t) => types.includes(t)) } };
}

async function handleSetRole(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ personId?: string; module?: string; role?: string | null; scope?: unknown }>(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);
  if (!UUID.test(body.personId ?? '')) return jsonResponse({ error: 'personId must be a UUID' }, 400);
  if (!isModuleId(body.module)) return jsonResponse({ error: 'Unknown module.' }, 400);
  const module: ModuleId = body.module;
  const personId = body.personId as string;
  if (body.role !== null && !isRole(body.role)) return jsonResponse({ error: `role must be one of ${ROLES.join(', ')}, or null to remove it` }, 400);

  const person = await getPerson(personId);
  if (!person) return jsonResponse({ error: 'Person not found' }, 404);

  const existingRes = await rest(`/staff_module_roles?staff_id=eq.${personId}&module=eq.${module}&select=staff_id,module,role,scope`);
  const existing = ((await existingRes.json()) as RoleRow[])[0] ?? null;

  if (body.role === null) {
    if (!existing) return jsonResponse({ ok: true, changed: false });
    if (!(await audit(admin, 'staff.role_removed', { module, targetId: personId, detail: { previousRole: existing.role, previousScope: existing.scope } }))) {
      return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
    }
    await rest(`/staff_module_roles?staff_id=eq.${personId}&module=eq.${module}`, { method: 'DELETE' });
    return jsonResponse({ ok: true, changed: true });
  }

  const role: Role = body.role as Role;
  const scope = normalizeScope(module, role, body.scope);
  if (!scope.ok) return jsonResponse({ error: scope.error }, 400);

  if (existing && existing.role === role && JSON.stringify(existing.scope ?? null) === JSON.stringify(scope.scope)) {
    return jsonResponse({ ok: true, changed: false });
  }
  if (!(await audit(admin, 'staff.role_set', { module, targetId: personId, detail: { role, scope: scope.scope, previousRole: existing?.role ?? null, previousScope: existing?.scope ?? null } }))) {
    return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  }
  await rest('/staff_module_roles?on_conflict=staff_id,module', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ staff_id: personId, module, role, scope: scope.scope, granted_by: admin.id, granted_at: new Date().toISOString() }),
  });
  return jsonResponse({ ok: true, changed: true });
}

async function handleSetActive(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ personId?: string; active?: unknown }>(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);
  if (!UUID.test(body.personId ?? '')) return jsonResponse({ error: 'personId must be a UUID' }, 400);
  if (typeof body.active !== 'boolean') return jsonResponse({ error: 'active must be true or false' }, 400);
  const personId = body.personId as string;

  if (personId === admin.id) return jsonResponse({ error: 'You can\'t deactivate yourself.' }, 400);
  const person = await getPerson(personId);
  if (!person) return jsonResponse({ error: 'Person not found' }, 404);
  // Super admins are never changed here, which also means the last one can't
  // be removed through this screen.
  if (person.is_super_admin) return jsonResponse({ error: 'Super admins are managed directly in the database, not here.' }, 400);
  if (person.active === body.active) return jsonResponse({ ok: true, changed: false });

  if (!(await audit(admin, body.active ? 'staff.person_reactivated' : 'staff.person_deactivated', { targetId: personId }))) {
    return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  }
  await rest(`/staff_users?id=eq.${personId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active: body.active }) });
  return jsonResponse({ ok: true, changed: true });
}

// ------------------------------------------------------------------- router
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  const isRead = (p === '/api/staff-admin/people' && m === 'GET') || (p === '/api/staff-admin/activity' && m === 'GET');
  const isWrite =
    (p === '/api/staff-admin/people' && m === 'POST') || (p === '/api/staff-admin/roles' && m === 'POST') || (p === '/api/staff-admin/people/active' && m === 'POST');
  if (!isRead && !isWrite) return jsonResponse({ error: 'Not found' }, 404);

  try {
    if (isRead) {
      const auth = await requireSuperAdmin(req);
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
      return p === '/api/staff-admin/people' ? await handleList(req, auth.admin) : await handleActivity(url);
    }

    const auth = await requireAccessAdmin(req);
    if (!auth.ok) return jsonResponse({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    if (p === '/api/staff-admin/people') return await handleAddPerson(req, auth.admin);
    if (p === '/api/staff-admin/roles') return await handleSetRole(req, auth.admin);
    return await handleSetActive(req, auth.admin);
  } catch (err) {
    if (err instanceof MfaNotConfiguredError) {
      console.error('Second factors are not configured:', err.message);
      return jsonResponse({ error: 'Second-factor storage is not configured yet (STAFF_MFA_KEY).', code: 'MFA_NOT_CONFIGURED' }, 500);
    }
    console.error('staff-admin request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = {
  path: ['/api/staff-admin/people', '/api/staff-admin/people/active', '/api/staff-admin/roles', '/api/staff-admin/activity'],
};
