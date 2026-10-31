// The AI-written morning briefing for a day's stays. Guests' details are private, and the model sits behind Google's
// free Gemini tier (which may keep and review what it is sent: see WHATSAPP.md), so the model never sees who anyone is:
// buildAiFacts turns the day into anonymous facts (counts, tent names, a public event's own title, the dietary and
// other notes with guest names, phone numbers and emails taken out). summariseDay then asks the model, with a cache so
// an unchanged day is never asked twice, and always degrades to "no summary" instead of failing the page.
//
// Pure apart from the injected dependencies, so it is tested without a network (stay-day-summary.test.mjs).
import { buildDayPlan, tentsLabel } from './stay-day-plan.mjs';
import { checkOutDate } from './stay-notice.mjs';

const KIND = { 'casual-stay': 'guest stay', 'member-stay': 'member stay', 'private-event': 'private event', 'public-event': 'public event' };

const EMAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Free text with emails, phone numbers and any word of a guest's name removed. Names shorter than three letters are
 * left alone (too likely to be an ordinary word); a name typed inside a note is the case this exists for.
 * @param {string} text
 * @param {string[]} names full names or labels, split into words
 */
export function deidentify(text, names) {
  let out = text.replace(EMAIL, '[removed]').replace(PHONE, '[removed]');
  const words = new Set(names.flatMap((n) => String(n).split(/[\s,.;:()/&-]+/)).filter((w) => w.length >= 3));
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu'), 'the guest');
  }
  return out;
}

/**
 * The day as anonymous facts for the model, or null when no guest is on the farm (nothing is ever sent for such a day:
 * a booking with tents but no guests entered counts as nobody).
 * @param {any[]} bookings the admin API's bookings
 * @param {string} date YYYY-MM-DD
 * @param {Map<string, string>} labels unit id -> tent name
 * @param {string} dateLabel e.g. "Saturday, 3 October 2026"
 */
export function buildAiFacts(bookings, date, labels, dateLabel) {
  const plan = buildDayPlan(bookings, date, labels);
  const guestsToday = [...plan.arriving, ...plan.leaving, ...plan.staying].reduce((n, e) => n + e.guests, 0);
  if (plan.quiet || guestsToday === 0) return null;
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const present = bookings.filter((b) => KIND[b.type] && b.startDate <= date && date <= checkOutDate(b.startDate, b.nights));
  const names = present.flatMap((b) => [b.label, ...b.tents.flatMap((t) => t.guests.map((g) => g.name))]).filter(Boolean);
  const clean = (t) => deidentify(t, names);

  const entry = (e) => {
    const b = byId.get(e.id);
    const needs = [...new Set(b.tents.flatMap((t) => t.guests.map((g) => g.preferences?.trim()).filter(Boolean)))].map(clean);
    const note = b.note?.trim();
    return {
      kind: KIND[b.type],
      // A public event's title is the event's own public name; a private booking's label can be a person's name.
      ...(b.type === 'public-event' && b.eventTitle ? { title: b.eventTitle } : {}),
      guests: e.guests,
      tents: tentsLabel(e.tents),
      ...(note ? { note: clean(note) } : {}),
      ...(needs.length ? { dietaryNotes: needs } : {}),
    };
  };

  return {
    date: dateLabel,
    checkIns: plan.arriving.map(entry),
    checkOuts: plan.leaving.map(entry),
    stayingThrough: plan.staying.map((e) => ({ ...entry(e), leavesOn: e.until })),
    breakfastCount: plan.breakfast,
    dinnerCount: plan.dinner,
  };
}

export const SUMMARY_INSTRUCTIONS = `You write the short morning briefing for the manager of a small farm stay. He reads it to plan the day: who arrives and leaves, which tents to get ready, how many people eat, and anything that needs care. You are given anonymised facts as JSON.

Rules:
- Use only the facts. Never invent a number, a name or a need.
- Nobody is named. Refer to a booking by its event title when it has one, otherwise as "a guest stay", "the private event" or "the member stay".
- Always give the breakfast and dinner counts.
- Call out every dietary, medical or accessibility note clearly, in your own plain words, without adding detail. If a note is only a headcount or party make-up, treat it as that and do not call it a dietary need.
- If nothing needs special care, say so in one short line.
- Plain text only: no markdown, no headings, no emoji. At most six short lines, about 120 words, in simple English.`;

export const buildUserText = (facts) => `Facts for the day:\n${JSON.stringify(facts)}\n\nWrite the briefing.`;

/** Plain text, no markdown marks, no runaway length. */
export function cleanSummary(text) {
  const t = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > 900 ? `${t.slice(0, 899).trimEnd()}…` : t;
}

/**
 * Which days may be summarised: today and the days ahead (a briefing is for planning, so a past day never is), up to
 * two months out. Checked on the server, whatever the page offers.
 * @param {string} date YYYY-MM-DD @param {string} today YYYY-MM-DD in the farm's timezone
 * @returns {null | 'past' | 'too-far'}
 */
export function summaryDateProblem(date, today) {
  if (date < today) return 'past';
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + 61 * 86_400_000).toISOString().slice(0, 10);
  return date > limit ? 'too-far' : null;
}

/**
 * @param {ReturnType<typeof buildAiFacts>} facts
 * @param {{ hash: (s: string) => string, cacheGet: (k: string) => Promise<string | null>, cacheSet: (k: string, v: string) => Promise<void>,
 *   allow: () => Promise<boolean>, callModel: (system: string, user: string) => Promise<string | null> }} deps
 * @param {{ refresh?: boolean }} [options] refresh: write it again, ignoring (and then replacing) the cached text
 * @returns {Promise<{ summary: string, cached: boolean } | { summary: null, reason: 'quiet' | 'limit' | 'unavailable' }>}
 */
export async function summariseDay(facts, deps, { refresh = false } = {}) {
  if (!facts) return { summary: null, reason: 'quiet' };
  const userText = buildUserText(facts);
  const key = `${facts.date.replace(/\W+/g, '-')}:${deps.hash(userText)}`;
  if (!refresh) {
    try {
      const hit = await deps.cacheGet(key);
      if (hit) return { summary: hit, cached: true };
    } catch {
      // a cache outage only costs a repeat call
    }
  }
  if (!(await deps.allow())) return { summary: null, reason: 'limit' };
  const raw = await deps.callModel(SUMMARY_INSTRUCTIONS, userText);
  const summary = raw ? cleanSummary(raw) : '';
  if (!summary) return { summary: null, reason: 'unavailable' };
  try {
    await deps.cacheSet(key, summary);
  } catch {
    // not cached; the next view asks again
  }
  return { summary, cached: false };
}
