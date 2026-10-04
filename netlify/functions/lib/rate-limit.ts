// Shared rate limiting for the public, unauthenticated LLM endpoints
// (chat.mts, search-ai.mts). Every valid request to those costs an LLM call,
// so two independent guards are used: a per-IP fixed window (one abusive
// client) and a global daily cap (many distinct IPs, each individually under
// the per-IP limit). State lives in Netlify Blobs; there is no
// retry-on-conflict, so an occasional lost increment under real traffic just
// makes a limit marginally looser, never stricter.
import { getStore } from '@netlify/blobs';

interface RateLimitRecord {
  count: number;
  windowStart: number;
}

export function clientIp(req: Request): string {
  return req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

// Returns false once `ip` has made `max` requests inside the current window.
export async function checkIpRateLimit(storeName: string, ip: string, windowMs: number, max: number): Promise<boolean> {
  const store = getStore(storeName);
  const now = Date.now();
  const key = `ip:${ip}`;
  const record = (await store.get(key, { type: 'json' })) as RateLimitRecord | null;

  if (record && now - record.windowStart < windowMs) {
    if (record.count >= max) return false;
    await store.setJSON(key, { count: record.count + 1, windowStart: record.windowStart });
    return true;
  }

  await store.setJSON(key, { count: 1, windowStart: now });
  return true;
}

// Returns false once `name` has been counted `cap` times today (UTC). The key
// is date-scoped, so it resets on its own and there is nothing to prune.
export async function checkDailyCap(storeName: string, name: string, cap: number): Promise<boolean> {
  const store = getStore(storeName);
  const key = `${name}:${new Date().toISOString().slice(0, 10)}`;
  const count = ((await store.get(key, { type: 'json' })) as number | null) ?? 0;
  if (count >= cap) return false;
  await store.setJSON(key, count + 1);
  return true;
}
