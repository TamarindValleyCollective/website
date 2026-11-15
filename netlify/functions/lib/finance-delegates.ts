// Delegates of the UPI circle (migration 0100, docs/finance/FINANCE.md "Delegates"): who a delegated payment belongs to.
// Adding or changing a delegate needs `configure` (admin); picking the delegate for a payment the dates cannot decide needs
// `allocate`, the same as filling in a ledger line. Every change is written to fin_audit_log first, with counts and field
// names only: never the delegate's number or name. The rules are in scripts/lib/finance-delegates.mjs.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { validateDelegate } from '../../../scripts/lib/finance-delegates.mjs';

type Json = Record<string, any>;
export type Delegate = { id: string; identifier: string; displayName: string | null; activeFrom: string; activeTo: string | null; capPaise: number | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPI_REF = /^[0-9]{12}$/;
const MAX_ASSIGN = 500;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function entityId(): Promise<string> {
  const e = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json()) as Json[];
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}

const shape = (r: Json): Delegate => ({ id: r.id, identifier: r.identifier, displayName: r.display_name ?? null, activeFrom: r.active_from, activeTo: r.active_to ?? null, capPaise: r.cap_paise === null || r.cap_paise === undefined ? null : Number(r.cap_paise) });

// A handful of rows at most (one per person in the circle).
export async function loadDelegates(): Promise<Delegate[]> {
  const rows = (await (await rest('/fin_delegates?select=id,identifier,display_name,active_from,active_to,cap_paise&order=active_from.asc,created_at.asc&limit=200')).json()) as Json[];
  return rows.map(shape);
}

// Every explicit pick, as UPI reference -> delegate id. Paged: the database returns at most 1,000 rows a request.
export async function loadDelegateLinks(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 1000) {
    const page = (await (await rest(`/fin_upi_delegate_links?select=upi_ref,delegate_id&order=upi_ref.asc&limit=1000&offset=${offset}`)).json()) as Json[];
    for (const r of page) out.set(r.upi_ref as string, r.delegate_id as string);
    if (page.length < 1000) return out;
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

const columns = (v: Json) => ({
  ...(v.identifier ? { identifier: v.identifier } : {}),
  display_name: v.displayName,
  active_from: v.activeFrom,
  active_to: v.activeTo,
  cap_paise: v.capPaise,
});

// POST /delegates (add) and PATCH /delegates/:id (edit: the number cannot change).
export async function saveDelegate(req: Request, id: string | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const b = await readBody(req);
  if (!b) return json({ error: 'Send the details as JSON.' }, 400);
  const checked = validateDelegate(b, { create: id === null });
  if (checked.error || !checked.value) return json({ error: checked.error ?? 'Check the details.' }, 400);
  try {
    const entity = await entityId();
    if (id) {
      const found = (await (await rest(`/fin_delegates?id=eq.${id}&select=id`)).json()) as Json[];
      if (!found[0]) return json({ error: 'No such delegate.' }, 404);
    }
    await logFinanceAction({
      actorId: auth.staff.id,
      entityId: entity,
      action: id ? 'finance.delegate_updated' : 'finance.delegate_added',
      target: id ?? undefined,
      detail: { named: checked.value.displayName !== null, ended: checked.value.activeTo !== null, hasLimit: checked.value.capPaise !== null },
    });
    const res = id
      ? await rest(`/fin_delegates?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...columns(checked.value), updated_at: new Date().toISOString() }) })
      : await rest('/fin_delegates', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, ...columns(checked.value), created_by: auth.staff.id }) });
    if (res.status === 409) return json({ error: 'A delegate with that number already exists.' }, 409);
    const [saved] = (await res.json()) as Json[];
    return json({ delegate: shape(saved) }, id ? 200 : 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return json({ error: 'A delegate with that number already exists.' }, 409);
    console.error('[finance-delegates] save failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}

// POST /delegates/assign { delegateId, upiRefs: [...] }: pick the delegate for payments the dates cannot decide. A null
// delegateId takes the picks back, so the dates decide again.
export async function assignDelegate(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const b = await readBody(req);
  const refs = Array.isArray(b?.upiRefs) ? [...new Set((b!.upiRefs as unknown[]).filter((r): r is string => typeof r === 'string'))] : [];
  if (!b || !refs.length || refs.length > MAX_ASSIGN || !refs.every((r) => UPI_REF.test(r))) return json({ error: `Choose between 1 and ${MAX_ASSIGN} payments.` }, 400);
  const delegateId = b.delegateId === null ? null : typeof b.delegateId === 'string' && UUID.test(b.delegateId) ? b.delegateId : undefined;
  if (delegateId === undefined) return json({ error: 'Choose the delegate.' }, 400);
  try {
    const entity = await entityId();
    if (delegateId) {
      const found = (await (await rest(`/fin_delegates?id=eq.${delegateId}&select=id`)).json()) as Json[];
      if (!found[0]) return json({ error: 'No such delegate.' }, 404);
    }
    await logFinanceAction({ actorId: auth.staff.id, entityId: entity, action: delegateId ? 'finance.delegate_assigned' : 'finance.delegate_unassigned', target: delegateId ?? undefined, detail: { payments: refs.length } });
    if (delegateId) {
      await rest('/fin_upi_delegate_links?on_conflict=entity_id,upi_ref', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(refs.map((upi_ref) => ({ entity_id: entity, upi_ref, delegate_id: delegateId, assigned_by: auth.staff.id, assigned_at: new Date().toISOString() }))),
      });
    } else {
      await rest(`/fin_upi_delegate_links?entity_id=eq.${entity}&upi_ref=in.(${refs.join(',')})`, { method: 'DELETE' });
    }
    return json({ ok: true, count: refs.length });
  } catch (err) {
    console.error('[finance-delegates] assign failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}
