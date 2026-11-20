// People-change requests for payroll (docs/finance/sessions/09-payroll.md, migrations 0106 and 0108). The rules are
// scripts/lib/finance-payroll-people.mjs (pure, tested); this file reads, writes and asks who the caller is.
//
// The farm manager (`finance-requests` payroll-input) decides who joins and who leaves, and the employee gives him their bank details, so a
// change starts as his request: someone joining (optionally with bank details), someone leaving, or an employee's bank details changing.
// A director with `finance` export approves or declines it, never the person who raised it; an approval needs the MFA step-up because it
// changes who is paid or where. Adding the person as a Party stays a separate step done by someone else: a director picks the Party when
// approving a join.
//
// Bank details: encrypted with the payee-account key the moment they are received, only the last four digits readable, and held ONLY while the
// request is open (the database refuses to keep them afterwards). Approving attaches them to the Party as an UNVERIFIED payee account entered by
// the requester, so someone else must verify it, with the photo of the passbook or cheque as evidence on that account. Declining or
// withdrawing discards them and the photo. No response carries an account number or an IFSC, and the audit log holds ids and kinds only.
import { randomUUID } from 'node:crypto';
import { stepUpIsValid } from './staff-admin-guard';
import { rest } from './staff-mfa-store';
import { decryptFinanceText, encryptFinanceText } from './staff-mfa-crypto';
import { logFinanceAction } from './finance-audit';
import { deleteFinanceVoucher, getFinanceVoucher, putFinanceVoucher } from './finance-storage';
import { attachEvidenceFile, attachPayeeDetails } from './finance-parties';
import { decidePersonRequest, proofMissing, requestSummary, validatePersonRequest } from '../../../scripts/lib/finance-payroll-people.mjs';
import { bankNameOfIfsc } from '../../../scripts/lib/ifsc-banks.mjs';
import { VOUCHER_MAX_BYTES, sniffVoucher } from '../../../scripts/lib/finance-requests.mjs';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { PAYROLL_ID, body, entityId, fail, json, payrollAccess, rows, serverError, type Json } from './finance-payroll';

const month7 = (d: unknown) => (d ? String(d).slice(0, 7) : null);

async function loadRequest(id: string): Promise<Json | null> {
  return (await rows(`/fin_people_requests?id=eq.${id}&select=*`))[0] ?? null;
}

// What a request holds that must go when it is declined, withdrawn or approved (the details are then on the account, not here).
const WIPED = { details_enc: null, last4: null, proof_key: null, proof_mime: null };
const discardProof = async (key: unknown) => {
  if (typeof key === 'string' && key) await deleteFinanceVoucher(key).catch(() => undefined);
};

// GET /payroll/requests: the open requests and the latest decided ones, with what happens next. Never an account number or an IFSC: the last
// four digits, and the bank's name read from the IFSC, are all that leave the server.
export async function listPersonRequests(req: Request): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  try {
    const reqs = await rows('/fin_people_requests?select=*&order=created_at.desc&limit=40');
    const empIds = [...new Set(reqs.map((r) => r.employee_id).filter(Boolean))];
    const emps = empIds.length ? await rows(`/fin_employees?id=in.(${empIds.join(',')})&select=id,party_id,roll_no`) : [];
    const parties = emps.length ? await rows(`/fin_parties?id=in.(${emps.map((e) => e.party_id).join(',')})&select=id,name`) : [];
    const nameOf = new Map(parties.map((p) => [p.id, p.name]));
    const empById = new Map(emps.map((e) => [e.id, e]));
    return json({
      requests: reqs.map((r) => {
        const emp = r.employee_id ? empById.get(r.employee_id) : null;
        let bankName: string | null = null;
        if (r.details_enc) {
          try {
            bankName = bankNameOfIfsc(JSON.parse(decryptFinanceText(r.details_enc)).ifsc);
          } catch {
            bankName = null;
          }
        }
        return {
          id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
          mine: r.requested_by === access.staff.id,
          name: r.kind === 'join' ? r.person_name : emp ? nameOf.get(emp.party_id) ?? 'Unknown' : 'Unknown',
          rollNo: emp?.roll_no ?? null,
          roleTitle: r.role_title, startMonth: month7(r.start_month), agreedPayRupees: r.agreed_pay_paise == null ? null : Number(r.agreed_pay_paise) / 100,
          lastMonth: month7(r.last_month), reason: r.reason,
          hasBank: Boolean(r.details_enc), last4: r.last4 ?? null, bankName, hasProof: Boolean(r.proof_key), effectiveOn: r.effective_on ?? null,
          ...requestSummary({ kind: r.kind, status: r.status, hasBank: Boolean(r.details_enc), hasProof: Boolean(r.proof_key) }),
        };
      }),
    });
  } catch (err) {
    return serverError(err, 'list requests');
  }
}

// POST /payroll/requests, one of:
//   { kind: 'join', name, startMonth, role?, agreedPayRupees?, bank?: { account, accountConfirm, ifsc } }
//   { kind: 'leave', employeeId, lastMonth, reason? }
//   { kind: 'bank_change', employeeId, fromMonth, bank: { account, accountConfirm, ifsc } }
// A request with bank details then needs its photo (POST /payroll/requests/:id/proof) before a director can approve it.
export async function createPersonRequest(req: Request): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canEnter) return fail('Only the person who enters the salaries can raise a change of people.', 403);
  const b = await body(req);
  const checked = validatePersonRequest(b, { today: todayIST() }) as { value?: Json; error?: string };
  if (checked.error || !checked.value) return fail(checked.error ?? 'Check the details.');
  const v = checked.value;
  try {
    const entity = await entityId();
    let employee: Json | null = null;
    if (v.kind === 'leave' || v.kind === 'bank_change') {
      employee = (await rows(`/fin_employees?id=eq.${v.employeeId}&select=id,party_id,active,start_month,last_month`))[0] ?? null;
      if (!employee || !employee.active) return fail('That person is not on payroll.');
    }
    if (v.kind === 'leave') {
      if (employee!.last_month) return fail('That person already has a last month to pay.', 409);
      if (employee!.start_month && String(employee!.start_month) > v.lastMonth) return fail('The last month cannot be before the month they started.');
    }
    if (v.kind === 'join') {
      const open = await rows('/fin_people_requests?kind=eq.join&status=eq.requested&select=person_name');
      if (open.some((r) => String(r.person_name).toLowerCase() === String(v.personName).toLowerCase())) return fail('There is already an open request for that person.', 409);
    } else if ((await rows(`/fin_people_requests?kind=eq.${v.kind}&status=eq.requested&employee_id=eq.${v.employeeId}&select=id`))[0]) {
      return fail('There is already an open request for that person.', 409);
    }
    await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_person_requested', target: v.employeeId ?? undefined, detail: { kind: v.kind, withBank: Boolean(v.bank), month: month7(v.startMonth ?? v.lastMonth ?? v.effectiveOn) } });
    const res = await rest('/fin_people_requests', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        entity_id: entity, kind: v.kind, person_name: v.personName ?? null, role_title: v.roleTitle ?? null, start_month: v.startMonth ?? null,
        agreed_pay_paise: v.agreedPayPaise ?? null, employee_id: v.employeeId ?? null, last_month: v.lastMonth ?? null, reason: v.reason ?? null,
        effective_on: v.effectiveOn ?? null,
        // Encrypted here and nowhere else readable: the number and IFSC never reach the table in the clear.
        details_enc: v.bank ? encryptFinanceText(JSON.stringify(v.bank.details)) : null, last4: v.bank ? v.bank.last4 : null,
        requested_by: access.staff.id,
      }),
    });
    if (res.status === 409) return fail('There is already an open request for that person.', 409);
    const [created] = (await res.json()) as Json[];
    return json({ id: created.id, needsProof: Boolean(v.bank) }, 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('There is already an open request for that person.', 409);
    return serverError(err, 'create request');
  }
}

// POST /payroll/requests/:id/proof (a form upload, field `file`): the photo of the passbook or cancelled cheque. Only the person who raised the
// request, while it is open and carries bank details; a second upload replaces the first.
export async function addRequestProof(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canEnter) return fail('Only the person who raised the request can attach the photo.', 403);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('Send the file as a form upload.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('Choose a file.');
  if (file.size > VOUCHER_MAX_BYTES) return fail('That file is too large. Take the photo again at a lower size.', 413);
  try {
    const request = await loadRequest(id);
    if (!request || request.requested_by !== access.staff.id) return fail('Not found', 404);
    if (request.status !== 'requested' || !request.details_enc) return fail('This request has no bank details waiting for a photo.', 409);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffVoucher(bytes) as { mime: string; ext: string } | null;
    if (!sniffed) return fail('Attach a photo (JPEG, PNG or WebP) or a PDF.');
    const key = `finance/vouchers/${randomUUID()}.${sniffed.ext}`;
    await putFinanceVoucher(key, bytes, sniffed.mime);
    try {
      await logFinanceAction({ actorId: access.staff.id, entityId: request.entity_id, action: 'finance.payroll_person_proof_added', target: id, detail: { kind: request.kind, mime: sniffed.mime } });
      const res = await rest(`/fin_people_requests?id=eq.${id}&status=eq.requested`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ proof_key: key, proof_mime: sniffed.mime, updated_at: new Date().toISOString() }) });
      if (((await res.json()) as Json[]).length !== 1) throw new Error('request closed while the photo was saved');
    } catch (err) {
      await deleteFinanceVoucher(key).catch(() => undefined);
      throw err;
    }
    await discardProof(request.proof_key);
    return json({ ok: true }, 201);
  } catch (err) {
    return serverError(err, 'add request proof');
  }
}

// GET /payroll/requests/:id/proof: the photo, to the person who raised the request or, behind the step-up, a director (it shows the whole account
// number). Inline, never cached, never linked.
export async function getRequestProof(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  try {
    const request = await loadRequest(id);
    if (!request?.proof_key) return fail('Not found', 404);
    const mine = request.requested_by === access.staff.id;
    if (!mine) {
      if (!access.canPrepare) return fail('Not found', 404);
      if (!stepUpIsValid(req, access.staff.id)) return fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED');
    }
    const bytes = await getFinanceVoucher(request.proof_key);
    if (!bytes) return fail('Not found', 404);
    await logFinanceAction({ actorId: access.staff.id, entityId: request.entity_id, action: 'finance.payroll_person_proof_viewed', target: id, detail: { kind: request.kind } });
    return new Response(bytes as BodyInit, { headers: { 'content-type': request.proof_mime, 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return serverError(err, 'get request proof');
  }
}

// POST /payroll/requests/:id/action { action: 'approve' | 'reject' | 'cancel', partyId?, note? }
export async function personRequestAction(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  const b = await body(req);
  if (!b || typeof b.action !== 'string') return fail('Choose an action.');
  try {
    const request = await loadRequest(id);
    if (!request) return fail('Not found', 404);
    const verdict = decidePersonRequest(
      { status: request.status, requestedBy: request.requested_by },
      b.action,
      { id: access.staff.id, canEnter: access.canEnter, canPrepare: access.canPrepare },
    ) as { ok: boolean; to?: string; error?: string };
    if (!verdict.ok || !verdict.to) return fail(verdict.error ?? 'Not allowed.', 403);
    if (b.action === 'approve' && !stepUpIsValid(req, access.staff.id)) return fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED');
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
    if (note && note.length > 200) return fail('The note is too long (200 characters at most).');
    const entity = await entityId();
    const audit = (extra: Json = {}) => logFinanceAction({ actorId: access.staff.id, entityId: entity, action: `finance.payroll_person_${b.action}`, target: id, detail: { kind: request.kind, ...extra } });
    const now = new Date().toISOString();
    const decided = { status: verdict.to, decided_by: access.staff.id, decided_at: now, decision_note: note, updated_at: now, ...WIPED };
    const settle = async (patch: Json) => {
      const res = await rest(`/fin_people_requests?id=eq.${id}&status=eq.requested`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      return ((await res.json()) as Json[]).length === 1;
    };
    const changed = () => fail('The request changed while you were looking at it. Reload.', 409);

    if (b.action === 'cancel') {
      await audit();
      if (!(await settle({ status: 'cancelled', updated_at: now, ...WIPED }))) return changed();
      await discardProof(request.proof_key);
      return json({ ok: true, status: verdict.to });
    }
    if (b.action === 'reject') {
      await audit();
      if (!(await settle(decided))) return changed();
      await discardProof(request.proof_key);
      return json({ ok: true, status: verdict.to });
    }

    // ---- approve. The details are read into memory first; the request is claimed (and its copy wiped) by the guarded update; only then is the
    // account made, so a second director approving at the same moment cannot make a second one.
    const hasBank = Boolean(request.details_enc);
    if (proofMissing({ hasBank, hasProof: Boolean(request.proof_key) })) return fail('The photo of the passbook or cheque has to be attached first.', 409);
    const payee = hasBank ? (JSON.parse(decryptFinanceText(request.details_enc)) as Json) : null;
    const proof = hasBank ? { key: request.proof_key as string, mime: request.proof_mime as string } : null;
    const attach = async (partyId: string, effectiveOn: string | null): Promise<Response | null> => {
      if (!payee || !proof) return null;
      const made = await attachPayeeDetails(partyId, request.requested_by, payee, effectiveOn);
      if ('error' in made) return fail(`Approved, but the bank details could not be attached (${made.error}) Add them on the Parties page.`, 500);
      if ('accountId' in made) {
        const bytes = await getFinanceVoucher(proof.key).catch(() => null);
        if (bytes) await attachEvidenceFile(made.accountId, made.entityId, request.requested_by, { key: proof.key, mime: proof.mime, bytes: bytes.length });
      }
      return null;
    };

    if (request.kind === 'join') {
      if (typeof b.partyId !== 'string' || !PAYROLL_ID.test(b.partyId)) return fail('Choose the person\'s party first. Someone adds them on the Parties page.');
      const [party] = await rows(`/fin_parties?id=eq.${b.partyId}&select=id,kind,active,merged_into`);
      if (!party || !party.active || party.merged_into || party.kind !== 'employee') return fail('Choose a person whose party is of kind employee.');
      if ((await rows(`/fin_employees?party_id=eq.${party.id}&select=id`))[0]) return fail('That person is already on payroll.', 409);
      await audit({ party: party.id, month: month7(request.start_month), withBank: hasBank });
      const made = await rest('/fin_employees', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, party_id: party.id, start_month: request.start_month, created_by: access.staff.id }) });
      if (made.status === 409) return fail('That person is already on payroll.', 409);
      const [employee] = (await made.json()) as Json[];
      if (!(await settle({ ...decided, employee_id: employee.id }))) {
        // Nothing has used the new row yet, so undo it rather than leave a person on payroll without an approval.
        await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'DELETE' });
        return changed();
      }
      const problem = await attach(party.id, null);
      if (problem) return problem;
      return json({ ok: true, status: verdict.to, rollNo: employee.roll_no, bankAttached: hasBank });
    }

    if (request.kind === 'bank_change') {
      const [employee] = await rows(`/fin_employees?id=eq.${request.employee_id}&select=id,party_id,active`);
      if (!employee || !employee.active) return fail('That person is not on payroll any more.', 409);
      await audit({ effectiveOn: request.effective_on });
      if (!(await settle(decided))) return changed();
      const problem = await attach(employee.party_id, request.effective_on);
      if (problem) return problem;
      return json({ ok: true, status: verdict.to, bankAttached: true });
    }

    const [employee] = await rows(`/fin_employees?id=eq.${request.employee_id}&select=id,active,start_month,last_month`);
    if (!employee || !employee.active) return fail('That person is not on payroll any more.', 409);
    if (employee.start_month && String(employee.start_month) > String(request.last_month)) return fail('The last month cannot be before the month they started.');
    await audit({ month: month7(request.last_month) });
    await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'PATCH', body: JSON.stringify({ last_month: request.last_month }) });
    if (!(await settle(decided))) {
      await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'PATCH', body: JSON.stringify({ last_month: employee.last_month ?? null }) });
      return changed();
    }
    return json({ ok: true, status: verdict.to });
  } catch (err) {
    return serverError(err, 'request action');
  }
}
