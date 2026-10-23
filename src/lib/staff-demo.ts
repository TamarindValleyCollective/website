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

// A stand-in for a Google picture: a coloured disc with a letter, as an inline image (no network).
const face = (letter: string, colour: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${colour}"/><text x="48" y="64" font-family="sans-serif" font-size="48" font-weight="600" text-anchor="middle" fill="#fff">${letter}</text></svg>`)}`;

// The Access page's People tab: a spread of people so the search and filters have something to do.
const ALL_TOOLS = ['photo-pool', 'whatsapp', 'event-payments', 'accommodation', 'members', 'usage'];
const CAPABILITIES: Record<string, string[]> = { read_only: ['view'], user: ['view', 'edit'], admin: ['view', 'edit', 'manage'] };

function demoAccess() {
  const grant = (...pairs: [string, string][]) => pairs.map(([module, role]) => ({ module, role, scope: null }));
  const person = (id: string, label: string, extra: Record<string, unknown>) => ({ id, label, maskedEmail: `${label[0].toLowerCase()}••••@tvc.farm`, picture: null, active: true, isSuperAdmin: false, isMe: false, mfa: null, roles: [], ...extra });
  return {
    me: { id: 'demo-1', ready: true, hasPasskey: true, stepUpValid: false },
    modules: ALL_TOOLS.map((id) => ({
      id,
      label: TOOLS.find((t) => t.module === id)?.label ?? id,
      roles: Object.entries(CAPABILITIES).map(([role, caps]) => ({ role, capabilities: caps.map((c) => ({ id: c, description: `Can ${c} in this tool` })) })),
      scopeTypes: null,
    })),
    people: [
      person('demo-1', 'Demo Admin', { isMe: true, isSuperAdmin: true, picture: face('D', '#4f7a5a'), mfa: { methodCount: 2, ready: true }, roles: grant(...ALL_TOOLS.map((t): [string, string] => [t, 'admin'])) }),
      person('demo-2', 'Priya Raman', { isSuperAdmin: true, picture: face('P', '#b5651d'), mfa: { methodCount: 2, ready: true }, roles: grant(['members', 'admin'], ['usage', 'admin']) }),
      person('demo-3', 'Rajesh Thiagarajan', { isSuperAdmin: true, picture: face('R', '#3b6ea5'), mfa: { methodCount: 1, ready: false }, roles: [] }),
      person('demo-4', 'Madhavan K', { picture: face('M', '#7a4f7a'), roles: grant(['accommodation', 'user'], ['members', 'admin'], ['event-payments', 'read_only']) }),
      person('demo-5', 'Ananya Iyer', { roles: grant(['whatsapp', 'user'], ['usage', 'read_only']) }),
      person('demo-6', 'Sanket Patil', { picture: face('S', '#a5503b'), roles: grant(['photo-pool', 'admin']) }),
      person('demo-7', 'Linger front desk', { roles: grant(['accommodation', 'user']) }),
      person('demo-8', 'Karthik S', {}),
      person('demo-9', 'Divya Menon', { active: false, roles: grant(['whatsapp', 'read_only']) }),
    ],
  };
}

function demoMe(kind: string) {
  const limited = kind === 'limited';
  const roles: Record<string, string> = limited
    ? { usage: 'read_only', whatsapp: 'user' }
    : { 'photo-pool': 'admin', whatsapp: 'admin', 'event-payments': 'admin', accommodation: 'user', members: 'admin', usage: 'read_only' };
  return {
    name: limited ? 'Demo Reader' : 'Demo Admin',
    maskedEmail: 'd••••@tvc.farm',
    picture: limited ? null : face('D', '#4f7a5a'), // the limited one shows the initial, so both looks can be seen
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
    const path = new URL(url, location.href).pathname;
    const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (path === '/api/staff-me') return reply(demoMe(kind));
    if (path === '/api/staff-admin/people' && (init?.method ?? 'GET') === 'GET') return reply(demoAccess());
    if (path === '/api/staff-admin/activity') return reply({ events: [], nextBefore: null });
    return realFetch(input, init);
  };

  window.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('p');
    const text = document.createElement('span');
    text.textContent = kind === 'limited' ? 'Demo mode: a fake admin with two tools.' : 'Demo mode: a fake super admin. Nothing here reaches the real data.';
    // Switches the admin between the warm TVC look and the neutral one (tokens in StaffLayout.astro).
    const look = document.createElement('button');
    look.type = 'button';
    const paint = () => (look.textContent = `Look: ${document.documentElement.dataset.look === 'neutral' ? 'neutral' : 'warm'}`);
    look.addEventListener('click', () => {
      const next = document.documentElement.dataset.look === 'neutral' ? 'warm' : 'neutral';
      if (next === 'neutral') document.documentElement.dataset.look = 'neutral';
      else delete document.documentElement.dataset.look;
      try {
        sessionStorage.setItem('tvc-staff-look', next);
      } catch {
        // not remembered
      }
      paint();
    });
    look.setAttribute('style', 'margin-left:10px;padding:2px 8px;border:1px solid currentColor;border-radius:6px;background:none;font:inherit;cursor:pointer');
    paint();
    note.append(text, look);
    note.setAttribute('style', 'position:fixed;bottom:12px;right:12px;z-index:9999;margin:0;padding:6px 12px;border-radius:8px;font:600 0.8rem sans-serif;background:var(--tvc-white);color:var(--tvc-ink);border:1px solid currentColor');
    document.body.append(note);
  });
}
