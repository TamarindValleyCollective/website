// Netlify scheduled function (daily, 06:30 IST) — WhatsApps the day's stays plan (who arrives, who leaves, meal
// counts, food needs and notes) to every number in WHATSAPP_DAILY_PLAN_NUMBERS, and the day before a party arrives
// (grocery planning) and on the day they arrive also emails it to core-team@tvc.farm. See WHATSAPP.md.
//
// Safe to ship dormant: sendWhatsAppTemplate sends nothing until tvc_stays_daily_plan is approved by Meta and listed
// in WHATSAPP_APPROVED_TEMPLATES, and nothing at all when WHATSAPP_DAILY_PLAN_NUMBERS is empty. A day with nobody on
// the farm and nobody arriving or leaving sends nothing, so an empty farm doesn't buzz a phone every morning.
import { listBookingsForAdmin, getUnitLabels } from '../../scripts/lib/accommodation-db.mjs';
import { buildDayPlan, planToTemplateParams, shiftDate } from '../../scripts/lib/stay-day-plan.mjs';
import { sendWhatsAppTemplate, cleanTemplateParam, formatEventDate } from './lib/whatsapp-send';
import { buildStayPlanEmail, sendStayPlanEmail } from './lib/stay-plan-email';

const todayInIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const monthOf = (date: string) => date.slice(0, 7);
// The month before `date`, so a stay that checked out on the 1st (its last night was in the previous month) is found.
function previousMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}
const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export default async (): Promise<Response> => {
  const numbers = list(process.env.WHATSAPP_DAILY_PLAN_NUMBERS);
  if (numbers.length === 0 && !process.env.RESEND_API_KEY) return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no recipients configured' }), { status: 200 });

  const date = todayInIst();
  const tomorrow = shiftDate(date, 1);
  let bookings: any[];
  let labels: Map<string, string>;
  try {
    // Tomorrow can fall in next month, and a stay that left on the 1st began in the previous one.
    const months = [...new Set([previousMonth(date), monthOf(date), monthOf(tomorrow)])];
    const [perMonth, unitLabels] = await Promise.all([Promise.all(months.map((month) => listBookingsForAdmin({ month }))), getUnitLabels()]);
    const byId = new Map<string, any>();
    for (const b of perMonth.flat()) byId.set(b.id, b);
    bookings = [...byId.values()];
    labels = unitLabels;
  } catch (err) {
    console.error('[whatsapp-stays-daily-plan] Failed to read bookings', err);
    return new Response('Failed to read bookings', { status: 500 });
  }

  const today = buildDayPlan(bookings, date, labels);
  const next = buildDayPlan(bookings, tomorrow, labels);
  const tally = { sent: 0, skipped: 0, failed: 0 };
  const whatsapp = async (plan: any) => {
    const params = planToTemplateParams(plan, formatEventDate(plan.date)).map((p) => cleanTemplateParam(p, 600));
    for (const to of numbers) tally[await sendWhatsAppTemplate({ template: 'tvc_stays_daily_plan', to, params })]++;
  };

  // Today's plan goes to WhatsApp whenever anyone is on the farm. An empty farm doesn't buzz a phone every morning.
  if (!today.quiet) await whatsapp(today);
  // Tomorrow's arrivals get the same message a day early, to plan the grocery purchase (the template is a plan for
  // whatever date {{1}} names).
  if (next.arriving.length > 0) await whatsapp(next);

  // Email (to the core team) goes out only on the two days that matter for arrivals: the day before, and the day itself.
  let mailed = 0;
  if (next.arriving.length > 0 && (await sendStayPlanEmail(buildStayPlanEmail(next, 'tomorrow')))) mailed++;
  if (today.arriving.length > 0 && (await sendStayPlanEmail(buildStayPlanEmail(today, 'today')))) mailed++;

  console.log('[whatsapp-stays-daily-plan]', date, JSON.stringify({ ...tally, mailed }));
  return new Response(JSON.stringify({ ok: true, date, ...tally, mailed }), { status: 200 });
};

export const config = {
  schedule: '0 1 * * *', // 01:00 UTC = 06:30 IST
};
