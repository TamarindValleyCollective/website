// Netlify scheduled function (daily, 06:30 IST) — WhatsApps the day's stays plan (who arrives, who leaves, meal
// counts, food needs and notes) to every number in WHATSAPP_DAILY_PLAN_NUMBERS. See WHATSAPP.md.
//
// Safe to ship dormant: sendWhatsAppTemplate sends nothing until tvc_stays_daily_plan is approved by Meta and listed
// in WHATSAPP_APPROVED_TEMPLATES, and nothing at all when WHATSAPP_DAILY_PLAN_NUMBERS is empty. A day with nobody on
// the farm and nobody arriving or leaving sends nothing, so an empty farm doesn't buzz a phone every morning.
import { listBookingsForAdmin, getUnitLabels } from '../../scripts/lib/accommodation-db.mjs';
import { buildDayPlan, planToTemplateParams } from '../../scripts/lib/stay-day-plan.mjs';
import { sendWhatsAppTemplate, cleanTemplateParam, formatEventDate } from './lib/whatsapp-send';

const todayInIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const monthOf = (date: string) => date.slice(0, 7);
// The month before `date`, so a stay that checked out on the 1st (its last night was in the previous month) is found.
function previousMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

export default async (): Promise<Response> => {
  const numbers = (process.env.WHATSAPP_DAILY_PLAN_NUMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (numbers.length === 0) return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no recipients configured' }), { status: 200 });

  const date = todayInIst();
  let plan;
  try {
    const [thisMonth, lastMonth, labels] = await Promise.all([
      listBookingsForAdmin({ month: monthOf(date) }),
      listBookingsForAdmin({ month: previousMonth(date) }),
      getUnitLabels(),
    ]);
    const byId = new Map<string, any>();
    for (const b of [...lastMonth, ...thisMonth]) byId.set(b.id, b);
    plan = buildDayPlan([...byId.values()], date, labels);
  } catch (err) {
    console.error('[whatsapp-stays-daily-plan] Failed to read bookings', err);
    return new Response('Failed to read bookings', { status: 500 });
  }
  if (plan.quiet) {
    console.log('[whatsapp-stays-daily-plan]', date, 'quiet day, nothing sent');
    return new Response(JSON.stringify({ ok: true, date, sent: 0, reason: 'quiet day' }), { status: 200 });
  }

  const params = planToTemplateParams(plan, formatEventDate(date)).map((p) => cleanTemplateParam(p, 600));
  const tally = { sent: 0, skipped: 0, failed: 0 };
  for (const to of numbers) tally[await sendWhatsAppTemplate({ template: 'tvc_stays_daily_plan', to, params })]++;

  console.log('[whatsapp-stays-daily-plan]', date, JSON.stringify(tally));
  return new Response(JSON.stringify({ ok: true, date, ...tally }), { status: 200 });
};

export const config = {
  schedule: '0 1 * * *', // 01:00 UTC = 06:30 IST
};
