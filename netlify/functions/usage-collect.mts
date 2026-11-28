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
// And Cloudflare R2 storage (current bytes across all buckets) from Cloudflare's GraphQL
// analytics API, using a read-only token (Account Analytics: Read) in CLOUDFLARE_ANALYTICS_TOKEN
// plus the non-secret CLOUDFLARE_ACCOUNT_ID. Without them the typed-in R2 reading carries on.
// The same token also reads today's Workers requests and D1 rows read and written (the admin rebuild runs on both).
//
// And the number of open database connections (usage_db_connections(), migration 0033) against
// the plan's max_connections, as an early warning that the Netlify functions are hogging the pool.
//
// This only *records*. Turning readings into threshold emails is the
// dashboard module's job; and anything that must still alert while Netlify
// itself is paused (domain renewals) deliberately lives in a GitHub Action
// instead — see .github/workflows/domain-expiry.yml.
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { NETLIFY_CREDITS_PER_PRODUCTION_DEPLOY } from '../../scripts/lib/usage-rules.mjs';

// Supabase free plan: 500 MB of database per project. From supabase.com/pricing;
// the Supabase dashboard is the authority if this ever drifts.
const DB_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;

// Records open database connections vs the plan's maximum. Never throws.
async function recordDbConnections(base: string): Promise<string> {
  try {
    const res = await fetch(`${base}/rpc/usage_db_connections`, { method: 'POST', headers: restHeaders(), body: '{}' });
    if (!res.ok) throw new Error(`usage_db_connections failed: ${res.status} ${await res.text()}`);
    const row = (await res.json())?.[0];
    const inUse = Number(row?.in_use);
    const max = Number(row?.max_allowed);
    if (!Number.isFinite(inUse) || !(max > 0)) throw new Error(`unexpected connections reading: ${JSON.stringify(row)}`);
    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ service: 'supabase', metric: 'db_connections', value: inUse, unit: 'connections', limit_value: max }),
    });
    if (!insertRes.ok) throw new Error(`connections snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${inUse}/${max}`;
  } catch (err) {
    console.error('[usage-collect] db connections failed', err);
    return 'failed';
  }
}

// Records the biggest tables (usage_db_tables(), migration 0058) so a growing database can be
// traced to what is filling it. Never throws, and skips quietly until the migration is applied.
async function recordDbTables(base: string): Promise<string> {
  try {
    const res = await fetch(`${base}/rpc/usage_db_tables`, { method: 'POST', headers: restHeaders(), body: '{}' });
    if (!res.ok) throw new Error(`usage_db_tables failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as { table_name: string; total_bytes: number | string; row_estimate: number | string }[];
    const tables = rows
      .map((r) => ({ name: String(r.table_name), bytes: Number(r.total_bytes), rows: Number(r.row_estimate) }))
      .filter((t) => t.name && Number.isFinite(t.bytes) && t.bytes >= 0);
    if (tables.length === 0) throw new Error('usage_db_tables returned no tables');
    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        service: 'supabase',
        metric: 'db_tables',
        value: tables.reduce((sum, t) => sum + t.bytes, 0),
        unit: 'bytes',
        detail: { tables },
      }),
    });
    if (!insertRes.ok) throw new Error(`tables snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${tables.length}`;
  } catch (err) {
    console.error('[usage-collect] db tables failed', err);
    return 'failed';
  }
}

// TVC team's id on Netlify (not a secret; from `netlify api getAccount`).
const NETLIFY_ACCOUNT_ID = '6a58597d0f1acc4a465937b6';

// Records the plan's credit allowance and billing cycle, and hands back the account so the
// deploy count below can use the same cycle dates. Never throws: the Supabase reading above is
// the primary job and must not fail because of it.
async function recordNetlifyPlan(base: string): Promise<{ result: string; account: Record<string, any> | null }> {
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!token) return { result: 'skipped (no NETLIFY_ACCESS_TOKEN)', account: null };
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
    return { result: 'recorded', account };
  } catch (err) {
    console.error('[usage-collect] netlify plan failed', err);
    return { result: 'failed', account: null };
  }
}

// The site this runs on (Netlify sets SITE_ID in functions); the literal is the fallback.
const NETLIFY_SITE_ID = process.env.SITE_ID || '7d747fcb-70bf-415d-8263-8b652e6bbf0a';

// What the billing cycle's deploys and builds have been, from the same token. Netlify's API reports
// no credits used, but production deploys cost a flat 15 credits each (failed ones, rollbacks and deploy
// previews are free), so that part can be counted exactly; bandwidth, functions and requests cannot.
// Stored as a snapshot whose value is the credits spent on deploys. Counts and timings only: no commit
// messages, titles, branches or authors. Never throws, like recordNetlifyPlan.
async function recordNetlifyActivity(base: string, account: Record<string, any> | null): Promise<string> {
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!token || !account) return 'skipped';
  try {
    const periodStart: string | undefined = account.current_billing_period_start;
    if (!periodStart) throw new Error('netlify account has no billing period start');
    const startMs = new Date(periodStart).getTime();
    const headers = { Authorization: `Bearer ${token}` };

    // Newest first, until a deploy older than the cycle (5 pages of 100 is a safety cap).
    let ok = 0;
    let failed = 0;
    let previews = 0;
    let deploySeconds = 0;
    let timed = 0;
    let last: { state: string; context: string; at: string } | null = null;
    paging: for (let page = 1; page <= 5; page++) {
      const res = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys?per_page=100&page=${page}`, { headers });
      if (!res.ok) throw new Error(`netlify deploys fetch failed: ${res.status}`);
      const deploys = (await res.json()) as { state: string; context: string; created_at: string; deploy_time?: number | null }[];
      for (const d of deploys) {
        if (new Date(d.created_at).getTime() < startMs) break paging;
        last ??= { state: d.state, context: d.context, at: d.created_at };
        if (d.context !== 'production') previews++;
        else if (d.state === 'ready') {
          ok++;
          if (Number.isFinite(Number(d.deploy_time)) && Number(d.deploy_time) > 0) {
            deploySeconds += Number(d.deploy_time);
            timed++;
          }
        } else if (d.state === 'error') failed++;
      }
      if (deploys.length < 100) break;
    }

    // Build minutes are a separate, best-effort read: losing them must not lose the deploy count.
    let buildMinutes: { current: number; previous: number } | null = null;
    try {
      const res = await fetch(`https://api.netlify.com/api/v1/${NETLIFY_ACCOUNT_ID}/builds/status`, { headers });
      if (res.ok) {
        const m = (await res.json())?.minutes;
        if (Number.isFinite(Number(m?.current))) buildMinutes = { current: Number(m.current), previous: Number(m.previous ?? 0) };
      }
    } catch {
      // keep the deploy count
    }

    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        service: 'netlify',
        metric: 'deploy_activity',
        value: ok * NETLIFY_CREDITS_PER_PRODUCTION_DEPLOY,
        unit: 'credits',
        detail: {
          source: 'netlify-api',
          period_start: periodStart,
          production_ok: ok,
          production_failed: failed,
          previews,
          avg_deploy_seconds: timed ? Math.round(deploySeconds / timed) : null,
          build_minutes: buildMinutes,
          last_deploy: last,
        },
      }),
    });
    if (!insertRes.ok) throw new Error(`netlify activity insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${ok} production, ${previews} previews`;
  } catch (err) {
    console.error('[usage-collect] netlify activity failed', err);
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

// R2's free tier: 10 GB-month of storage (cloudflare.com/r2 pricing; the Cloudflare dashboard is
// the authority). Cloudflare counts a GB as 10^9 bytes, so the limit is kept in bytes to match.
const R2_FREE_STORAGE_BYTES = 10_000_000_000;

const R2_STORAGE_QUERY = `query R2Storage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize }
      dimensions { datetime bucketName }
    }
  } }
}`;

// Records total R2 storage right now (the newest data point of each bucket, summed). Never throws.
async function recordR2Storage(base: string): Promise<string> {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return 'skipped (no CLOUDFLARE_ANALYTICS_TOKEN / CLOUDFLARE_ACCOUNT_ID)';
  try {
    const now = new Date();
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: R2_STORAGE_QUERY, variables: { accountTag: accountId, start: new Date(now.getTime() - 3 * 86_400_000).toISOString(), end: now.toISOString() } }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) throw new Error(`cloudflare graphql failed: ${res.status} ${JSON.stringify(body?.errors ?? null).slice(0, 300)}`);
    const groups: any[] = body?.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
    // Rows are newest first: keep each bucket's most recent data point and add them up.
    const latest = new Map<string, any>();
    for (const g of groups) if (!latest.has(g.dimensions.bucketName)) latest.set(g.dimensions.bucketName, g.max);
    if (latest.size === 0) throw new Error('cloudflare returned no R2 storage data');
    let bytes = 0;
    let objects = 0;
    for (const m of latest.values()) {
      bytes += Number(m.payloadSize) + Number(m.metadataSize);
      objects += Number(m.objectCount);
    }
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`unexpected R2 size: ${bytes}`);
    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ service: 'cloudflare', metric: 'r2_storage_bytes', value: bytes, unit: 'bytes', limit_value: R2_FREE_STORAGE_BYTES, detail: { source: 'cloudflare-graphql', buckets: latest.size, objects } }),
    });
    if (!insertRes.ok) throw new Error(`r2 snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${bytes} bytes`;
  } catch (err) {
    console.error('[usage-collect] r2 storage failed', err);
    return 'failed';
  }
}

// Workers and D1 free tiers, per UTC day (developers.cloudflare.com/workers/platform/pricing, /d1/platform/pricing; the
// Cloudflare dashboard is the authority). Counted from 00:00 UTC to now, which is when Cloudflare resets them, so the
// 00:00 run reads near zero and the 18:00 run is the day's last full picture.
const WORKERS_FREE_REQUESTS_PER_DAY = 100_000;
const D1_FREE_ROWS_READ_PER_DAY = 5_000_000;
const D1_FREE_ROWS_WRITTEN_PER_DAY = 100_000;

const WORKERS_D1_QUERY = `query WorkersD1($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors }
      dimensions { scriptName }
    }
    d1AnalyticsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { rowsRead rowsWritten }
      dimensions { databaseId }
    }
  } }
}`;

// Records today's Workers requests and D1 rows read and written, summed over every Worker and database on the account
// (the free tiers are per account). Never throws: a failure here must not stop the other readings.
async function recordWorkersD1Usage(base: string): Promise<string> {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return 'skipped (no CLOUDFLARE_ANALYTICS_TOKEN / CLOUDFLARE_ACCOUNT_ID)';
  try {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: WORKERS_D1_QUERY, variables: { accountTag: accountId, start: dayStart.toISOString(), end: now.toISOString() } }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) throw new Error(`cloudflare graphql failed: ${res.status} ${JSON.stringify(body?.errors ?? null).slice(0, 300)}`);
    const account = body?.data?.viewer?.accounts?.[0];
    const workers: any[] = account?.workersInvocationsAdaptive ?? [];
    const d1: any[] = account?.d1AnalyticsAdaptiveGroups ?? [];
    const requests = workers.reduce((n, g) => n + Number(g.sum?.requests ?? 0), 0);
    const errors = workers.reduce((n, g) => n + Number(g.sum?.errors ?? 0), 0);
    const rowsRead = d1.reduce((n, g) => n + Number(g.sum?.rowsRead ?? 0), 0);
    const rowsWritten = d1.reduce((n, g) => n + Number(g.sum?.rowsWritten ?? 0), 0);
    for (const v of [requests, rowsRead, rowsWritten]) if (!Number.isFinite(v) || v < 0) throw new Error(`unexpected Cloudflare figure: ${v}`);
    const day = dayStart.toISOString().slice(0, 10);
    const rows = [
      { service: 'cloudflare', metric: 'workers_requests_daily', value: requests, unit: 'requests', limit_value: WORKERS_FREE_REQUESTS_PER_DAY, detail: { source: 'cloudflare-graphql', day, workers: new Set(workers.map((g) => g.dimensions?.scriptName)).size, errors } },
      { service: 'cloudflare', metric: 'd1_rows_read_daily', value: rowsRead, unit: 'rows', limit_value: D1_FREE_ROWS_READ_PER_DAY, detail: { source: 'cloudflare-graphql', day, databases: d1.length } },
      { service: 'cloudflare', metric: 'd1_rows_written_daily', value: rowsWritten, unit: 'rows', limit_value: D1_FREE_ROWS_WRITTEN_PER_DAY, detail: { source: 'cloudflare-graphql', day, databases: d1.length } },
    ];
    const insertRes = await fetch(`${base}/usage_snapshots`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows) });
    if (!insertRes.ok) throw new Error(`workers/d1 snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${requests} requests, ${rowsRead} rows read, ${rowsWritten} rows written`;
  } catch (err) {
    console.error('[usage-collect] workers/d1 usage failed', err);
    return 'failed';
  }
}

// D1 storage: the free tier is 5 GB across the account's databases (developers.cloudflare.com/d1/platform/pricing; the
// dashboard is the authority). A level, not a daily count, so it is read like R2 storage: the newest point per database.
const D1_FREE_STORAGE_BYTES = 5_000_000_000;

const D1_STORAGE_QUERY = `query D1Storage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      max { databaseSizeBytes }
      dimensions { datetime databaseId }
    }
  } }
}`;

// Records total D1 storage right now (the newest data point of each database, summed). Never throws.
async function recordD1Storage(base: string): Promise<string> {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return 'skipped (no CLOUDFLARE_ANALYTICS_TOKEN / CLOUDFLARE_ACCOUNT_ID)';
  try {
    const now = new Date();
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: D1_STORAGE_QUERY, variables: { accountTag: accountId, start: new Date(now.getTime() - 3 * 86_400_000).toISOString(), end: now.toISOString() } }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) throw new Error(`cloudflare graphql failed: ${res.status} ${JSON.stringify(body?.errors ?? null).slice(0, 300)}`);
    const groups: any[] = body?.data?.viewer?.accounts?.[0]?.d1StorageAdaptiveGroups ?? [];
    // Rows are newest first: keep each database's most recent data point and add them up.
    const latest = new Map<string, number>();
    for (const g of groups) if (!latest.has(g.dimensions.databaseId)) latest.set(g.dimensions.databaseId, Number(g.max?.databaseSizeBytes));
    if (latest.size === 0) throw new Error('cloudflare returned no D1 storage data');
    const bytes = [...latest.values()].reduce((n, v) => n + v, 0);
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`unexpected D1 size: ${bytes}`);
    const insertRes = await fetch(`${base}/usage_snapshots`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ service: 'cloudflare', metric: 'd1_storage_bytes', value: bytes, unit: 'bytes', limit_value: D1_FREE_STORAGE_BYTES, detail: { source: 'cloudflare-graphql', databases: latest.size } }),
    });
    if (!insertRes.ok) throw new Error(`d1 storage snapshot insert failed: ${insertRes.status} ${await insertRes.text()}`);
    return `recorded ${bytes} bytes`;
  } catch (err) {
    console.error('[usage-collect] d1 storage failed', err);
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

    const connections = await recordDbConnections(base);
    const tables = await recordDbTables(base);
    const netlifyPlan = await recordNetlifyPlan(base);
    const netlifyActivity = await recordNetlifyActivity(base, netlifyPlan.account);
    const resend = await recordResendUsage(base);
    const r2 = await recordR2Storage(base);
    const workersD1 = await recordWorkersD1Usage(base);
    const d1Storage = await recordD1Storage(base);
    return new Response(JSON.stringify({ ok: true, bytes, connections, tables, netlify: netlifyPlan.result, netlifyActivity, resend, r2, workersD1, d1Storage }), { status: 200 });
  } catch (err) {
    console.error('[usage-collect] failed', err);
    return new Response('Failed to record usage snapshot', { status: 500 });
  }
};

export const config = {
  schedule: '0 */6 * * *',
};
