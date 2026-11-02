// Tells the core team that someone has proposed a change to a past stay and it is waiting for an admin (see
// handleUpdate in accommodation-admin.mts and migration 0076). Never throws: a mail failure must not lose the request.
import { escapeHtml, renderStaffEmail } from './email-layout';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'TVC Website <noreply@tvc.farm>';
const NOTIFY_TO = ['core-team@tvc.farm'];

export async function sendChangeRequestEmail(input: { requestedBy: string; booking: string; stay: string; reason: string; changes: string[] }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[change-request-email] RESEND_API_KEY is not set, cannot send');
    return false;
  }
  const changes = input.changes.length ? `<ul>${input.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '<p>No change a person would see.</p>';
  const html = renderStaffEmail(`  <p style="margin-top:0;"><strong>${escapeHtml(input.requestedBy)}</strong> asked to change a past stay: <strong>${escapeHtml(input.booking)}</strong> (${escapeHtml(input.stay)}).</p>
  <p><strong>Why:</strong> ${escapeHtml(input.reason)}</p>
  <p><strong>What would change:</strong></p>${changes}
  <p>The stay stays as it is until an admin approves it. Open <a href="https://admin.tvc.farm/accommodation-calendar/">Stays</a> and choose "Changes to approve".</p>`);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: NOTIFY_TO, subject: `Change to a past stay waiting for approval: ${input.booking}`, html }),
    });
    if (!res.ok) console.error('[change-request-email] Resend send failed:', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('[change-request-email] Failed to reach Resend', err);
    return false;
  }
}
