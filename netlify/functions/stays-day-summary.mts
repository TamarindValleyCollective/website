// Netlify Function (v2 API) behind the Stays page's Day view: an AI-written morning briefing for one day.
//
// Gated like the Stays page itself (Google sign-in + `view` on the accommodation module), and only for roles that may
// see guest names and notes at all: a read-only role is told there is no summary. The browser sends just a date; the
// bookings are read here, never taken from the request.
//
// Privacy: the model is Google's FREE Gemini tier, which may keep and review what it is sent (see WHATSAPP.md). So it
// only ever sees anonymous facts (scripts/lib/stay-day-summary.mjs): counts, tent names, a public event's own title and
// the notes with guest names, phone numbers and emails removed. Nothing about the request is logged.
//
// What may be summarised: today and the days ahead, never a past day, and never a day with no guests (no facts, so
// nothing is sent). The page asks by itself for today and tomorrow and on a button press for later days; `refresh`
// writes it again.
//
// Cost and limits: an unchanged day is answered from a cache (Netlify Blobs, keyed by a hash of the facts), a person
// can ask 20 times in ten minutes, the whole site DAILY_CAP times a day (STAYS_SUMMARY_DAILY_CAP, kept under the free
// tier's own quota, which search and suggested replies share), and writing it again is limited to 5 an hour per person.
// Any failure (no key, quota, a safety block) answers `summary: null` and the page shows the plan without it.
import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { requireStaff } from './lib/staff-access';
import { canSeeNames } from './lib/staff-masking';
import { checkIpRateLimit, checkDailyCap } from './lib/rate-limit';
import { callGemini } from './lib/whatsapp-suggest';
import { formatEventDate } from './lib/whatsapp-send';
import { listBookingsForAdmin, getUnitLabels } from '../../scripts/lib/accommodation-db.mjs';
import { buildAiFacts, summariseDay, summaryDateProblem } from '../../scripts/lib/stay-day-summary.mjs';

const RATE_LIMIT_STORE = 'stays-day-summary-rate-limit';
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
// The whole site's asks per day. Free Gemini's own daily quota is shared with the site search and suggested replies, so
// set STAYS_SUMMARY_DAILY_CAP (Netlify) to fit what Google AI Studio shows for the model.
const DAILY_CAP = Number(process.env.STAYS_SUMMARY_DAILY_CAP) || 60;
const REFRESH_STORE = 'stays-day-summary-refresh';
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const REFRESH_MAX = 5;
const MAX_OUTPUT_TOKENS = 500;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// A Blobs outage shouldn't take a briefing away: fail open and log.
async function allowed(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (err) {
    console.error('[stays-day-summary] Rate-limit store unavailable, allowing the request', err);
    return true;
  }
}

const monthOf = (date: string) => date.slice(0, 7);
// The month of the day before: a stay that checks out on the 1st has its last night in the previous month.
function monthBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 7);
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireStaff(req, 'accommodation', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  // A read-only role sees masked names and no food needs, so there is nothing for a summary to say. 200, not 403:
  // the page treats a 403 as "this account has no access" and would show its forbidden screen.
  if (!canSeeNames(auth.staff.role)) return jsonResponse({ summary: null, reason: 'unavailable' });

  let date: string | undefined;
  let refresh = false;
  try {
    const body = (await req.json()) as { date?: string; refresh?: boolean };
    date = body.date;
    refresh = body.refresh === true;
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return jsonResponse({ error: 'A date (YYYY-MM-DD) is required' }, 400);
  // Whatever the page offers, a past day (or one far ahead) is never sent to the model.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (summaryDateProblem(date, today)) return jsonResponse({ summary: null, reason: 'unavailable' });

  let facts;
  try {
    const months = [...new Set([monthBefore(date), monthOf(date)])];
    const [lists, labels] = await Promise.all([Promise.all(months.map((month) => listBookingsForAdmin({ month }))), getUnitLabels()]);
    const byId = new Map(lists.flat().map((b: { id: string }) => [b.id, b]));
    facts = buildAiFacts([...byId.values()], date, labels, formatEventDate(date));
  } catch (err) {
    console.error('[stays-day-summary] Failed to read bookings', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const cache = getStore('stays-day-summary');
  const result = await summariseDay(facts, {
    hash: (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24),
    cacheGet: async (key: string) => (await cache.get(key, { type: 'text' })) ?? null,
    cacheSet: async (key: string, value: string) => void (await cache.set(key, value)),
    // Only reached for a day that is not already cached. Each guard is checked in turn and the first to refuse ends it.
    allow: async () =>
      (!refresh || (await allowed(() => checkIpRateLimit(REFRESH_STORE, auth.staff.id, REFRESH_WINDOW_MS, REFRESH_MAX)))) &&
      (await allowed(() => checkIpRateLimit(RATE_LIMIT_STORE, auth.staff.id, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS))) &&
      (await allowed(() => checkDailyCap(RATE_LIMIT_STORE, 'daily', DAILY_CAP))),
    callModel: async (system: string, user: string) => (geminiKey ? callGemini(geminiKey, system, user, MAX_OUTPUT_TOKENS, 'text/plain') : null),
  }, { refresh });
  return jsonResponse(result);
};

export const config = {
  path: '/api/stays-day-summary',
};
