// Netlify Function (v2 API) behind the Today screen (the admin Home page): "is anything waiting on me?".
// Any signed-in, active admin may ask; it answers only about the tools they hold a role in, and only with counts
// and timings, never names or contact details, so a read-only role learns nothing the Today screen should not show.
// Each tool is checked on its own: if one check fails the others still answer, and the failed tool is named so
// the page can say "couldn't check WhatsApp" instead of "all clear".
//
// What it counts (all read-only):
//   WhatsApp         conversations still waiting for a reply (the same rule as the inbox's "Needs reply" filter)
//   Event payments   guest cancellation requests nobody has decided yet (live bookings only)
//   Member register  unit stories waiting for review, and family-member requests waiting for a decision
//   Usage & limits   services with a warning or critical alert (usage_alert_state, kept by the hourly check)
//   Security         super admins who do not yet have two different second factors (super admins only)
import { requireActivePerson } from './lib/staff-access';
import { mfaSummary, rest } from './lib/staff-mfa-store';
import { needsReply } from './lib/whatsapp-guest';
import { isModuleId } from './lib/staff-registry';
import { listConversations, listRecentMessagesByConversation } from '../../scripts/lib/supabase.mjs';

type Item = { id: string; tool: string; tone: 'crit' | 'warn'; title: string; detail: string; count: number; href: string };
type Check = { item?: Item; quiet?: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "2 hours", "3 days": how long something has waited, in one rounded unit.
function waited(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return plural(minutes, 'minute', 'minutes');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, 'hour', 'hours');
  return plural(Math.round(hours / 24), 'day', 'days');
}

async function count(path: string): Promise<number> {
  const res = await rest(path);
  return ((await res.json()) as unknown[]).length;
}

async function checkWhatsApp(): Promise<Check> {
  const conversations = (await listConversations({ limit: 100 })) as any[];
  const recent = (await listRecentMessagesByConversation(conversations.map((c) => c.id))) as Map<string, { direction: 'inbound' | 'outbound'; body: string }[]>;
  const waiting = conversations.filter((c) => recent.has(c.id) && needsReply(recent.get(c.id)!, c.is_blocked ?? false));
  if (waiting.length === 0) return { quiet: 'No WhatsApp conversations are waiting for a reply.' };
  const oldest = Math.min(...waiting.map((c) => new Date(c.last_message_at).getTime()));
  const ms = Date.now() - oldest;
  // WhatsApp only lets us reply within 24 hours of the customer's last message, so a long wait is urgent.
  return { item: { id: 'whatsapp', tool: 'WhatsApp', tone: ms > 20 * 3_600_000 ? 'crit' : 'warn', title: `${plural(waiting.length, 'conversation needs', 'conversations need')} a reply`, detail: `WhatsApp · the oldest has waited ${waited(ms)}`, count: waiting.length, href: '/internal/whatsapp/' } };
}

async function checkEventPayments(): Promise<Check> {
  const res = await rest('/event_payments?select=mode,cancellation_requested_at,cancellation_declined_at,refunded_at&cancellation_requested_at=not.is.null&cancellation_declined_at=is.null&refunded_at=is.null');
  const rows = ((await res.json()) as { mode: string | null }[]).filter((r) => r.mode !== 'test');
  if (rows.length === 0) return { quiet: 'No cancellation requests are waiting on a decision.' };
  return { item: { id: 'event-payments', tool: 'Payments', tone: 'warn', title: `${plural(rows.length, 'cancellation request', 'cancellation requests')} to decide`, detail: 'Payments · a guest has asked for a refund', count: rows.length, href: '/internal/event-payments/' } };
}

async function checkMembers(): Promise<Check> {
  const [stories, family] = await Promise.all([count('/member_unit_stories?select=household_id&status=eq.in_review'), count('/member_family_requests?select=id&status=eq.pending')]);
  const parts = [stories ? plural(stories, 'unit story', 'unit stories') + ' to review' : null, family ? plural(family, 'family request', 'family requests') + ' to decide' : null].filter(Boolean) as string[];
  if (parts.length === 0) return { quiet: 'Nothing is waiting on you in the member register.' };
  return { item: { id: 'members', tool: 'Members', tone: 'warn', title: parts[0], detail: `Members${parts.length > 1 ? ` · also ${parts[1]}` : ''}`, count: stories || family, href: '/internal/members/' } }; // the badge counts what the title names (the family requests are in the detail)
}

async function checkUsage(): Promise<Check> {
  const res = await rest('/usage_alert_state?select=alert_key,level');
  const rows = (await res.json()) as { alert_key: string; level: 'warn' | 'critical' }[];
  if (rows.length === 0) return { quiet: 'Every service is within its free tier and credits.' };
  const services = new Set(rows.map((r) => r.alert_key.split('.')[0]));
  const critical = rows.some((r) => r.level === 'critical');
  return { item: { id: 'usage', tool: 'Usage', tone: critical ? 'crit' : 'warn', title: `${plural(services.size, 'service is', 'services are')} ${critical ? 'at a limit' : 'nearing a limit'}`, detail: 'Usage · open it for what to do', count: services.size, href: '/internal/usage/' } };
}

async function checkSecurity(): Promise<Check> {
  const res = await rest('/staff_users?select=id,name&is_super_admin=is.true&active=is.true');
  const admins = (await res.json()) as { id: string; name: string | null }[];
  const behind: string[] = [];
  for (const a of admins) if (!(await mfaSummary(a.id)).ready) behind.push(a.name ?? 'A super admin');
  if (behind.length === 0) return { quiet: 'Every super admin has two second factors set up.' };
  return { item: { id: 'security', tool: 'Security', tone: 'warn', title: `${plural(behind.length, 'super admin has', 'super admins have')} not set up two second factors`, detail: `Security · ${behind.slice(0, 2).join(', ')}${behind.length > 2 ? ` and ${behind.length - 2} more` : ''} cannot change access yet`, count: behind.length, href: '/internal/security/' } };
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname !== '/api/staff-today' || req.method !== 'GET') return jsonResponse({ error: 'Not found' }, 404);
  const auth = await requireActivePerson(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const person = auth.person;

  let modules = new Set<string>();
  try {
    const res = await rest(`/staff_module_roles?staff_id=eq.${person.id}&select=module`);
    modules = new Set(((await res.json()) as { module: string }[]).map((r) => r.module).filter(isModuleId));
  } catch (err) {
    console.error('staff-today could not read the roles', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const checks: [string, () => Promise<Check>][] = [];
  if (modules.has('whatsapp')) checks.push(['WhatsApp', checkWhatsApp]);
  if (modules.has('event-payments')) checks.push(['Payments', checkEventPayments]);
  if (modules.has('members')) checks.push(['Members', checkMembers]);
  if (modules.has('usage')) checks.push(['Usage', checkUsage]);
  if (person.isSuperAdmin) checks.push(['Security', checkSecurity]);

  const items: Item[] = [];
  const quiet: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    checks.map(async ([name, check]) => {
      try {
        const result = await check();
        if (result.item) items.push(result.item);
        else if (result.quiet) quiet.push(result.quiet);
      } catch (err) {
        console.error(`staff-today: could not check ${name}`, err);
        failed.push(name);
      }
    }),
  );
  items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'crit' ? -1 : 1));
  return jsonResponse({ generatedAt: new Date().toISOString(), items, quiet, failed });
};

export const config = { path: ['/api/staff-today'] };
