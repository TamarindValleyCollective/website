// The email twin of the daily stays WhatsApp: the same day plan, laid out for planning the kitchen. Sent to
// core-team@tvc.farm the day before a party arrives (to plan the grocery purchase) and on the day they arrive.
// See WHATSAPP.md.
import { escapeHtml, renderStaffEmail } from './email-layout';
import { formatEventDate } from './whatsapp-send';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'TVC Website <noreply@tvc.farm>';
const NOTIFY_TO = ['core-team@tvc.farm'];

const TD = 'padding:8px 12px; border-bottom:1px solid #e2ddc9; vertical-align:top;';
const TH = 'padding:8px 12px; border-bottom:2px solid #294a36; text-align:left; font-size:13px; color:#57604f;';
const list = (items: string[]) => (items.length ? items.map(escapeHtml).join('<br>') : 'None');

export function buildStayPlanEmail(plan: any, when: 'tomorrow' | 'today'): { subject: string; html: string } {
  const dateLabel = formatEventDate(plan.date);
  const arrivals = plan.arriving
    .map(
      (a: any) => `<tr>
        <td style="${TD}"><strong>${escapeHtml(a.who)}</strong></td>
        <td style="${TD}">${a.guests || '?'}</td>
        <td style="${TD}">${escapeHtml(a.tents.join(', ') || 'No unit yet')}</td>
        <td style="${TD}">${escapeHtml(formatEventDate(a.checkOut))}</td>
      </tr>`,
    )
    .join('');
  const food = [...plan.food.map((f: any) => `${f.who}: ${f.need}`), ...plan.notes.map((n: any) => `${n.who}: ${n.note}`)];
  const leaving = plan.leaving.map((l: any) => `${l.who} (${l.guests || '?'} guests)`);

  const intro =
    when === 'tomorrow'
      ? `Guests arrive tomorrow, <strong>${escapeHtml(dateLabel)}</strong>. Here is what to plan the grocery purchase around.`
      : `Guests arrive today, <strong>${escapeHtml(dateLabel)}</strong>.`;
  const html = renderStaffEmail(`  <p style="margin-top:0;">${intro}</p>
  <table style="border-collapse:collapse; width:100%;">
    <thead><tr><th style="${TH}">Arriving</th><th style="${TH}">Guests</th><th style="${TH}">Unit</th><th style="${TH}">Leaves</th></tr></thead>
    <tbody>${arrivals}</tbody>
  </table>
  <p><strong>Meals that day:</strong> breakfast ${plan.breakfast}, dinner ${plan.dinner}</p>
  <p><strong>Food needs and notes:</strong><br>${list(food)}</p>
  <p><strong>Leaving that day:</strong><br>${list(leaving)}</p>
  <p style="font-size:13px; color:#57604f;">The full day plan is on the Stays page in the <a href="https://admin.tvc.farm">admin portal</a>.</p>`);

  return { subject: `${when === 'tomorrow' ? 'Arrivals tomorrow' : 'Arrivals today'}: stays plan for ${dateLabel}`, html };
}

/** @returns whether Resend accepted it; never throws, so a mail failure can't stop the WhatsApp send. */
export async function sendStayPlanEmail(email: { subject: string; html: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[stay-plan-email] RESEND_API_KEY is not set, cannot send');
    return false;
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: NOTIFY_TO, ...email }),
    });
    if (!res.ok) console.error('[stay-plan-email] Resend send failed:', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('[stay-plan-email] Failed to reach Resend', err);
    return false;
  }
}
