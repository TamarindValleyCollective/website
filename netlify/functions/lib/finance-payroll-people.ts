// People-change requests for payroll (docs/finance/sessions/09-payroll.md, migration 0106). The rules are
// scripts/lib/finance-payroll-people.mjs (pure, tested); this file reads, writes and asks who the caller is.
//
// The farm manager (`finance-requests` payroll-input) decides who joins and who leaves, so a change starts as his request. A director
// with `finance` export approves or declines it, never the person who raised it; an approval needs the MFA step-up because it changes
// who is paid. Approving a joining request puts the person on payroll (the database gives them the next employee number) from the
// start month; approving a leaving request sets the last month to pay. Adding the person as a Party stays a separate step done by
// someone else: a director picks the Party when approving. Names and months are the only personal detail here; the audit log holds ids.
import { stepUpIsValid } from './staff-admin-guard';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { decidePersonRequest, requestSummary, validatePersonRequest } from '../../../scripts/lib/finance-payroll-people.mjs';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { PAYROLL_ID, body, entityId, fail, json, payrollAccess, rows, serverError, type Json } from './finance-payroll';

const month7 = (d: unknown) => (d ? String(d).slice(0, 7) : null);

async function loadRequest(id: string): Promise<Json | null> {
  return (await rows(`/fin_people_requests?id=eq.${id}&select=*`))[0] ?? null;
}

// GET /payroll/requests: the open requests and the latest decided ones, with what happens next.
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
        return {
          id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
          mine: r.requested_by === access.staff.id,
          name: r.kind === 'join' ? r.person_name : emp ? nameOf.get(emp.party_id) ?? 'Unknown' : 'Unknown',
          rollNo: emp?.roll_no ?? null,
          roleTitle: r.role_title, startMonth: month7(r.start_month), agreedPayRupees: r.agreed_pay_paise == null ? null : Number(r.agreed_pay_paise) / 100,
          lastMonth: month7(r.last_month), reason: r.reason,
          ...requestSummary({ kind: r.kind, status: r.status }),
        };
      }),
    });
  } catch (err) {
    return serverError(err, 'list requests');
  }
}

// POST /payroll/requests { kind: 'join', name, startMonth, role?, agreedPayRupees? } or { kind: 'leave', employeeId, lastMonth, reason? }
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
    if (v.kind === 'leave') {
      employee = (await rows(`/fin_employees?id=eq.${v.employeeId}&select=id,active,start_month,last_month`))[0] ?? null;
      if (!employee || !employee.active) return fail('That person is not on payroll.');
      if (employee.last_month) return fail('That person already has a last month to pay.', 409);
      if ((await rows(`/fin_people_requests?kind=eq.leave&status=eq.requested&employee_id=eq.${v.employeeId}&select=id`))[0]) return fail('There is already an open request for that person.', 409);
      if (employee.start_month && String(employee.start_month) > v.lastMonth) return fail('The last month cannot be before the month they started.');
    } else {
      const open = await rows("/fin_people_requests?kind=eq.join&status=eq.requested&select=person_name");
      if (open.some((r) => String(r.person_name).toLowerCase() === String(v.personName).toLowerCase())) return fail('There is already an open request for that person.', 409);
    }
    await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_person_requested', target: v.employeeId ?? undefined, detail: { kind: v.kind, month: month7(v.startMonth ?? v.lastMonth) } });
    const res = await rest('/fin_people_requests', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        entity_id: entity, kind: v.kind, person_name: v.personName ?? null, role_title: v.roleTitle ?? null, start_month: v.startMonth ?? null,
        agreed_pay_paise: v.agreedPayPaise ?? null, employee_id: v.employeeId ?? null, last_month: v.lastMonth ?? null, reason: v.reason ?? null, requested_by: access.staff.id,
      }),
    });
    if (res.status === 409) return fail('There is already an open request for that person.', 409);
    const [created] = (await res.json()) as Json[];
    return json({ id: created.id }, 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('There is already an open request for that person.', 409);
    return serverError(err, 'create request');
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
    const decided = { status: verdict.to, decided_by: access.staff.id, decided_at: now, decision_note: note, updated_at: now };
    const settle = async (patch: Json) => {
      const res = await rest(`/fin_people_requests?id=eq.${id}&status=eq.requested`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      return ((await res.json()) as Json[]).length === 1;
    };

    if (b.action === 'cancel') {
      await audit();
      if (!(await settle({ status: 'cancelled', updated_at: now }))) return fail('The request changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'reject') {
      await audit();
      if (!(await settle(decided))) return fail('The request changed while you were looking at it. Reload.', 409);
    } else if (request.kind === 'join') {
      if (typeof b.partyId !== 'string' || !PAYROLL_ID.test(b.partyId)) return fail('Choose the person\'s party first. Someone adds them on the Parties page.');
      const [party] = await rows(`/fin_parties?id=eq.${b.partyId}&select=id,kind,active,merged_into`);
      if (!party || !party.active || party.merged_into || party.kind !== 'employee') return fail('Choose a person whose party is of kind employee.');
      if ((await rows(`/fin_employees?party_id=eq.${party.id}&select=id`))[0]) return fail('That person is already on payroll.', 409);
      await audit({ party: party.id, month: month7(request.start_month) });
      const made = await rest('/fin_employees', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, party_id: party.id, start_month: request.start_month, created_by: access.staff.id }) });
      if (made.status === 409) return fail('That person is already on payroll.', 409);
      const [employee] = (await made.json()) as Json[];
      if (!(await settle({ ...decided, employee_id: employee.id }))) {
        // Nothing has used the new row yet, so undo it rather than leave a person on payroll without an approval.
        await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'DELETE' });
        return fail('The request changed while you were looking at it. Reload.', 409);
      }
      return json({ ok: true, status: verdict.to, rollNo: employee.roll_no });
    } else {
      const [employee] = await rows(`/fin_employees?id=eq.${request.employee_id}&select=id,active,start_month,last_month`);
      if (!employee || !employee.active) return fail('That person is not on payroll any more.', 409);
      if (employee.start_month && String(employee.start_month) > String(request.last_month)) return fail('The last month cannot be before the month they started.');
      await audit({ month: month7(request.last_month) });
      await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'PATCH', body: JSON.stringify({ last_month: request.last_month }) });
      if (!(await settle(decided))) {
        await rest(`/fin_employees?id=eq.${employee.id}`, { method: 'PATCH', body: JSON.stringify({ last_month: employee.last_month ?? null }) });
        return fail('The request changed while you were looking at it. Reload.', 409);
      }
    }
    return json({ ok: true, status: verdict.to });
  } catch (err) {
    return serverError(err, 'request action');
  }
}

