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

function makeAccess() {
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

// One set of people for the whole session, so a role change or a deactivation in the demo sticks until reload.
let accessState: ReturnType<typeof makeAccess> | null = null;
const demoAccess = () => (accessState ??= makeAccess());

// The writes the Access page makes. They change the demo set only; nothing leaves the page.
function demoWrite(path: string, body: any): { status: number; data: unknown } | null {
  if (path === '/api/staff-mfa/verify') return { status: 200, data: { stepUpToken: 'demo-step-up', expiresInSeconds: 600 } };
  const person = demoAccess().people.find((x) => x.id === body?.personId);
  if (path === '/api/staff-admin/people/active' && person) {
    person.active = body.active === true;
    return { status: 200, data: { ok: true } };
  }
  if (path === '/api/staff-admin/roles' && person) {
    const roles = person.roles as { module: string; role: string; scope: null }[];
    const i = roles.findIndex((r) => r.module === body.module);
    if (i >= 0) roles.splice(i, 1);
    if (body.role) roles.push({ module: body.module, role: body.role, scope: null });
    return { status: 200, data: { ok: true } };
  }
  return null;
}

// The Usage page's overview: four cards with typed-in or measured figures, enough to try "Enter a new reading".
let usageState: any = null;
function demoUsage() {
  if (usageState) return usageState;
  const ago = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const series = (base: number) => Array.from({ length: 14 }, (_, i) => ({ day: day(13 - i), value: Math.round(base + Math.sin(i) * base * 0.4 + i) }));
  const meter = (id: string, label: string, where: string, valueLabel: string, limitLabel: string) => ({ id, label, where, valueLabel, limitLabel, refreshEveryDays: 30 });
  const manual = (id: string, label: string, where: string, unit: string, value: number, limit: number | null, level: string | null) => ({
    ...meter(id, label, where, 'Amount left', 'Amount included'),
    kind: 'remaining',
    unit,
    level,
    reading: { value, limit, capturedAt: ago(30) },
  });
  usageState = {
    canConfigure: true,
    generatedAt: new Date().toISOString(),
    schedule: { nextCollectorRunAt: new Date(Date.now() + 3 * 3600000).toISOString(), collectorEveryHours: 6 },
    // add `&clear` to the address to see the page with nothing wrong
    alerts: location.search.includes('clear') ? [] : [
      {
        service: 'netlify',
        level: 'warn',
        title: 'Netlify credits are being used faster than the month is passing',
        action: 'Hold non-essential deploys, or top up credits before the cycle ends.',
        detail: '820 of 1,000 credits are left with 19 days to the reset, about 43 a day to last. Production deploys cost 15 credits each.',
        emailedAt: ago(5),
      },
    ],
    settings: { anthropicPrices: { input: 3, output: 15 }, geminiDailyRequests: 1500 },
    anthropic: {
      billingErrorsRecent: 0,
      chatCapHitsToday: 0,
      searchFallbackCapHitsToday: 0,
      credit: {
        meter: meter('anthropic.credit_remaining_usd', 'Anthropic credit', 'console.anthropic.com, under Billing', 'Credit left (USD)', 'Credit loaded in total (USD)'),
        reading: { value: 42.5, total: 50, capturedAt: ago(70), expiresOn: day(-160) },
        estimate: { remaining: 38.2, total: 50, level: null, spent: 4.3 },
        expiresInDays: 160,
      },
      today: { requests: 42, input_tokens: 61000, output_tokens: 9000, costUsd: 0.31 },
      last7: { requests: 310, input_tokens: 420000, output_tokens: 66000, costUsd: 2.25 },
      month: { requests: 980, input_tokens: 1300000, output_tokens: 210000, costUsd: 7.05 },
      requestsSeries: series(40),
    },
    gemini: {
      dailyLimit: 1500,
      today: { requests: 220, quotaExhausted: 0 },
      last7: { requests: 1500, quotaExhausted: 0, fallbacksToAnthropic: 4 },
      requestsSeries: series(210),
    },
    typesafe: {
      creditEstimate: null,
      today: { requests: 160, errors: 2 },
      last7: { requests: 1100, costUsd: 0.04, errors: 6 },
      month: { requests: 3400, inputTokens: 2100000, costUsd: 0.12 },
      requestsSeries: series(150),
    },
    supabase: {
      reading: { bytes: 118 * 1024 * 1024, limitBytes: 500 * 1024 * 1024, capturedAt: ago(3) },
      growth: { spanDays: 14, bytesPerDay: 1.2 * 1024 * 1024, daysToFull: 320 },
      history: Array.from({ length: 12 }, (_, i) => ({ at: ago((11 - i) * 24), bytes: (100 + i * 1.6) * 1024 * 1024 })),
      tables: { list: [{ name: 'whatsapp_messages', bytes: 31 * 1024 * 1024, rows: 41000 }, { name: 'event_payments', bytes: 6 * 1024 * 1024, rows: 2100 }, { name: 'member_people', bytes: 2 * 1024 * 1024, rows: 97 }] },
      connections: { max: 60, inUse: 9, level: null },
    },
    resend: { fresh: null },
    r2: { fresh: null },
    netlify: { deploys: null },
    manual: [
      manual('typesafe.credit_remaining_usd', 'TypeSafe credit', 'typesafe.ai dashboard', 'USD', 0, null, null),
      manual('supabase.egress_gb', 'Supabase egress', 'Supabase dashboard, under Usage', 'GB', 1.2, 5, null),
      manual('netlify.credits_remaining', 'Netlify credits', 'Netlify dashboard, under Usage', 'credits', 820, 1000, 'warn'),
    ],
  };
  // an empty typed-in credit reads as "nothing entered yet": drop the reading so the card shows its empty state
  usageState.manual[0].reading = null;
  return usageState;
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
    if (path === '/api/staff-mfa/status') {
      const day = 86400000;
      return reply({
        methods: { totp: true, recovery: true, recoveryCodesRemaining: 8, passkey: true },
        passkeys: [
          { id: 'k1', label: 'MacBook Touch ID', createdAt: new Date(Date.now() - 20 * day).toISOString(), lastUsedAt: new Date(Date.now() - 2 * day).toISOString() },
          { id: 'k2', label: 'iPhone', createdAt: new Date(Date.now() - 5 * day).toISOString(), lastUsedAt: null },
        ],
        pendingTotp: false,
        methodCount: 2,
        ready: true,
        stepUpValid: false,
        lockedUntil: null,
        admins: [
          { id: 'demo-2', label: 'Priya Raman', ready: true, methodCount: 2 },
          { id: 'demo-3', label: 'Rajesh Thiagarajan', ready: false, methodCount: 1 },
        ],
      });
    }
    if (path === '/api/staff-today') {
      if (location.search.includes('clear')) return reply({ items: [], quiet: ['No WhatsApp conversations are waiting for a reply.', 'No cancellation requests are waiting on a decision.', 'Every service is within its free tier and credits.'], failed: [] });
      return reply({
        items: [
          { id: 'whatsapp', tool: 'WhatsApp inbox', tone: 'warn', title: '3 conversations need a reply', detail: 'WhatsApp inbox · the oldest has waited 2 hours', count: 3, href: '/internal/whatsapp/' },
          { id: 'event-payments', tool: 'Event payments', tone: 'warn', title: '1 cancellation request to decide', detail: 'Event payments · a guest has asked for a refund', count: 1, href: '/internal/event-payments/' },
          { id: 'members', tool: 'Member register', tone: 'warn', title: '2 unit stories to review', detail: 'Member register · also 1 family request to decide', count: 3, href: '/internal/members/' },
          { id: 'usage', tool: 'Usage & limits', tone: 'warn', title: '1 service is nearing a limit', detail: 'Usage & limits · open it for what to do', count: 1, href: '/internal/usage/' },
          { id: 'security', tool: 'Security', tone: 'warn', title: '1 super admin has not set up two second factors', detail: 'Security · Rajesh Thiagarajan cannot change access yet', count: 1, href: '/internal/security/' },
        ],
        quiet: [],
        failed: [],
      });
    }
    if (path === '/api/usage-admin/overview') return reply(demoUsage());
    if (path === '/api/usage-admin/domains') return reply({ domains: [] });
    if (path === '/api/usage-admin/whatsapp-health') return reply({ events: [] });
    if (path === '/api/usage-admin/reading' && (init?.method ?? 'GET') === 'POST') {
      try {
        const body = JSON.parse(String(init?.body ?? 'null'));
        const u = demoUsage();
        const now = new Date().toISOString();
        if (body.meter === 'anthropic.credit_remaining_usd') {
          u.anthropic.credit.reading = { value: body.value, total: body.limit, capturedAt: now, expiresOn: body.expiresOn ?? null };
          u.anthropic.credit.estimate = { remaining: body.value, total: body.limit, level: null, spent: 0 };
        } else {
          const m = u.manual.find((x: any) => x.id === body.meter);
          if (m) m.reading = { value: body.value, limit: body.limit, capturedAt: now };
        }
      } catch {
        // not JSON: ignore
      }
      return reply({ ok: true });
    }
    if ((init?.method ?? 'GET') === 'POST') {
      let body: unknown = null;
      try {
        body = JSON.parse(String(init?.body ?? 'null'));
      } catch {
        // not JSON: not ours
      }
      const done = demoWrite(path, body);
      if (done) return Promise.resolve(new Response(JSON.stringify(done.data), { status: done.status, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  window.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('p');
    const text = document.createElement('span');
    text.textContent = kind === 'limited' ? 'Demo mode: a fake admin with two tools.' : 'Demo mode: a fake super admin. Nothing here reaches the real data.';
    note.append(text);
    note.setAttribute('style', 'position:fixed;bottom:12px;right:12px;z-index:9999;margin:0;padding:6px 12px;border-radius:8px;font:600 0.8rem sans-serif;background:var(--tvc-white);color:var(--tvc-ink);border:1px solid currentColor');
    document.body.append(note);
  });
}
