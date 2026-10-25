// Tells TVC's core team and Linger that a member is offering a unit. The event is recorded first in `partner_events`
// (migration 0068) with everything a partner would need, then delivered by email; each delivery records its outcome.
// When Linger has an API integration, a push is one more delivery channel on the same event: nothing here has to be
// re-derived. Best-effort: a failed email never undoes the offer, which the admin team also sees on the Units screen.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';
import { sendEmail } from './booking-notify';
import { detailRow, detailTable, escapeHtml, renderStaffEmail } from './email-layout';

const CORE_TEAM = ['core-team@tvc.farm'];
// Linger's stay address is the one the stay notices already use; LINGER_OFFER_NOTICE_TO overrides it (comma separated).
const lingerRecipients = () => (process.env.LINGER_OFFER_NOTICE_TO ?? 'stay@linger.in').split(',').map((s) => s.trim()).filter(Boolean);

export interface PartnerEventInput {
  type: string;
  subject: string;
  payload: Record<string, unknown>;
}

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return `${url}/rest/v1`;
}

// Records the event; returns its id, or null if it could not be stored (the notice is still sent).
export async function recordPartnerEvent(partnerId: string, event: PartnerEventInput): Promise<string | null> {
  try {
    const res = await fetch(`${base()}/partner_events`, { method: 'POST', headers: restHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ partner_id: partnerId, type: event.type, subject: event.subject, payload: event.payload }) });
    if (!res.ok) return null;
    return ((await res.json()) as { id: string }[])[0]?.id ?? null;
  } catch (err) {
    console.error('[linger-notify] could not record the event', err);
    return null;
  }
}

async function recordDelivery(eventId: string | null, channel: string, status: 'sent' | 'failed'): Promise<void> {
  if (!eventId) return;
  try {
    const got = await fetch(`${base()}/partner_events?id=eq.${eventId}&select=delivery`, { headers: restHeaders() });
    const current = got.ok ? (((await got.json()) as { delivery: Record<string, unknown> }[])[0]?.delivery ?? {}) : {};
    await fetch(`${base()}/partner_events?id=eq.${eventId}`, { method: 'PATCH', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ delivery: { ...current, [channel]: { status, at: new Date().toISOString() } } }) });
  } catch (err) {
    console.error('[linger-notify] could not record the delivery', err);
  }
}

// Emails the core team and Linger. `status.linger` says whether Linger's copy went, so the portal can say so honestly.
export async function sendOfferNotice(notice: { subject: string; rows: [string, string][] }, eventId: string | null): Promise<{ core: boolean; linger: boolean }> {
  const rows = notice.rows.map(([k, v], i) => detailRow(escapeHtml(k), escapeHtml(v), { last: i === notice.rows.length - 1 })).join('');
  const html = renderStaffEmail(`<p style="margin-top:0;">${escapeHtml(notice.subject)}</p>${detailTable(rows)}`);
  const linger = lingerRecipients();
  const [core, partner] = await Promise.all([
    sendEmail({ to: CORE_TEAM, subject: notice.subject, html }).catch(() => false),
    linger.length ? sendEmail({ to: linger, subject: notice.subject, html, replyTo: 'core-team@tvc.farm' }).catch(() => false) : Promise.resolve(false),
  ]);
  await recordDelivery(eventId, 'email', partner ? 'sent' : 'failed');
  return { core, linger: partner };
}
