// Netlify scheduled function (hourly, no HTTP path) — turns the usage rules
// (scripts/lib/usage-rules.mjs) into one email to core-team@tvc.farm whenever a
// free tier or credit balance is getting close to running out. It mails a
// condition once when it appears (and again only if it gets worse), remembers
// that in usage_alert_state, and forgets it once the condition clears so a
// recurrence mails again. One digest per run, never one email per alert.
//
// Domain renewals are NOT handled here: they alert from a GitHub Action
// (.github/workflows/domain-expiry.yml) so they still work if Netlify is
// paused. This function runs on Netlify, so it cannot warn about the one
// outage that takes it offline — the Netlify credits reading is a typed-in one
// and is mailed when it is *near* the limit, while this function still runs.
import { rest } from './lib/staff-mfa-store';
import { loadUsageData } from './lib/usage-store';
import { decideNotifications, evaluateAlerts } from '../../scripts/lib/usage-rules.mjs';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'TVC Website <noreply@tvc.farm>';
const NOTIFY_TO = ['core-team@tvc.farm'];
const PAGE_URL = 'https://tvc.farm/internal/usage';

type Alert = { key: string; level: 'warn' | 'critical'; title: string; detail: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendDigest(apiKey: string, alerts: Alert[]): Promise<void> {
  const critical = alerts.filter((a) => a.level === 'critical').length;
  const subject = `${critical ? 'Action needed: ' : ''}${alerts.length} free-tier ${alerts.length === 1 ? 'warning' : 'warnings'} for TVC`;
  const rows = alerts
    .map(
      (a) => `<tr>
        <td style="padding:8px 12px; border-bottom:1px solid #e2ddc9; white-space:nowrap; vertical-align:top;"><strong>${a.level === 'critical' ? 'Critical' : 'Warning'}</strong></td>
        <td style="padding:8px 12px; border-bottom:1px solid #e2ddc9;"><strong>${escapeHtml(a.title)}</strong><br><span style="color:#57604f; font-size:13px;">${escapeHtml(a.detail)}</span></td>
      </tr>`,
    )
    .join('');
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>${alerts.length === 1 ? 'A service' : 'Some services'} the TVC website relies on ${alerts.length === 1 ? 'is' : 'are'} close to a free-tier or credit limit:</p>
  <table style="border-collapse:collapse; width:100%; max-width:640px;"><tbody>${rows}</tbody></table>
  <p style="font-size:13px; color:#57604f;">Details and current figures: <a href="${PAGE_URL}">${PAGE_URL}</a> (sign in with Google). Each warning is sent once; you'll hear again only if it gets worse, or after it clears and comes back.</p>
</body>
</html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: NOTIFY_TO, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

export default async (): Promise<Response> => {
  let alerts: Alert[];
  let previous;
  try {
    const now = new Date();
    const data = await loadUsageData(now);
    alerts = evaluateAlerts({ now, daily: data.daily, snapshots: data.snapshots, settings: data.settings });
    previous = data.alertState;
  } catch (err) {
    console.error('[usage-alerts] failed to load usage data', err);
    return new Response('Failed to load usage data', { status: 500 });
  }

  const { toSend, upsert, clear } = decideNotifications(alerts, previous);

  try {
    if (toSend.length > 0) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        console.error('[usage-alerts] RESEND_API_KEY is not set — cannot send alert email');
        return new Response('Server misconfigured', { status: 500 });
      }
      // Email first: if it fails nothing is remembered, so the next hourly run tries again.
      await sendDigest(apiKey, toSend);
    }

    const sentKeys = new Set(toSend.map((a: Alert) => a.key));
    const now = new Date().toISOString();
    // Two batches because PostgREST needs every row in a batch to have the same columns.
    const sent = upsert.filter((u: { alert_key: string }) => sentKeys.has(u.alert_key)).map((u: object) => ({ ...u, last_notified_at: now }));
    const unchanged = upsert.filter((u: { alert_key: string }) => !sentKeys.has(u.alert_key));
    for (const batch of [sent, unchanged]) {
      if (batch.length === 0) continue;
      await rest('/usage_alert_state?on_conflict=alert_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch),
      });
    }
    if (clear.length > 0) {
      const list = clear.map((k: string) => `"${k.replace(/"/g, '')}"`).join(',');
      await rest(`/usage_alert_state?alert_key=in.(${encodeURIComponent(list)})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  } catch (err) {
    console.error('[usage-alerts] failed', err);
    return new Response('Failed to send or record alerts', { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, active: alerts.length, emailed: toSend.length, cleared: clear.length }), { status: 200 });
};

export const config = {
  schedule: '0 * * * *',
};
