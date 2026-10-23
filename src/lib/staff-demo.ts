// Dev-only demo sign-in for the admin pages: `netlify dev` (or `astro dev`), then open
// /internal/?demo (a super admin with every tool) or /internal/?demo=limited (an admin with two
// tools, no Access or Security). Called from scripts/lib/staff-client.mjs behind
// `import.meta.env.DEV`, so a production build drops this file.
//
// Why it exists: the real sign-in needs a Google account on the allow-list and /api/staff-me needs
// the Supabase service-role key, neither of which a local run has, so without this the shell, the
// menu and the landing page can't be seen locally. It fakes the token and answers /api/staff-me
// only; every other /api call falls through to the real fetch, so a tool page still shows its own
// state (or its own `?demo`, as event-payments does).

const TOOLS = [
  { module: 'photo-pool', label: 'Photo pool', path: '/internal/photo-pool/' },
  { module: 'whatsapp', label: 'WhatsApp inbox', path: '/internal/whatsapp/' },
  { module: 'event-payments', label: 'Event payments', path: '/internal/event-payments/' },
  { module: 'accommodation', label: 'Accommodation calendar', path: '/internal/accommodation-calendar/' },
  { module: 'members', label: 'Member register', path: '/internal/members/' },
  { module: 'usage', label: 'Usage & limits', path: '/internal/usage/' },
];

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', user: 'User', read_only: 'Read-only' };

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function demoMe(kind: string) {
  const limited = kind === 'limited';
  const roles: Record<string, string> = limited
    ? { usage: 'read_only', whatsapp: 'user' }
    : { 'photo-pool': 'admin', whatsapp: 'admin', 'event-payments': 'admin', accommodation: 'user', members: 'admin', usage: 'read_only' };
  return {
    name: limited ? 'Demo Reader' : 'Demo Admin',
    maskedEmail: 'd••••@tvc.farm',
    isSuperAdmin: !limited,
    tools: TOOLS.filter((t) => roles[t.module]).map((t) => ({ ...t, role: roles[t.module], roleLabel: ROLE_LABELS[roles[t.module]] })),
    adminTools: limited
      ? []
      : [
          { label: 'Access', path: '/internal/access/', description: 'Who can do what' },
          { label: 'Security', path: '/internal/security/', description: 'Your second factors' },
        ],
  };
}

export function installStaffDemo(tokenKey: string, kind: string): void {
  // A token that only decodeTokenEmail() reads; the server never sees it because /api/staff-me is faked.
  const token = `${b64url({ alg: 'none' })}.${b64url({ email: 'demo@tvc.farm' })}.demo`;
  try {
    sessionStorage.setItem(tokenKey, token);
    sessionStorage.removeItem('tvc-staff-me'); // the menu's cached answer, so the demo kind always applies
  } catch {
    return; // storage blocked: no demo
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, location.href).pathname === '/api/staff-me') {
      return Promise.resolve(new Response(JSON.stringify(demoMe(kind)), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  window.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('p');
    note.textContent = kind === 'limited' ? 'Demo mode: a fake admin with two tools.' : 'Demo mode: a fake super admin. Nothing here reaches the real data.';
    note.setAttribute('style', 'position:fixed;bottom:12px;right:12px;z-index:9999;margin:0;padding:6px 12px;border-radius:8px;font:600 0.8rem sans-serif;background:#fff;border:1px solid currentColor');
    document.body.append(note);
  });
}
