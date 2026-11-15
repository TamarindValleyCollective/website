// UPI operators (migration 0101, docs/finance/FINANCE.md "UPI operators"): the people whose UPI setup the account's UPI payments go out through.
// Adding or renaming one needs `configure` (admin). Every change is written to fin_audit_log first, with no name in it. Without the table
// (migration not applied yet) there are no operators and nothing here fails: the rest of the finance module works as before.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { validateOperatorName } from '../../../scripts/lib/finance-upi-operators.mjs';

type Json = Record<string, any>;
export type Operator = { id: string; name: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Every operator (a handful), or none when the table does not exist yet. */
export async function loadOperators(): Promise<Operator[]> {
  try {
    const rows = (await (await rest('/fin_upi_operators?select=id,display_name&order=created_at.asc&limit=50')).json()) as Json[];
    return Array.isArray(rows) ? rows.map((r) => ({ id: r.id as string, name: r.display_name as string })) : [];
  } catch {
    return [];
  }
}

async function readBody(req: Request): Promise<Json | null> {
  try {
    const b = (await req.json()) as Json;
    return b && typeof b === 'object' ? b : null;
  } catch {
    return null;
  }
}

// POST /upi-operators (add) and PATCH /upi-operators/:id (rename).
export async function saveOperator(req: Request, id: string | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const b = await readBody(req);
  if (!b) return json({ error: 'Send the details as JSON.' }, 400);
  const checked = validateOperatorName(b.name);
  if (checked.error || !checked.value) return json({ error: checked.error ?? 'Check the name.' }, 400);
  try {
    const entities = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json()) as Json[];
    if (!entities[0]) throw new Error('no entity');
    const existing = await loadOperators();
    if (id && !existing.some((o) => o.id === id)) return json({ error: 'No such operator.' }, 404);
    if (existing.some((o) => o.id !== id && o.name.toLowerCase() === checked.value!.toLowerCase())) return json({ error: 'There is already an operator with that name.' }, 409);
    await logFinanceAction({ actorId: auth.staff.id, entityId: entities[0].id, action: id ? 'finance.upi_operator_renamed' : 'finance.upi_operator_added', target: id ?? undefined, detail: { operators: existing.length + (id ? 0 : 1) } });
    const res = id
      ? await rest(`/fin_upi_operators?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ display_name: checked.value }) })
      : await rest('/fin_upi_operators', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entities[0].id, display_name: checked.value, created_by: auth.staff.id }) });
    const [saved] = (await res.json()) as Json[];
    return json({ operator: { id: saved.id, name: saved.display_name } }, id ? 200 : 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return json({ error: 'There is already an operator with that name.' }, 409);
    console.error('[finance-upi-operators] save failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}
