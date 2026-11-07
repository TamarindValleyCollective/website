// Notes on payments (fin_payment_notes, migration 0089): a description added beside what the bank or the UPI app said,
// shown and edited from both the ledger and the UPI page. One note per payment (scripts/lib/finance-notes.mjs). Changing one
// needs `allocate`, the same as filling in a ledger line; every change is written to fin_audit_log first (the length and
// whether it was cleared, never the text).
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { NOTE_KEY, validateNote } from '../../../scripts/lib/finance-notes.mjs';

type Json = Record<string, any>;
const PAGE = 1000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Every note, as key -> text. A few hundred at most; paged anyway (the database returns at most 1,000 rows a request).
export async function loadNotes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = (await (await rest(`/fin_payment_notes?select=key,note&order=key.asc&limit=${PAGE}&offset=${offset}`)).json()) as Json[];
    for (const r of page) out.set(r.key as string, r.note as string);
    if (page.length < PAGE) return out;
  }
}

export async function setPaymentNote(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  let body: Json | null = null;
  try {
    body = (await req.json()) as Json;
  } catch {
    /* handled below */
  }
  if (!body || typeof body.key !== 'string' || !NOTE_KEY.test(body.key)) return json({ error: 'Choose a payment.' }, 400);
  const checked = validateNote(body.note);
  if (checked.error) return json({ error: checked.error }, 400);
  try {
    const entity = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json()) as Json[];
    if (!entity[0]) throw new Error('no entity');
    // The audit entry comes first: the note does not change without a record that it was asked for.
    await logFinanceAction({
      actorId: auth.staff.id,
      entityId: entity[0].id as string,
      action: 'finance.payment_note_set',
      target: body.key,
      detail: { cleared: checked.note === null, length: checked.note?.length ?? 0 },
    });
    if (checked.note === null) {
      await rest(`/fin_payment_notes?key=eq.${encodeURIComponent(body.key)}`, { method: 'DELETE' });
    } else {
      await rest('/fin_payment_notes?on_conflict=key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: body.key, entity_id: entity[0].id, note: checked.note, updated_by: auth.staff.id, updated_at: new Date().toISOString() }),
      });
    }
    return json({ ok: true, note: checked.note });
  } catch (err) {
    console.error('[finance-notes] set failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}
