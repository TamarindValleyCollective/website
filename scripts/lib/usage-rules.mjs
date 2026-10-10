// The rules behind the free-tier usage dashboard (/internal/usage) and its
// alert emails (netlify/functions/usage-alerts.mts): what counts as "getting
// close", how much Anthropic credit is probably left, and which alerts are
// new enough to be worth an email. Pure functions only (no network, no
// database), so the same rules drive the page and the emails and can be
// tested directly: node --test scripts/usage-rules.test.mjs
//
// Honest limits of what's computed here:
//   * Anthropic: individual accounts have no usage API, so "credit left" is an
//     ESTIMATE = the balance someone last typed in, minus our own metered
//     token usage since. Anything not routed through the website (e.g. the
//     local caption-photos.mjs script) is invisible to it.
//   * Days are UTC, matching how usage_daily is keyed.

export const WARN_USED = 0.7; // 70% of a limit used
export const CRITICAL_USED = 0.9;
export const WARN_REMAINING = 0.3; // 30% of credit left
export const CRITICAL_REMAINING = 0.1;
export const EXPIRY_WARN_DAYS = 30;
export const EXPIRY_CRITICAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY = { warn: 1, critical: 2 };

// Readings a person types in from a provider's own dashboard, for services we
// can't measure ourselves. A fixed list on purpose: the API refuses anything
// else, so a typo can't create a stray meter. `kind` says whether the number
// entered is how much has been USED (alert as it nears the limit) or how much
// is LEFT (alert as it nears zero). No provider limits are hard-coded: the
// person enters the limit alongside the reading, so a plan change on the
// provider's side never silently makes our percentages wrong.
export const MANUAL_METERS = {
  'anthropic.credit_remaining_usd': {
    service: 'anthropic',
    metric: 'credit_remaining_usd',
    label: 'Anthropic credit',
    kind: 'remaining',
    unit: 'USD',
    valueLabel: 'Credit left now (USD)',
    limitLabel: 'Total credit you started with / last topped up (USD)',
    where: 'console.anthropic.com → Billing',
    supportsExpiry: true,
  },
  'netlify.credits_remaining': {
    service: 'netlify',
    metric: 'credits_remaining',
    label: 'Netlify credits',
    kind: 'remaining',
    unit: 'credits',
    valueLabel: 'Credits remaining now (as Netlify shows)',
    limitLabel: 'Credits included in your plan per billing cycle (filled in automatically when the Netlify token is set)',
    where: 'Netlify → Team → Billing and usage',
  },
  'resend.emails_used': {
    service: 'resend',
    metric: 'emails_used',
    label: 'Resend emails',
    kind: 'used',
    unit: 'emails',
    valueLabel: 'Emails sent this period',
    limitLabel: 'Emails allowed in this period (monthly or daily, as Resend shows)',
    where: 'resend.com → Usage',
  },
  'cloudflare.r2_storage_gb': {
    service: 'cloudflare',
    metric: 'r2_storage_gb',
    label: 'Cloudflare R2 storage',
    kind: 'used',
    unit: 'GB',
    valueLabel: 'Storage used (GB)',
    limitLabel: 'Free storage included (GB)',
    where: 'Cloudflare → R2 → Overview',
  },
};

// Netlify's billing cycle does not follow the calendar month (ours runs from
// the 19th), and the plan's credit allowance can be read from its API even
// though credits USED cannot. usage-collect.mts records the allowance and cycle
// dates as a 'netlify.plan_credits' snapshot; this folds them into the typed-in
// 'netlify.credits_remaining' reading: the allowance replaces the typed limit, and a
// reading entered before the current cycle began is marked `staleForCycle`
// because the balance resets when a new cycle starts. Returns a new map.
export const NETLIFY_PLAN_STALE_DAYS = 2; // collector runs every 6h, so 2 days with no new reading means it is failing

export function mergeNetlifyPlan(snapshots, now = new Date()) {
  const plan = snapshots['netlify.plan_credits'];
  const used = snapshots['netlify.credits_remaining'];
  if (!plan || !used) return snapshots;
  const cycleStart = plan.detail?.period_start ?? null;
  const cycleEnd = plan.detail?.next_period_start ?? null;
  const limit = isPositiveNumber(Number(plan.limit_value)) ? Number(plan.limit_value) : used.limit_value;
  const staleForCycle = cycleStart ? new Date(used.captured_at) < new Date(cycleStart) : false;
  const planAgeDays = (now.getTime() - new Date(plan.captured_at).getTime()) / DAY_MS;
  const planStale = planAgeDays > NETLIFY_PLAN_STALE_DAYS;
  return { ...snapshots, 'netlify.credits_remaining': { ...used, limit_value: limit, detail: { ...(used.detail ?? {}), cycle_start: cycleStart, cycle_end: cycleEnd, stale_for_cycle: staleForCycle, plan_captured_at: plan.captured_at, plan_stale: planStale } } };
}

export const SETTING_KEYS = ['anthropic_prices', 'gemini_daily_requests'];

// ---- small helpers --------------------------------------------------------

export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(day, n) {
  return utcDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS));
}

// Sums usage_daily rows for service/metric whose day is within [from, to].
export function sumDaily(daily, service, metric, from, to) {
  let total = 0;
  for (const row of daily) {
    if (row.service === service && row.metric === metric && row.day >= from && row.day <= to) total += Number(row.value) || 0;
  }
  return total;
}

export function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Estimated Anthropic spend in USD for a set of token counts, or null if no
// prices are set. Prices are per million tokens. Cache reads and writes are
// billed as fixed multiples of the input price (0.1x and 1.25x for the 5-minute
// cache this site uses); if Anthropic changes those, change them here.
export function estimateCostUsd(tokens, prices) {
  if (!prices || !isPositiveNumber(prices.input) || !isPositiveNumber(prices.output)) return null;
  const perToken = (pricePerMillion) => pricePerMillion / 1_000_000;
  return (
    (tokens.input_tokens ?? 0) * perToken(prices.input) +
    (tokens.output_tokens ?? 0) * perToken(prices.output) +
    (tokens.cache_read_tokens ?? 0) * perToken(prices.input) * 0.1 +
    (tokens.cache_write_tokens ?? 0) * perToken(prices.input) * 1.25
  );
}

export function anthropicTokensBetween(daily, from, to) {
  const t = (metric) => sumDaily(daily, 'anthropic', metric, from, to);
  return {
    requests: t('requests'),
    input_tokens: t('input_tokens'),
    output_tokens: t('output_tokens'),
    cache_read_tokens: t('cache_read_tokens'),
    cache_write_tokens: t('cache_write_tokens'),
  };
}

// Level for "used / limit" meters: null below 70%, 'warn' from 70%, 'critical'
// from 90%.
export function levelForUsed(used, limit) {
  if (!isPositiveNumber(limit) || typeof used !== 'number' || !Number.isFinite(used)) return null;
  const fraction = used / limit;
  if (fraction >= CRITICAL_USED) return 'critical';
  if (fraction >= WARN_USED) return 'warn';
  return null;
}

// Level for "remaining / total" credit: null above 30% left, 'warn' at 30% or
// less, 'critical' at 10% or less.
export function levelForRemaining(remaining, total) {
  if (!isPositiveNumber(total) || typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  const fraction = remaining / total;
  if (fraction <= CRITICAL_REMAINING) return 'critical';
  if (fraction <= WARN_REMAINING) return 'warn';
  return null;
}

// Probable Anthropic credit left: the last typed-in reading minus metered
// spend from the reading's own UTC day onwards. Counting that whole first day
// can double-count a few hours of usage already reflected in the typed-in
// number; that errs toward warning early, which is the safe direction.
// Returns null when there is no reading or no prices to turn tokens into money.
export function anthropicCreditEstimate(snapshot, daily, prices, now = new Date()) {
  if (!snapshot) return null;
  const fromDay = utcDay(new Date(snapshot.captured_at));
  const spent = estimateCostUsd(anthropicTokensBetween(daily, fromDay, utcDay(now)), prices);
  if (spent === null) return null;
  const remaining = Math.max(0, Number(snapshot.value) - spent);
  return {
    remaining,
    spent,
    total: snapshot.limit_value === null || snapshot.limit_value === undefined ? null : Number(snapshot.limit_value),
    readingAt: snapshot.captured_at,
    readingValue: Number(snapshot.value),
    level: levelForRemaining(remaining, snapshot.limit_value === null ? null : Number(snapshot.limit_value)),
  };
}

export function daysUntilDate(isoDay, now = new Date()) {
  return Math.floor((new Date(`${isoDay}T23:59:59Z`).getTime() - now.getTime()) / DAY_MS);
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}

function money(n) {
  return `$${n.toFixed(2)}`;
}

// ---- the alert rules ------------------------------------------------------

// input: {
//   now: Date,
//   daily: [{ day, service, metric, value }],          // usage_daily, recent
//   snapshots: { 'supabase.db_size_bytes': {value, limit_value, captured_at, detail}, ...  }, // latest per meter
//   settings: { anthropic_prices?: {input, output}, gemini_daily_requests?: number }
// }
// Returns [{ key, level: 'warn'|'critical', service, title, detail }]. `key`
// identifies the underlying condition so a repeat of it isn't mailed twice.
/** @param {{ now?: Date, daily?: any[], snapshots?: Record<string, any>, settings?: any }} input */
export function evaluateAlerts({ now = new Date(), daily = [], snapshots: rawSnapshots = {}, settings = {} }) {
  const snapshots = mergeNetlifyPlan(rawSnapshots, now);
  const alerts = [];
  const today = utcDay(now);
  const yesterday = addDays(today, -1);
  const add = (key, level, service, title, detail) => level && alerts.push({ key, level, service, title, detail });

  // Anthropic has refused requests over billing: credits are gone *now*,
  // whatever any estimate says. Looks back a day so the alert doesn't clear at
  // UTC midnight while the problem is still there.
  const billing = sumDaily(daily, 'anthropic', 'billing_errors', yesterday, today);
  if (billing > 0) {
    add(
      'anthropic:billing',
      'critical',
      'anthropic',
      'Anthropic is refusing requests: credits look exhausted',
      `${billing} request${billing === 1 ? ' was' : 's were'} refused for billing reasons since yesterday. The chat assistant, and the AI search fallback, are failing for visitors. Add credit at console.anthropic.com → Billing.`,
    );
  }

  // Estimated credit left.
  const anthropicReading = snapshots['anthropic.credit_remaining_usd'];
  const estimate = anthropicCreditEstimate(anthropicReading, daily, settings.anthropic_prices, now);
  if (estimate && estimate.level) {
    add(
      'anthropic:credit',
      estimate.level,
      'anthropic',
      `Anthropic credit is running low (about ${money(estimate.remaining)} left, estimated)`,
      `That is roughly ${pct(estimate.remaining / estimate.total)} of the ${money(estimate.total)} total. It is an estimate: the balance typed in on ${utcDay(new Date(estimate.readingAt))} minus the website's own metered usage since. Check the real balance at console.anthropic.com → Billing.`,
    );
  }

  // Credit expiry (only if a date was entered with the reading).
  const expiresOn = anthropicReading?.detail?.expires_on;
  if (typeof expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    const days = daysUntilDate(expiresOn, now);
    const level = days <= EXPIRY_CRITICAL_DAYS ? 'critical' : days <= EXPIRY_WARN_DAYS ? 'warn' : null;
    add(
      'anthropic:expiry',
      level,
      'anthropic',
      days < 0 ? 'Anthropic credit has expired' : `Anthropic credit expires in ${days} day${days === 1 ? '' : 's'}`,
      `The expiry date entered with the last balance reading is ${expiresOn}. Unused credit may be lost after it.`,
    );
  }

  // Gemini free tier.
  const geminiQuota = sumDaily(daily, 'gemini', 'quota_exhausted', today, today);
  if (geminiQuota > 0) {
    add(
      'gemini:quota',
      'warn',
      'gemini',
      'Gemini free quota ran out today',
      `Google refused ${geminiQuota} search request${geminiQuota === 1 ? '' : 's'} (HTTP 429) today, so those searches fell back to paid Anthropic answers, or failed if the daily fallback budget was also used up.`,
    );
  }
  const geminiLimit = settings.gemini_daily_requests;
  if (isPositiveNumber(geminiLimit)) {
    const used = sumDaily(daily, 'gemini', 'requests', today, today);
    const level = levelForUsed(used, geminiLimit);
    add('gemini:daily', level, 'gemini', `Gemini is at ${pct(used / geminiLimit)} of today's request limit`, `${used} of ${geminiLimit} requests used so far today (UTC day; Google's own daily reset may fall at a different hour).`);
  }

  // Our own caps being hit means real growth or someone hammering the site.
  const chatCap = sumDaily(daily, 'anthropic', 'chat_cap_hits', today, today);
  if (chatCap > 0) {
    add('site:chat-cap', 'warn', 'anthropic', 'The chat assistant hit its daily message cap', `${chatCap} chat message${chatCap === 1 ? '' : 's'} were turned away today because the site-wide daily cap was reached. Either real interest or abuse; see the Anthropic card for volumes.`);
  }
  const searchCap = sumDaily(daily, 'anthropic', 'search_fallback_cap_hits', today, today);
  if (searchCap > 0) {
    add('site:search-cap', 'warn', 'anthropic', 'AI search hit its paid-fallback daily cap', `${searchCap} search${searchCap === 1 ? '' : 'es'} could not use the paid Anthropic fallback today because its daily budget was reached.`);
  }

  // Measured Supabase size.
  const db = snapshots['supabase.db_size_bytes'];
  if (db && isPositiveNumber(Number(db.limit_value))) {
    const level = levelForUsed(Number(db.value), Number(db.limit_value));
    const mb = (b) => `${(Number(b) / 1024 / 1024).toFixed(0)} MB`;
    add('supabase:db-size', level, 'supabase', `Supabase database is at ${pct(Number(db.value) / Number(db.limit_value))} of its free size`, `${mb(db.value)} used of ${mb(db.limit_value)}. Free projects stop accepting writes at the limit.`);
  }

  // The Netlify token (usage-collect) stopped refreshing the plan data: expired, revoked, or
  // the API changed. Only once a plan snapshot has existed, so no token yet means no alert.
  const netlifyPlan = snapshots['netlify.plan_credits'];
  if (netlifyPlan && (now.getTime() - new Date(netlifyPlan.captured_at).getTime()) / DAY_MS > NETLIFY_PLAN_STALE_DAYS) {
    add('netlify:plan-stale', 'warn', 'netlify', 'Netlify plan data has stopped refreshing', `The last plan/billing-cycle reading from the Netlify API was on ${utcDay(new Date(netlifyPlan.captured_at))}. Check NETLIFY_ACCESS_TOKEN (it may have expired or been revoked) and the usage-collect function logs. Until then the credit limit and cycle dates shown are the last known ones.`);
  }

  // Everything else a person types in. (Anthropic's balance has its own estimate above.)
  for (const [id, meter] of Object.entries(MANUAL_METERS)) {
    if (id === 'anthropic.credit_remaining_usd') continue;
    const reading = snapshots[id];
    if (!reading || !isPositiveNumber(Number(reading.limit_value))) continue;
    if (reading.detail?.stale_for_cycle) continue; // from a previous billing cycle: the balance has reset since
    if (meter.kind === 'remaining') {
      const left = Number(reading.value);
      const total = Number(reading.limit_value);
      add(`manual:${id}`, levelForRemaining(left, total), meter.service, `${meter.label} running low: ${left} of ${total} ${meter.unit} left`, `That is ${pct(left / total)} of the allowance, as last entered on ${utcDay(new Date(reading.captured_at))}. Update the reading on the usage page for a fresh figure.`);
      continue;
    }
    const value = Number(reading.value);
    const limit = Number(reading.limit_value);
    add(`manual:${id}`, levelForUsed(value, limit), meter.service, `${meter.label} at ${pct(value / limit)} of the limit`, `${value} of ${limit} ${meter.unit}, as last entered on ${utcDay(new Date(reading.captured_at))}. Update the reading on the usage page for a fresh figure.`);
  }

  return alerts;
}

// Compares currently-active alerts with what has already been mailed:
//   toSend  alerts to email now: new, or worse than last time (warn -> critical)
//   upsert  every active alert with its current level, to remember
//   clear   remembered keys whose condition has gone, so a recurrence mails again
// Getting better (critical -> warn) updates the memory but sends nothing.
export function decideNotifications(alerts, previous) {
  const known = new Map(previous.map((p) => [p.alert_key, p.level]));
  const active = new Set(alerts.map((a) => a.key));
  return {
    toSend: alerts.filter((a) => !known.has(a.key) || SEVERITY[a.level] > SEVERITY[known.get(a.key)]),
    upsert: alerts.map((a) => ({ alert_key: a.key, level: a.level })),
    clear: previous.map((p) => p.alert_key).filter((k) => !active.has(k)),
  };
}
