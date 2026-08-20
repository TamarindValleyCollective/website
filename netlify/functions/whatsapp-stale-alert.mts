// Netlify scheduled function (every 15 minutes) — the "make sure it
// actually gets answered" safety net for /internal/whatsapp. Replaces the
// old per-message email (removed 2026-08-20 from whatsapp-webhook.mts —
// too noisy for a shared inbox several staff check) with a digest of every
// conversation that's been unread for 60+ minutes. Re-sent hourly for as
// long as a conversation stays unread, not just once — a single alert that
// gets missed shouldn't mean a message silently goes unanswered. See
// WHATSAPP.md.
import { listStaleUnreadConversations, markStaleAlertSent } from '../../scripts/lib/supabase.mjs';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'TVC Website <noreply@tvc.farm>';
const NOTIFY_TO = ['core-team@tvc.farm'];
const STALE_MINUTES = 60;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatWaitTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export default async (): Promise<Response> => {
  let stale: any[];
  try {
    stale = await listStaleUnreadConversations({ staleMinutes: STALE_MINUTES });
  } catch (err) {
    console.error('[whatsapp-stale-alert] Failed to query stale conversations', err);
    return new Response('Failed to query stale conversations', { status: 500 });
  }

  if (stale.length === 0) {
    return new Response(JSON.stringify({ ok: true, alerted: 0 }), { status: 200 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[whatsapp-stale-alert] RESEND_API_KEY is not set — cannot send digest');
    return new Response('Server misconfigured', { status: 500 });
  }

  const now = Date.now();
  const rows = stale
    .map((c) => {
      const lastMessage = c.whatsapp_messages?.[0];
      const waitMinutes = Math.floor((now - new Date(c.last_message_at).getTime()) / 60000);
      const name = c.display_name || `+${c.wa_phone}`;
      const preview = lastMessage?.body ? lastMessage.body.slice(0, 120) : '';
      return `<tr>
        <td style="padding:8px 12px; border-bottom:1px solid #e2ddc9;"><strong>${escapeHtml(name)}</strong><br><span style="color:#57604f; font-size:13px;">+${escapeHtml(c.wa_phone)}</span></td>
        <td style="padding:8px 12px; border-bottom:1px solid #e2ddc9; color:#57604f; font-size:13px;">${escapeHtml(preview)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #e2ddc9; white-space:nowrap;">${formatWaitTime(waitMinutes)}</td>
      </tr>`;
    })
    .join('');

  const subject = stale.length === 1 ? '1 WhatsApp message waiting for a reply' : `${stale.length} WhatsApp messages waiting for a reply`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>${stale.length === 1 ? 'This message has' : 'These messages have'} been unread for over an hour on <a href="https://tvc.farm/internal/whatsapp">+91 80 4110 9754</a>:</p>
  <table style="border-collapse:collapse; width:100%; max-width:560px;">
    <thead>
      <tr style="text-align:left; font-size:13px; color:#57604f;">
        <th style="padding:8px 12px; border-bottom:2px solid #294a36;">From</th>
        <th style="padding:8px 12px; border-bottom:2px solid #294a36;">Last message</th>
        <th style="padding:8px 12px; border-bottom:2px solid #294a36;">Waiting</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:13px; color:#57604f;">You'll get this again in an hour for anything still unread — sign in at <a href="https://tvc.farm/internal/whatsapp">tvc.farm/internal/whatsapp</a> to reply.</p>
</body>
</html>`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: NOTIFY_TO, subject, html }),
    });
    if (!res.ok) {
      console.error('[whatsapp-stale-alert] Resend send failed:', res.status, await res.text());
      return new Response('Failed to send digest', { status: 502 });
    }
  } catch (err) {
    console.error('[whatsapp-stale-alert] Failed to reach Resend', err);
    return new Response('Failed to reach Resend', { status: 502 });
  }

  try {
    await markStaleAlertSent(stale.map((c) => c.id));
  } catch (err) {
    // The email already went out — a failure here just means we might
    // re-alert about the same conversations sooner than the usual hourly
    // cadence on the next tick, not a duplicate this run.
    console.error('[whatsapp-stale-alert] Failed to mark conversations alerted', err);
  }

  return new Response(JSON.stringify({ ok: true, alerted: stale.length }), { status: 200 });
};

export const config = {
  schedule: '*/15 * * * *',
};
