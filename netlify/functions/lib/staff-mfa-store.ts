// Reads of the second-factor tables (supabase/migrations/0029_staff_mfa.sql),
// shared by staff-mfa.mts (enrolment and verification) and the Access module's
// guard (lib/staff-admin-guard.ts), which needs to know whether a super admin
// has at least two different methods enrolled before it lets them change
// anything. Plain queries only, each against a single table.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';

export type Factor = {
  id: string;
  staff_id: string;
  type: 'totp' | 'passkey';
  label: string | null;
  secret_encrypted: string | null;
  confirmed_at: string | null;
  last_used_step: number | null;
};

export async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${base}/rest/v1${path}`, { ...init, headers: restHeaders(init.headers as Record<string, string>) });
  if (!res.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
  return res;
}

export async function getFactors(staffId: string): Promise<Factor[]> {
  const res = await rest(`/staff_mfa_factors?staff_id=eq.${staffId}&select=id,staff_id,type,label,secret_encrypted,confirmed_at,last_used_step&order=created_at.desc`);
  return (await res.json()) as Factor[];
}

export async function unusedRecoveryCodeCount(staffId: string): Promise<number> {
  const res = await rest(`/staff_recovery_codes?staff_id=eq.${staffId}&used_at=is.null&select=id`);
  return ((await res.json()) as unknown[]).length;
}

// Which methods a person has working right now. `ready` (two or more
// different methods) is the bar the Access module sets before it will let
// someone change access, so one lost phone can't strand a person with a single
// point of failure.
export async function mfaSummary(staffId: string) {
  const [factors, recoveryRemaining] = await Promise.all([getFactors(staffId), unusedRecoveryCodeCount(staffId)]);
  const totp = factors.some((f) => f.type === 'totp' && f.confirmed_at);
  const passkey = factors.some((f) => f.type === 'passkey' && f.confirmed_at);
  const recovery = recoveryRemaining > 0;
  const methodCount = [totp, recovery, passkey].filter(Boolean).length;
  return { factors, totp, passkey, recovery, recoveryRemaining, methodCount, ready: methodCount >= 2 };
}
