// Append-only audit trail for the finance module (fin_audit_log, supabase/migrations/0077_finance_foundation.sql).
// Throws on failure so a caller doing something sensitive can refuse to proceed unlogged, like logStaffAction.
// `detail` is ids, counts and field names only: never account numbers, UPI IDs, names or amounts.
import { rest } from './staff-mfa-store';

export async function logFinanceAction(entry: {
  actorId: string;
  action: string;
  entityId?: string;
  target?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await rest('/fin_audit_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      actor_id: entry.actorId,
      action: entry.action,
      entity_id: entry.entityId ?? null,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
    }),
  });
}
