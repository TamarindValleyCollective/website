// Netlify Function (v2 API) behind the /internal landing page (issue #89):
// "who am I, and which internal tools can I open?". Any signed-in, active
// staff member may ask; it answers only about the caller, and only with what
// the landing page needs — a display name and the tools they hold a role in.
// A tool is listed because the caller has a role in its module; the tool's own
// page and API still check the capability they need on every request, so this
// list is a convenience and grants nothing.
//
// Super admins additionally get the Access and Security pages. No email is
// returned: the caller is shown by name, or by nothing at all if there isn't
// one yet.
import { requireActivePerson } from './lib/staff-access';
import { rest } from './lib/staff-mfa-store';
import { MODULE_INFO, isModuleId, isRole } from './lib/staff-registry';

const ROLE_LABELS = { admin: 'Admin', user: 'User', read_only: 'Read-only' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname !== '/api/staff-me' || req.method !== 'GET') return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireActivePerson(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const person = auth.person;

  try {
    const res = await rest(`/staff_module_roles?staff_id=eq.${person.id}&select=module,role`);
    const roles = (await res.json()) as { module: string; role: string }[];
    return jsonResponse({
      name: person.name ?? person.googleName ?? null,
      isSuperAdmin: person.isSuperAdmin,
      tools: roles
        .filter((r) => isModuleId(r.module) && isRole(r.role))
        .map((r) => ({
          module: r.module,
          label: MODULE_INFO[r.module as keyof typeof MODULE_INFO].label,
          path: MODULE_INFO[r.module as keyof typeof MODULE_INFO].path,
          role: r.role,
          roleLabel: ROLE_LABELS[r.role as keyof typeof ROLE_LABELS],
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      adminTools: person.isSuperAdmin
        ? [
            { label: 'Access', path: '/internal/access/', description: 'Who can do what' },
            { label: 'Security', path: '/internal/security/', description: 'Your second factors' },
          ]
        : [],
    });
  } catch (err) {
    console.error('staff-me request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = { path: ['/api/staff-me'] };
