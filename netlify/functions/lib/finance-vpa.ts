// What Razorpay says a UPI ID is registered to, kept in fin_vpa_names (supabase/migrations/0102_finance_vpa_names.sql) so each ID is asked about
// once. Shared by the ledger's lookup (finance-ledger.ts) and by verifying a party's UPI details (finance-parties.ts, method `razorpay_vpa`).
// The call is billed by Razorpay and only live-key answers are used; the UPI ID and the name never go into the audit log.
import { rest } from './staff-mfa-store';
import { razorpayKeyMode, validateVpa, type VpaLookup } from './razorpay';
import { nameFromLookup } from '../../../scripts/lib/finance-vpa.mjs';

type Json = Record<string, any>;

/** Why a lookup call failed, in words for an admin. A 400 "not found" is Razorpay's way of saying the call is not enabled on the account. */
export function vpaFailureText(got: Extract<VpaLookup, { ok: false }>): string {
  return got.status === 400 && /not found/i.test(got.description) ? 'Razorpay says its UPI ID lookup is not available on this account.' : got.description;
}

/** Keep one answer (insert or replace). `name` is only kept for an ID that exists. */
export async function keepVpaAnswer(vpa: string, body: { success?: boolean; customer_name?: string }, actorId: string): Promise<string | null> {
  const name = nameFromLookup(body);
  await rest('/fin_vpa_names?on_conflict=vpa', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ vpa, success: body.success === true, name, key_mode: razorpayKeyMode(), checked_by: actorId, checked_at: new Date().toISOString() }),
  });
  return name;
}

/**
 * The registered name behind one UPI ID: the live answer already kept, otherwise one call to Razorpay (which is then kept). `name` is null with
 * an `error` in words when there is none: no live keys, the call failed, the ID does not exist, or it has no bank-account name.
 */
export async function registeredNameOf(vpa: string, actorId: string): Promise<{ name: string | null; error: string | null }> {
  const kept = (await (await rest(`/fin_vpa_names?vpa=eq.${encodeURIComponent(vpa)}&key_mode=eq.live&select=success,name&limit=1`)).json()) as Json[];
  const none = { name: null, error: 'Razorpay has no registered name for this UPI ID, so it cannot be verified this way.' };
  if (kept[0]) return kept[0].success && kept[0].name ? { name: kept[0].name as string, error: null } : none;
  if (razorpayKeyMode() !== 'live') return { name: null, error: 'Razorpay lookups need the live keys, which this server is not using.' };
  const got = await validateVpa(vpa);
  if (!got.ok) return { name: null, error: vpaFailureText(got) };
  const name = await keepVpaAnswer(vpa, got.body, actorId);
  return name ? { name, error: null } : none;
}
