// Netlify scheduled function (every 6 hours, no HTTP path) — appends a
// reading of the Supabase database size to usage_snapshots, for the
// free-tier usage dashboard. It reuses the Supabase credentials the other
// functions already hold, so no new secret exists anywhere for it.
//
// This only *records*. Turning readings into threshold emails is the
// dashboard module's job; and anything that must still alert while Netlify
// itself is paused (domain renewals) deliberately lives in a GitHub Action
// instead — see .github/workflows/domain-expiry.yml.
import { restHeaders } from '../../scripts/lib/supabase.mjs';

// Supabase free plan: 500 MB of database per project. From supabase.com/pricing;
// the Supabase dashboard is the authority if this ever drifts.
const DB_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;

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

    return new Response(JSON.stringify({ ok: true, bytes }), { status: 200 });
  } catch (err) {
    console.error('[usage-collect] failed', err);
    return new Response('Failed to record usage snapshot', { status: 500 });
  }
};

export const config = {
  schedule: '0 */6 * * *',
};
