// Netlify scheduled function (every 6 hours, no HTTP path) — appends a
// reading of the Supabase database size to usage_snapshots, for the
// free-tier usage dashboard. It reuses the Supabase credentials the other
// functions already hold, so no new secret exists anywhere for it.
//
// It also records Netlify's own plan allowance and billing-cycle dates when
// NETLIFY_ACCESS_TOKEN is set. Netlify's API exposes those but NOT credits used,
// so "used" stays a typed-in reading (see mergeNetlifyPlan in usage-rules.mjs).
//
// And Resend's own daily/monthly email quota from its Usage API (GET /usage). That endpoint
// refuses the site's sending-only RESEND_API_KEY (HTTP 401, confirmed 2026-10-10), so it uses a
// separate full-access key, RESEND_USAGE_API_KEY, kept apart so the sending key stays restricted
// and either can be revoked on its own. Without it the page keeps its typed-in Resend reading.
//
// This only *records*. Turning readings into threshold emails is the
// dashboard module's job; and anything that must still alert while Netlify
// itself is paused (domain renewals) deliberately lives in a GitHub Action
// instead — see .github/workflows/domain-expiry.yml.
import { restHeaders } from '../../scripts/lib/supabase.mjs';

// Supabase free plan: 500 MB of database per project. From supabase.com/pricing;
// the Supabase dashboard is the authority if this ever drifts.
const DB_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;

// TVC team's id on Netlify (not a secret; from `netlify api getAccount`).
const NETLIFY_ACCOUNT_ID = '6a58597d0f1acc4a465937b6';

// Records the plan's credit allowance and billing cycle. Never throws: the
// Supabase reading above is the primary job and must not fail because of it.
async function recordNetlifyPlan(base: string): Promise<string> {
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!token) return 'skipped (no NETLIFY_ACCESS_TOKEN)';
  try {
    const res = await fetch(`https://api.netlify.com/api/v1/accounts/${NETLIFY_ACCOUNT_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`netlify account fetch failed: ${res.status}`);
    const account = await res.json();
    const credits = Number(account.plan_credits);
    if (!Number.isFinite(credits) || credits <= 0) throw new Error(`unexpected plan_credits: ${account.plan_credits}`);
    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        service: 'netlify',
        metric: 'plan_credits',
        value: credits,
        unit: 'credits',
        limit_value: credits,
        detail: { source: 'netlify-api', period_start: account.current_billing_period_start ?? null, next_period_start: account.next_billing_period_start ?? null },
      }),
    });
    if (!insertRes.ok) throw new Error(`netlify snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return 'recorded';
  } catch (err) {
    console.error('[usage-collect] netlify plan failed', err);
    return 'failed';
  }
}

// Records Resend's email usage against its limits. Never throws, like recordNetlifyPlan.
async function recordResendUsage(base: string): Promise<string> {
  const key = process.env.RESEND_USAGE_API_KEY;
  if (!key) return 'skipped (no RESEND_USAGE_API_KEY)';
  try {
    const res = await fetch('https://api.resend.com/usage', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`resend usage fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`); // Resend's error text, e.g. "API key is invalid"; never contains our key
    const emails = (await res.json())?.emails ?? {};
    const rows = (['monthly', 'daily'] as const)
      .map((period) => ({ period, q: emails[period] }))
      // The daily quota only exists on the free plan; skip a period Resend doesn't report.
      .filter(({ q }) => q && Number.isFinite(Number(q.used)) && Number(q.limit) > 0)
      .map(({ period, q }) => ({
        service: 'resend',
        metric: `emails_${period}`,
        value: Number(q.used),
        unit: 'emails',
        limit_value: Number(q.limit),
        detail: { source: 'resend-api', resets_at: q.resets_at ?? null },
      }));
    if (rows.length === 0) throw new Error('resend usage had no quota figures');
    const insertRes = await fetch(`${base}/usage_snapshots`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows) });
    if (!insertRes.ok) throw new Error(`resend snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${rows.length}`;
  } catch (err) {
    console.error('[usage-collect] resend usage failed', err);
    return 'failed';
  }
}

export default async (): Promise<Response> => {
  const base = `${process.env.SUPABASE_URL}/rest/v1`;
  try {
    const sizeRes = await fetch(`${base}/rpc/usage_db_size`, {
      method: 'POST',
      headers: restHeaders(),
      body: '{}',
    });
    if (!sizeRes.ok) throw new Error(`usage_db_size failed: ${sizeRes.status} ${await sizeRes.text()}`);
    const bytes = Number(await sizeRes.json());
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`unexpected database size: ${bytes}`);

    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        service: 'supabase',
        metric: 'db_size_bytes',
        value: bytes,
        unit: 'bytes',
        limit_value: DB_SIZE_LIMIT_BYTES,
      }),
    });
    if (!insertRes.ok) throw new Error(`snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);

    const netlify = await recordNetlifyPlan(base);
    const resend = await recordResendUsage(base);
    return new Response(JSON.stringify({ ok: true, bytes, netlify, resend }), { status: 200 });
  } catch (err) {
    console.error('[usage-collect] failed', err);
    return new Response('Failed to record usage snapshot', { status: 500 });
  }
};

export const config = {
  schedule: '0 */6 * * *',
};
