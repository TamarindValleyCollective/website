// Netlify Function (v2 API) backing the internal usage dashboard
// (src/pages/internal/usage.astro): how much of each free tier / credit
// balance we are using, which warnings are active, and when each domain
// expires. Read-only for anyone with the `view` capability in the `usage`
// module; typing in a reading from a provider's own dashboard, or changing the
// prices/limits the estimates use, needs `configure` (admins).
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts) checks
// the caller's role on every request, like the other internal APIs.
//
// What is measured vs typed in, honestly: Supabase size and the website's own
// Anthropic/Gemini calls are measured (migration 0030). Everything else has no
// API we are willing to hold a credential for, so a person types the figure in
// from the provider's dashboard (see MANUAL_METERS). The page labels which is
// which. Nothing here returns an email address or message content: only counts,
// sizes and dates.
import { requireStaff, logStaffAction } from './lib/staff-access';
import { rest } from './lib/staff-mfa-store';
import { loadUsageData } from './lib/usage-store';
import { roleHasCapability } from './lib/staff-registry';
import {
  MANUAL_METERS,
  mergeNetlifyPlan,
  nextCollectorRun,
  COLLECTOR_EVERY_HOURS,
  r2AutomaticIsFresh,
  resendAutomaticIsFresh,
  resendReadingAgeDays,
  addDays,
  anthropicCreditEstimate,
  anthropicTokensBetween,
  daysUntilDate,
  estimateCostUsd,
  evaluateAlerts,
  isPositiveNumber,
  levelForRemaining,
  levelForUsed,
  sumDaily,
  utcDay,
} from '../../scripts/lib/usage-rules.mjs';
import { DEFAULT_DOMAINS, daysUntil, lookupDomain } from '../../scripts/lib/domain-expiry.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// ---- overview -------------------------------------------------------------

function series(daily: any[], service: string, metric: string, today: string, days: number) {
  const out: { day: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    out.push({ day, value: sumDaily(daily, service, metric, day, day) });
  }
  return out;
}

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'usage', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const now = new Date();
  const today = utcDay(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = addDays(today, -6);

  let data;
  try {
    data = await loadUsageData(now);
  } catch (err) {
    console.error('[usage-admin] failed to load usage data', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  const { daily, settings, alertState, dbHistory } = data;
  const snapshots = mergeNetlifyPlan(data.snapshots, now);
  const prices = settings.anthropic_prices ?? null;

  const tokens = (from: string, to: string) => anthropicTokensBetween(daily, from, to);
  const cost = (from: string, to: string) => estimateCostUsd(tokens(from, to), prices);
  const count = (service: string, metric: string, from: string, to: string) => sumDaily(daily, service, metric, from, to);

  const reading = snapshots['anthropic.credit_remaining_usd'] ?? null;
  const estimate = anthropicCreditEstimate(reading, daily, prices, now);

  const alerts = evaluateAlerts({ now, daily, snapshots, settings }).map((a: any) => {
    const state = alertState.find((s) => s.alert_key === a.key);
    return { ...a, emailedAt: state?.last_notified_at ?? null };
  });

  const db = snapshots['supabase.db_size_bytes'] ?? null;
  const conns = snapshots['supabase.db_connections'] ?? null;

  const resendAuto = resendAutomaticIsFresh(snapshots, now);
  const r2Auto = r2AutomaticIsFresh(snapshots, now);
  const manual = Object.entries(MANUAL_METERS)
    .filter(([id]) => id !== 'anthropic.credit_remaining_usd')
    // a fresh Resend API reading replaces the typed-in meter's card and form; they come back if the readings stop
    .filter(([id]) => !(id === 'resend.emails_used' && resendAuto))
    .filter(([id]) => !(id === 'cloudflare.r2_storage_gb' && r2Auto))
    .map(([id, meter]: [string, any]) => {
      const r = snapshots[id] ?? null;
      return {
        id,
        label: meter.label,
        unit: meter.unit,
        where: meter.where,
        refreshEveryDays: meter.refreshEveryDays ?? null,
        valueLabel: meter.valueLabel,
        limitLabel: meter.limitLabel,
        reading: r ? { value: Number(r.value), limit: r.limit_value === null ? null : Number(r.limit_value), capturedAt: r.captured_at, cycleStart: (r.detail?.cycle_start as string) ?? null, cycleEnd: (r.detail?.cycle_end as string) ?? null, staleForCycle: r.detail?.stale_for_cycle === true, planStale: r.detail?.plan_stale === true, planCapturedAt: (r.detail?.plan_captured_at as string) ?? null } : null,
        kind: meter.kind,
        level: r && isPositiveNumber(Number(r.limit_value)) && r.detail?.stale_for_cycle !== true ? (meter.kind === 'remaining' ? levelForRemaining(Number(r.value), Number(r.limit_value)) : levelForUsed(Number(r.value), Number(r.limit_value))) : null,
      };
    });

  const canConfigure = roleHasCapability('usage', auth.staff.role, 'configure');
  const creditMeter = MANUAL_METERS['anthropic.credit_remaining_usd'] as any;

  return jsonResponse({
    generatedAt: now.toISOString(),
    schedule: { collectorEveryHours: COLLECTOR_EVERY_HOURS, nextCollectorRunAt: nextCollectorRun(now).toISOString() },
    canConfigure,
    alerts,
    anthropic: {
      pricesSet: Boolean(prices),
      today: { ...tokens(today, today), costUsd: cost(today, today), errors: count('anthropic', 'errors', today, today) },
      last7: { ...tokens(weekStart, today), costUsd: cost(weekStart, today), errors: count('anthropic', 'errors', weekStart, today) },
      month: { ...tokens(monthStart, today), costUsd: cost(monthStart, today) },
      billingErrorsRecent: count('anthropic', 'billing_errors', addDays(today, -1), today),
      chatCapHitsToday: count('anthropic', 'chat_cap_hits', today, today),
      searchFallbackCapHitsToday: count('anthropic', 'search_fallback_cap_hits', today, today),
      requestsSeries: series(daily, 'anthropic', 'requests', today, 14),
      credit: {
        meter: { id: 'anthropic.credit_remaining_usd', label: creditMeter.label, valueLabel: creditMeter.valueLabel, limitLabel: creditMeter.limitLabel, where: creditMeter.where, refreshEveryDays: creditMeter.refreshEveryDays ?? null },
        reading: reading
          ? { value: Number(reading.value), total: reading.limit_value === null ? null : Number(reading.limit_value), capturedAt: reading.captured_at, expiresOn: (reading.detail?.expires_on as string) ?? null }
          : null,
        estimate: estimate ? { remaining: estimate.remaining, spent: estimate.spent, total: estimate.total, level: estimate.level } : null,
        expiresInDays: typeof reading?.detail?.expires_on === 'string' ? daysUntilDate(reading.detail.expires_on as string, now) : null,
      },
    },
    gemini: {
      dailyLimit: settings.gemini_daily_requests ?? null,
      today: { requests: count('gemini', 'requests', today, today), quotaExhausted: count('gemini', 'quota_exhausted', today, today), errors: count('gemini', 'errors', today, today) },
      last7: { requests: count('gemini', 'requests', weekStart, today), quotaExhausted: count('gemini', 'quota_exhausted', weekStart, today), fallbacksToAnthropic: count('gemini', 'fallbacks_to_anthropic', weekStart, today) },
      month: { requests: count('gemini', 'requests', monthStart, today), inputTokens: count('gemini', 'input_tokens', monthStart, today), outputTokens: count('gemini', 'output_tokens', monthStart, today) },
      requestsSeries: series(daily, 'gemini', 'requests', today, 14),
    },
    supabase: {
      reading: db ? { bytes: Number(db.value), limitBytes: db.limit_value === null ? null : Number(db.limit_value), capturedAt: db.captured_at } : null,
      connections: conns ? { inUse: Number(conns.value), max: conns.limit_value === null ? null : Number(conns.limit_value), capturedAt: conns.captured_at, level: isPositiveNumber(Number(conns.limit_value)) ? levelForUsed(Number(conns.value), Number(conns.limit_value)) : null } : null,
      history: dbHistory.map((h) => ({ at: h.captured_at, bytes: Number(h.value) })),
    },
    resend: (() => {
      const read = (id: string) => {
        const r = snapshots[id];
        return r ? { used: Number(r.value), limit: r.limit_value === null ? null : Number(r.limit_value), capturedAt: r.captured_at, resetsAt: (r.detail?.resets_at as string) ?? null } : null;
      };
      const monthly = read('resend.emails_monthly');
      const daily = read('resend.emails_daily');
      const lvl = (x: { used: number; limit: number | null } | null) => (x && isPositiveNumber(x.limit) ? levelForUsed(x.used, x.limit as number) : null);
      return { fresh: resendAuto, ageDays: resendReadingAgeDays(snapshots, now), monthly: monthly && { ...monthly, level: lvl(monthly) }, daily: daily && { ...daily, level: lvl(daily) } };
    })(),
    r2: (() => {
      const r = snapshots['cloudflare.r2_storage_bytes'];
      const limit = r && r.limit_value !== null ? Number(r.limit_value) : null;
      return {
        fresh: r2Auto,
        reading: r ? { bytes: Number(r.value), limitBytes: limit, capturedAt: r.captured_at, objects: Number(r.detail?.objects ?? 0), buckets: Number(r.detail?.buckets ?? 0), level: isPositiveNumber(limit) ? levelForUsed(Number(r.value), limit as number) : null } : null,
      };
    })(),
    manual,
    settings: { anthropicPrices: prices, geminiDailyRequests: settings.gemini_daily_requests ?? null },
  });
}

// ---- domains --------------------------------------------------------------

// Looked up live from the registries' public RDAP service (the same source the
// daily GitHub Action uses), on its own route so a slow registry can never hold
// up the rest of the page. Cached for an hour per warm function instance.
const DOMAIN_TTL_MS = 60 * 60 * 1000;
let domainCache: { at: number; domains: unknown[] } | null = null;

async function handleDomains(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'usage', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (domainCache && Date.now() - domainCache.at < DOMAIN_TTL_MS) return jsonResponse({ domains: domainCache.domains, cached: true });

  const now = new Date();
  const domains = await Promise.all(
    (DEFAULT_DOMAINS as string[]).map(async (domain) => {
      try {
        const info = await lookupDomain(domain, { timeoutMs: 4000 });
        return { domain, expiresOn: info.expiresAt!.toISOString().slice(0, 10), daysLeft: daysUntil(info.expiresAt!, now), registrar: info.registrar };
      } catch (err) {
        console.warn('[usage-admin] domain lookup failed', domain, err);
        return { domain, error: 'Could not check right now' };
      }
    }),
  );
  // Only cache a fully successful round, so a transient failure isn't shown for an hour.
  if (domains.every((d: any) => !d.error)) domainCache = { at: Date.now(), domains };
  return jsonResponse({ domains, cached: false });
}

// ---- changes (admins) -----------------------------------------------------

const MAX_BODY_BYTES = 4_000;

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function handleReading(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'usage', 'configure');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const body = await readBody(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);

  const meter = typeof body.meter === 'string' && Object.prototype.hasOwnProperty.call(MANUAL_METERS, body.meter) ? (MANUAL_METERS as Record<string, any>)[body.meter] : null;
  if (!meter) return jsonResponse({ error: 'Unknown reading' }, 400);

  const value = num(body.value);
  const limit = num(body.limit);
  if (value === null || value < 0 || value > 1e9) return jsonResponse({ error: 'Enter the current figure as a number' }, 400);
  if (limit === null || limit <= 0 || limit > 1e9) return jsonResponse({ error: 'Enter the limit as a number above zero' }, 400);

  const detail: Record<string, unknown> = { source: 'manual', by: auth.staff.id };
  if (body.expiresOn !== undefined && body.expiresOn !== null && body.expiresOn !== '') {
    const iso = typeof body.expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expiresOn) ? body.expiresOn : null;
    const time = iso ? new Date(`${iso}T00:00:00Z`).getTime() : NaN;
    const now = Date.now();
    if (!meter.supportsExpiry || !iso || Number.isNaN(time) || time < now - 400 * 86_400_000 || time > now + 5 * 365 * 86_400_000) {
      return jsonResponse({ error: 'That expiry date is not valid' }, 400);
    }
    detail.expires_on = iso;
  }

  // Logged before it is written, and refused if the log can't be written.
  try {
    await logStaffAction({ actorId: auth.staff.id, action: 'usage.reading_recorded', module: 'usage', detail: { meter: body.meter, value, limit } });
  } catch (err) {
    console.error('[usage-admin] audit log failed; refusing to record reading', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  try {
    await rest('/usage_snapshots', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ service: meter.service, metric: meter.metric, value, unit: meter.unit, limit_value: limit, detail }),
    });
  } catch (err) {
    console.error('[usage-admin] failed to record reading', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleSettings(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'usage', 'configure');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const body = await readBody(req);
  if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);

  // key -> new value, or null to remove the setting.
  const changes: Record<string, unknown> = {};

  if ('anthropicPrices' in body) {
    const p = body.anthropicPrices as { input?: unknown; output?: unknown } | null;
    if (p === null) changes.anthropic_prices = null;
    else {
      const input = num(p?.input);
      const output = num(p?.output);
      if (input === null || output === null || input <= 0 || output <= 0 || input > 10_000 || output > 10_000) {
        return jsonResponse({ error: 'Enter both prices in USD per million tokens' }, 400);
      }
      changes.anthropic_prices = { input, output };
    }
  }
  if ('geminiDailyRequests' in body) {
    const n = body.geminiDailyRequests;
    if (n === null) changes.gemini_daily_requests = null;
    else if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 100_000_000) changes.gemini_daily_requests = n;
    else return jsonResponse({ error: 'Enter the daily request limit as a whole number' }, 400);
  }
  if (Object.keys(changes).length === 0) return jsonResponse({ error: 'Nothing to change' }, 400);

  try {
    await logStaffAction({ actorId: auth.staff.id, action: 'usage.settings_changed', module: 'usage', detail: { keys: Object.keys(changes) } });
  } catch (err) {
    console.error('[usage-admin] audit log failed; refusing to change settings', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        await rest(`/usage_settings?key=eq.${key}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } else {
        await rest('/usage_settings?on_conflict=key', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ key, value, updated_at: new Date().toISOString(), updated_by: auth.staff.id }]),
        });
      }
    }
  } catch (err) {
    console.error('[usage-admin] failed to save settings', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true });
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/usage-admin/overview' && req.method === 'GET') return handleOverview(req);
  if (pathname === '/api/usage-admin/domains' && req.method === 'GET') return handleDomains(req);
  if (pathname === '/api/usage-admin/reading' && req.method === 'POST') return handleReading(req);
  if (pathname === '/api/usage-admin/settings' && req.method === 'POST') return handleSettings(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/usage-admin/overview', '/api/usage-admin/domains', '/api/usage-admin/reading', '/api/usage-admin/settings'],
};
