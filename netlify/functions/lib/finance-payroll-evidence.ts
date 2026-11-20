// Evidence of the bank's confirmation for a salary batch (docs/finance/sessions/09-payroll.md, migration 0107): a screenshot, or a PDF, of
// the bank portal's page for the uploaded batch. The preparer (a director with `finance` export) attaches it once the file has been marked as
// uploaded; the farm manager and both directors can look at it. It is a fin_vouchers row of kind 'payment_screenshot' with a batch_id, in the
// same private bucket as the other vouchers, and is only ever read back through GET /payroll/evidence/:id, never by a link. It holds the real
// names and account numbers the bank shows, so it never goes into the repository.
import { randomUUID } from 'node:crypto';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { deleteFinanceVoucher, getFinanceVoucher, putFinanceVoucher } from './finance-storage';
import { VOUCHER_MAX_BYTES, sniffVoucher } from '../../../scripts/lib/finance-requests.mjs';
import { PAYROLL_ID, entityId, fail, json, payrollAccess, rows, serverError } from './finance-payroll';

const MAX_PER_BATCH = 6;
// The file has to have gone to the bank first: before that there is nothing to show.
const AFTER_UPLOAD = ['uploaded', 'approved_at_bank', 'settled'];

async function batchOf(runId: string): Promise<{ run: any; batch: any } | null> {
  const [run] = await rows(`/fin_payroll_runs?id=eq.${runId}&select=id,month,batch_id`);
  if (!run?.batch_id) return null;
  const [batch] = await rows(`/fin_payment_batches?id=eq.${run.batch_id}&select=id,status`);
  return batch ? { run, batch } : null;
}

// GET /payroll/runs/:id/evidence -> { files: [{ id, mime, createdAt }] }, oldest first.
export async function listBatchEvidence(req: Request, runId: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  try {
    const found = await batchOf(runId);
    if (!found) return json({ files: [] });
    const files = await rows(`/fin_vouchers?batch_id=eq.${found.batch.id}&select=id,mime,created_at&order=created_at.asc`);
    return json({ files: files.map((f) => ({ id: f.id, mime: f.mime, createdAt: f.created_at })) });
  } catch (err) {
    return serverError(err, 'list evidence');
  }
}

// POST /payroll/runs/:id/evidence (a form upload, field `file`)
export async function addBatchEvidence(req: Request, runId: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canPrepare) return fail('Only the director who prepares the bank file can attach the bank\'s confirmation.', 403);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('Send the file as a form upload.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('Choose a file.');
  if (file.size > VOUCHER_MAX_BYTES) return fail('That file is too large. Take the screenshot again at a lower size.', 413);
  try {
    const found = await batchOf(runId);
    if (!found) return fail('There is no bank file for this run yet.', 409);
    if (!AFTER_UPLOAD.includes(found.batch.status)) return fail('Attach it after the file has been uploaded to the bank and marked as uploaded here.', 409);
    const existing = await rows(`/fin_vouchers?batch_id=eq.${found.batch.id}&select=id`);
    if (existing.length >= MAX_PER_BATCH) return fail(`A batch can hold at most ${MAX_PER_BATCH} files.`, 409);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffVoucher(bytes) as { mime: string; ext: string } | null;
    if (!sniffed) return fail('Attach a screenshot (JPEG, PNG or WebP) or a PDF.');
    const entity = await entityId();
    const id = randomUUID();
    const key = `finance/vouchers/${id}.${sniffed.ext}`;
    // The file first, then the row: a row never points at nothing. If the row fails the orphan file is removed.
    await putFinanceVoucher(key, bytes, sniffed.mime);
    try {
      await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_evidence_added', target: runId, detail: { batch: found.batch.id, mime: sniffed.mime, month: String(found.run.month).slice(0, 7) } });
      await rest('/fin_vouchers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id, entity_id: entity, batch_id: found.batch.id, kind: 'payment_screenshot', r2_key: key, mime: sniffed.mime, created_by: access.staff.id }) });
    } catch (err) {
      await deleteFinanceVoucher(key).catch(() => undefined);
      throw err;
    }
    return json({ id }, 201);
  } catch (err) {
    return serverError(err, 'add evidence');
  }
}

// GET /payroll/evidence/:id: the file, for the three payroll roles only, inline and never cached.
export async function getBatchEvidence(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  if (!PAYROLL_ID.test(id)) return fail('Not found', 404);
  try {
    const [v] = await rows(`/fin_vouchers?id=eq.${id}&batch_id=not.is.null&select=id,r2_key,mime`);
    if (!v) return fail('Not found', 404);
    const bytes = await getFinanceVoucher(v.r2_key);
    if (!bytes) return fail('Not found', 404);
    return new Response(bytes as BodyInit, { headers: { 'content-type': v.mime, 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return serverError(err, 'get evidence');
  }
}
