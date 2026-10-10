// Loads everything the usage rules need from Supabase (the tables from
// migrations 0030/0031) in one place, shared by usage-admin.mts (the
// dashboard's API) and usage-alerts.mts (the hourly email check) so the page
// and the emails are computed from exactly the same inputs.
import { MANUAL_METERS, addDays, mergeNetlifyPlan, utcDay } from '../../../scripts/lib/usage-rules.mjs';
import { rest } from './staff-mfa-store';

export type DailyRow = { day: string; service: string; metric: string; value: number };
export type Snapshot = { value: number; limit_value: number | null; unit: string; captured_at: string; detail: Record<string, unknown> | null };
export type AlertState = { alert_key: string; level: 'warn' | 'critical'; first_notified_at: string; last_notified_at: string };

export type UsageData = {
  daily: DailyRow[];
  // keyed "service.metric", the latest reading of each
  snapshots: Record<string, Snapshot>;
  dbHistory: { value: number; captured_at: string }[];
  settings: { anthropic_prices?: { input: number; output: number }; gemini_daily_requests?: number };
  alertState: AlertState[];
};

// The measured meter (Supabase size) plus every typed-in one.
const SNAPSHOT_METERS: [string, string][] = [['supabase', 'db_size_bytes'], ['netlify', 'plan_credits'], ['resend', 'emails_monthly'], ['resend', 'emails_daily'], ...Object.values(MANUAL_METERS).map((m): [string, string] => [m.service, m.metric])];

async function json<T>(path: string): Promise<T> {
  return (await (await rest(path)).json()) as T;
}

// Daily rows go back 35 days: enough for "this month" (up to 31 days) and the
// 14-day charts. Row count stays small: one row per day per metric.
export async function loadUsageData(now: Date): Promise<UsageData> {
  const since = addDays(utcDay(now), -35);
  const [daily, settingsRows, alertState, dbHistory, ...latest] = await Promise.all([
    json<DailyRow[]>(`/usage_daily?day=gte.${since}&select=day,service,metric,value&order=day.asc&limit=5000`),
    json<{ key: string; value: unknown }[]>('/usage_settings?select=key,value'),
    json<AlertState[]>('/usage_alert_state?select=alert_key,level,first_notified_at,last_notified_at'),
    json<{ value: number; captured_at: string }[]>('/usage_snapshots?service=eq.supabase&metric=eq.db_size_bytes&select=value,captured_at&order=captured_at.desc&limit=120'),
    ...SNAPSHOT_METERS.map(([service, metric]) =>
      json<Snapshot[]>(`/usage_snapshots?service=eq.${service}&metric=eq.${metric}&select=value,limit_value,unit,captured_at,detail&order=captured_at.desc&limit=1`),
    ),
  ]);

  const snapshots: Record<string, Snapshot> = {};
  SNAPSHOT_METERS.forEach(([service, metric], i) => {
    const row = latest[i][0];
    if (row) snapshots[`${service}.${metric}`] = row;
  });

  const settings: UsageData['settings'] = {};
  for (const { key, value } of settingsRows) {
    if (key === 'anthropic_prices') settings.anthropic_prices = value as { input: number; output: number };
    if (key === 'gemini_daily_requests') settings.gemini_daily_requests = value as number;
  }

  return { daily, snapshots, dbHistory: dbHistory.reverse(), settings, alertState };
}
