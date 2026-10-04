// Records how much of a metered service (Anthropic, Gemini, ...) a request
// used, as running per-day totals in Supabase (usage_daily, via the
// usage_record() function — supabase/migrations/0030_usage_metering.sql).
// These are our own counts, kept because neither an individual Anthropic
// account nor the Gemini free tier offers a usage API we could read instead.
//
// Metering must never break the request it is measuring: every failure
// (Supabase down, migration not yet applied, missing env var) is logged and
// swallowed, and the call is cut off after a couple of seconds.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';

const TIMEOUT_MS = 2_000;

export async function recordUsage(service: string, metrics: Record<string, number | undefined>): Promise<void> {
  const clean: Record<string, number> = {};
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) clean[name] = value;
  }
  if (Object.keys(clean).length === 0) return;

  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/usage_record`, {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify({ p_service: service, p_metrics: clean }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error('[usage-meter] usage_record failed', res.status, await res.text());
  } catch (err) {
    console.error('[usage-meter] could not record usage', err);
  }
}
