// Payment requests and spend logs (docs/finance/sessions/08-payment-requests-and-bills.md, migration 0092). Two kinds of record
// with one set of fields: a request, raised before paying and approved by someone else, and a log of a spend already made. The
// rules are in scripts/lib/finance-requests.mjs (pure, tested); this file reads, writes and checks who may.
//
// Who may do what. Raising, logging, attaching a bill and adding a vendor need `finance-requests` (the farm manager) OR the
// `finance` capability `request`; holding `finance-requests` alone opens nothing else. Seeing every record needs `finance` view,
// matching one to a statement row needs `allocate`, approving needs `approve` and the MFA step-up, and whoever raised a request
// can never approve or reject it. Every change is written to fin_audit_log first, with ids and field names only.
//
// The purpose of a record is pulled into the UPI page and the ledger (loadPurposes) as the default wording until a person writes
// a payment note; nothing is copied into those tables.
import { randomUUID } from 'node:crypto';
import { requireStaff } from './staff-access';
import { stepUpIsValid } from './staff-admin-guard';
import { mfaSummary, rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { deleteFinanceVoucher, getFinanceVoucher, putFinanceVoucher } from './finance-storage';
import { sendEmail } from './booking-notify';
import { escapeHtml, renderStaffEmail } from './email-layout';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { VOUCHER_MAX_BYTES, decide, exactMatches, planMatch, deriveLinks, proposeMatches, purposeIndex, reviewFlag, sniffVoucher, validateRecord, agingUnmatched } from '../../../scripts/lib/finance-requests.mjs';

type Json = Record<string, any>;
const PAGE = 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REQUEST_ID = ID;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (error: string, status = 400, code?: string) => json({ error, ...(code ? { code } : {}) }, status);
const serverError = (err: unknown, what: string) => {
  console.error(`[finance-requests] ${what} failed`, err instanceof Error ? err.message : err);
  return json({ error: 'Server error' }, 500);
};

const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];
async function all(path: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rows(`${path}&limit=${PAGE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}
async function entityId(): Promise<string> {
  const e = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}
async function body(req: Request): Promise<Json | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Json) : null;
  } catch {
    return null;
  }
}

// The farm manager's module, or a finance operator who may `request`.
export async function requesterAuth(req: Request, capability: 'raise' | 'add-vendor' | 'scan-bill') {
  const own = await requireStaff(req, 'finance-requests', capability);
  if (own.ok) return own;
  return requireStaff(req, 'finance', 'request');
}

const COLUMNS = 'id,kind,status,source,requester_id,party_id,recipient_text,amount_paise,mode,purpose,needed_by,reimbursement,paid_on,paid_via,upi_ref,decided_by,decided_at,decision_reason,upi_line_id,bank_line_id,matched_at,review_flag,reviewed_at,created_at';

// The purposes that the UPI page and the ledger show for a payment (a lookup over every live record).
export async function loadPurposes() {
  const records = await all(`/fin_payment_requests?select=status,purpose,upi_ref,upi_line_id,bank_line_id&status=not.in.(rejected,cancelled)&order=created_at.asc,id.asc`);
  return purposeIndex(records.map((r) => ({ status: r.status, purpose: r.purpose, upiRef: r.upi_ref, upiLineId: r.upi_line_id, bankLineId: r.bank_line_id })));
}

// ------------------------------------------------------------------ shaping
type Names = { staff: Map<string, string>; party: Map<string, string> };
async function namesFor(records: Json[]): Promise<Names> {
  const staffIds = [...new Set(records.flatMap((r) => [r.requester_id, r.decided_by]).filter(Boolean))] as string[];
  const partyIds = [...new Set(records.map((r) => r.party_id).filter(Boolean))] as string[];
  const [staff, parties] = await Promise.all([
    staffIds.length ? rows(`/staff_users?id=in.(${staffIds.join(',')})&select=id,name,email`) : Promise.resolve([]),
    partyIds.length ? all(`/fin_parties?select=id,name&id=in.(${partyIds.join(',')})&order=id.asc`) : Promise.resolve([]),
  ]);
  return { staff: new Map(staff.map((s) => [s.id as string, (s.name || s.email) as string])), party: new Map(parties.map((p) => [p.id as string, p.name as string])) };
}
const shape = (r: Json, n: Names, vouchers: Map<string, number>) => ({
  id: r.id as string,
  kind: r.kind as 'request' | 'log',
  status: r.status as string,
  source: r.source as 'app' | 'history',
  requester: r.requester_id ? n.staff.get(r.requester_id) ?? null : null,
  requesterId: r.requester_id as string | null,
  partyId: r.party_id as string | null,
  payee: (r.party_id ? n.party.get(r.party_id) : null) ?? (r.recipient_text as string | null),
  amountPaise: Number(r.amount_paise),
  mode: r.mode as string,
  purpose: r.purpose as string,
  neededBy: r.needed_by as string | null,
  reimbursement: Boolean(r.reimbursement),
  paidOn: r.paid_on as string | null,
  paidVia: r.paid_via as string | null,
  upiRef: r.upi_ref as string | null,
  decidedBy: r.decided_by ? n.staff.get(r.decided_by) ?? null : null,
  decidedAt: r.decided_at as string | null,
  decisionReason: r.decision_reason as string | null,
  reviewFlag: r.review_flag && !r.reviewed_at ? (r.review_flag as string) : null,
  vouchers: vouchers.get(r.id as string) ?? 0,
  createdAt: r.created_at as string,
});
async function voucherCounts(requestIds?: string[]): Promise<Map<string, number>> {
  const filter = requestIds ? (requestIds.length ? `&request_id=in.(${requestIds.join(',')})` : '&request_id=eq.00000000-0000-0000-0000-000000000000') : '';
  const v = await all(`/fin_vouchers?select=id,request_id&request_id=not.is.null${filter}&order=id.asc`);
  const out = new Map<string, number>();
  for (const x of v) out.set(x.request_id, (out.get(x.request_id) ?? 0) + 1);
  return out;
}

// ---------------------------------------------------------- the requester's side
// Payees by name, so a payee can be chosen. The state is all a requester learns of a payee's account: never the details.
async function payeeList(): Promise<Json[]> {
  const [parties, accounts] = await Promise.all([
    all('/fin_parties?select=id,name,kind&active=eq.true&merged_into=is.null&order=name.asc,id.asc'),
    all('/fin_party_accounts?select=id,party_id,status&status=in.(verified,unverified)&order=id.asc'),
  ]);
  const state = new Map<string, string>();
  for (const a of accounts) if (state.get(a.party_id) !== 'verified') state.set(a.party_id, a.status);
  return parties.map((p) => ({ id: p.id, name: p.name, kind: p.kind, account: state.get(p.id) ?? 'none' }));
}

export async function listMine(req: Request): Promise<Response> {
  const auth = await requesterAuth(req, 'raise');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const mine = await rows(`/fin_payment_requests?select=${COLUMNS}&requester_id=eq.${auth.staff.id}&order=created_at.desc&limit=100`);
    const [names, vouchers, payees] = await Promise.all([namesFor(mine), voucherCounts(mine.map((r) => r.id)), payeeList()]);
    return json({ me: { id: auth.staff.id, name: auth.staff.name }, records: mine.map((r) => shape(r, names, vouchers)), payees, today: todayIST() });
  } catch (err) {
    return serverError(err, 'list mine');
  }
}

export async function createRecord(req: Request): Promise<Response> {
  const auth = await requesterAuth(req, 'raise');
  if (!auth.ok) return fail(auth.error, auth.status);
  const b = await body(req);
  if (!b) return fail('Send the details as JSON.');
  const checked = validateRecord(b, { kind: b.kind, today: todayIST() });
  if (checked.error || !checked.value) return fail(checked.error ?? 'Check the details.');
  const v = checked.value as Json;
  try {
    const entity = await entityId();
    let partyName: string | null = null;
    if (v.partyId) {
      const [party] = await rows(`/fin_parties?id=eq.${v.partyId}&select=id,name,active,merged_into`);
      if (!party || !party.active || party.merged_into) return fail('Choose the payee from the list.');
      partyName = party.name as string;
    }
    const ent = await rows(`/fin_entities?id=eq.${entity}&select=requester_party_id`);
    const flag = reviewFlag({ partyId: v.partyId }, ent[0]?.requester_party_id ? [ent[0].requester_party_id] : []);
    const isLog = v.kind === 'log';
    const record = {
      entity_id: entity, kind: v.kind, status: isLog ? 'paid' : 'submitted', source: 'app', requester_id: auth.staff.id,
      party_id: v.partyId, recipient_text: v.recipientText, amount_paise: v.amountPaise, mode: v.mode, purpose: v.purpose,
      needed_by: v.neededBy, reimbursement: v.reimbursement, paid_on: v.paidOn, paid_via: v.paidVia, upi_ref: v.upiRef, review_flag: flag,
    };
    // The audit entry first: the record does not exist without a record that it was asked for.
    await logFinanceAction({ actorId: auth.staff.id, entityId: entity, action: isLog ? 'finance.spend_logged' : 'finance.request_raised', detail: { mode: v.mode, reimbursement: v.reimbursement, flagged: Boolean(flag) } });
    const res = await rest('/fin_payment_requests', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) });
    if (res.status === 409) return fail('That UPI reference is already recorded.', 409);
    const [created] = (await res.json()) as Json[];
    if (!isLog) void notifyApprovers({ requester: auth.staff.name ?? auth.staff.email, payee: partyName ?? v.recipientText, amountPaise: v.amountPaise, purpose: v.purpose });
    return json({ id: created.id, kind: created.kind, status: created.status }, 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('That UPI reference is already recorded.', 409);
    return serverError(err, 'create');
  }
}

async function notifyApprovers(n: { requester: string; payee: string; amountPaise: number; purpose: string }): Promise<void> {
  const rupees = (n.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: n.amountPaise % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const html = renderStaffEmail(`  <p style="margin-top:0;"><strong>${escapeHtml(n.requester)}</strong> raised a payment request for approval.</p>
  <p>To <strong>${escapeHtml(n.payee)}</strong>, Rs ${escapeHtml(rupees)}: ${escapeHtml(n.purpose)}</p>
  <p>Open <a href="https://admin.tvc.farm/finance/requests/">Finance requests</a> to look at it.</p>`);
  await sendEmail({ to: ['core-team@tvc.farm'], subject: 'Payment request to approve', html });
}

export async function cancelOrDecide(req: Request, id: string): Promise<Response> {
  const b = await body(req);
  if (!b || typeof b.action !== 'string') return fail('Choose approve, reject or cancel.');
  // Cancelling is the requester's own (or an approver's); approving and rejecting are `approve`, with the step-up for approving.
  const auth = b.action === 'cancel' ? await requesterAuth(req, 'raise') : await requireStaff(req, 'finance', 'approve');
  if (!auth.ok) return fail(auth.error, auth.status);
  const { staff } = auth;
  try {
    const [record] = await rows(`/fin_payment_requests?id=eq.${id}&select=${COLUMNS}`);
    if (!record) return fail('Not found', 404);
    if (b.action === 'cancel') {
      // The role on a `finance-requests` grant says nothing about `finance`, so the approver check asks for the real grant.
      const isApprover = (await requireStaff(req, 'finance', 'approve')).ok;
      if (record.requester_id !== staff.id && !isApprover) return fail('Not authorized', 403);
    }
    if (b.action === 'approve' && !stepUpIsValid(req, staff.id)) return fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED');
    const planned = decide({ record: { kind: record.kind, status: record.status, requesterId: record.requester_id }, action: b.action, actorId: staff.id, reason: b.reason, now: new Date().toISOString() });
    if (planned.error || !planned.patch) return fail(planned.error ?? 'Not allowed.');
    if (b.action === 'approve' && record.reimbursement && (await voucherCounts([id])).get(id) === undefined) return fail('A reimbursement needs a bill attached before it can be approved.');
    await logFinanceAction({ actorId: staff.id, entityId: record.entity_id ?? (await entityId()), action: `finance.request_${planned.patch.status}`, target: id });
    await rest(`/fin_payment_requests?id=eq.${id}&status=eq.${record.status}`, { method: 'PATCH', body: JSON.stringify({ ...planned.patch, updated_at: new Date().toISOString() }) });
    return json({ ok: true, status: planned.patch.status });
  } catch (err) {
    return serverError(err, 'decide');
  }
}

// -------------------------------------------------------------- bills and screenshots
export async function addVoucher(req: Request, id: string): Promise<Response> {
  const auth = await requesterAuth(req, 'scan-bill');
  if (!auth.ok) return fail(auth.error, auth.status);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('Send the file as a form upload.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('Choose a file.');
  if (file.size > VOUCHER_MAX_BYTES) return fail('That file is too large. Take the photo again at a lower size, or send fewer pages at a time.', 413);
  const kind = form.get('kind') === 'payment_screenshot' ? 'payment_screenshot' : 'bill';
  try {
    const [record] = await rows(`/fin_payment_requests?id=eq.${id}&select=id,entity_id,requester_id,status`);
    if (!record) return fail('Not found', 404);
    const isOperator = (await requireStaff(req, 'finance', 'allocate')).ok;
    if (record.requester_id !== auth.staff.id && !isOperator) return fail('Not authorized', 403);
    if (record.status === 'rejected' || record.status === 'cancelled') return fail('This record is closed.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffVoucher(bytes) as { mime: string; ext: string } | null;
    if (!sniffed) return fail('Attach a photo (JPEG, PNG or WebP) or a PDF.');
    const voucherId = randomUUID();
    const key = `finance/vouchers/${voucherId}.${sniffed.ext}`;
    // The file first, then the row: a row never points at nothing. If the row fails the orphan file is removed.
    await putFinanceVoucher(key, bytes, sniffed.mime);
    try {
      await logFinanceAction({ actorId: auth.staff.id, entityId: record.entity_id, action: 'finance.voucher_added', target: id, detail: { kind, mime: sniffed.mime } });
      await rest('/fin_vouchers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: voucherId, entity_id: record.entity_id, request_id: id, kind, r2_key: key, mime: sniffed.mime, created_by: auth.staff.id }) });
    } catch (err) {
      await deleteFinanceVoucher(key).catch(() => undefined);
      throw err;
    }
    return json({ id: voucherId }, 201);
  } catch (err) {
    return serverError(err, 'add voucher');
  }
}

// A voucher is shown only through this route: to the person who raised the record, or to anyone who may see finance.
export async function getVoucher(req: Request, voucherId: string): Promise<Response> {
  const viewer = await requireStaff(req, 'finance', 'view');
  const auth = viewer.ok ? viewer : await requesterAuth(req, 'raise');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [v] = await rows(`/fin_vouchers?id=eq.${voucherId}&select=id,r2_key,mime,request_id`);
    if (!v || !v.request_id) return fail('Not found', 404);
    if (!viewer.ok) {
      const [owner] = await rows(`/fin_payment_requests?id=eq.${v.request_id}&select=requester_id`);
      if (owner?.requester_id !== auth.staff.id) return fail('Not found', 404);
    }
    const bytes = await getFinanceVoucher(v.r2_key);
    if (!bytes) return fail('Not found', 404);
    return new Response(bytes as BodyInit, { headers: { 'content-type': v.mime, 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return serverError(err, 'get voucher');
  }
}

// ------------------------------------------------------------- the finance side
// The ids of a record's files, so the approver's page can open them (each through getVoucher).
export async function listFiles(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const files = await rows(`/fin_vouchers?request_id=eq.${id}&select=id,kind&order=created_at.asc`);
    return json({ files });
  } catch (err) {
    return serverError(err, 'list files');
  }
}

export async function listRequests(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [records, upi, bank, vouchers, ent] = await Promise.all([
      all(`/fin_payment_requests?select=${COLUMNS}&order=created_at.desc,id.asc`),
      all('/fin_upi_lines?select=id,upi_ref,paid_at,amount_paise,direction,counterparty,remarks,bank_line_id&ignored=eq.false&direction=eq.debit&order=paid_at.desc,id.asc'),
      all('/fin_bank_lines?select=id,tran_date,amount_paise,direction,narration,upi_rrn&direction=eq.debit&order=tran_date.desc,id.asc'),
      voucherCounts(),
      rows('/fin_entities?select=requester_party_id&order=created_at.asc&limit=1'),
    ]);
    const names = await namesFor(records);
    const shaped = records.map((r) => shape(r, names, vouchers));
    const upiLines = upi.map((u) => ({ id: u.id as string, upiRef: u.upi_ref as string, paidAt: u.paid_at as string, amountPaise: Number(u.amount_paise), direction: 'debit' as const, counterparty: u.counterparty as string | null, remark: u.remarks as string | null, bankLineId: u.bank_line_id as string | null }));
    const bankLines = bank.map((b) => ({ id: b.id as string, tranDate: b.tran_date as string, amountPaise: Number(b.amount_paise), direction: 'debit' as const, narration: b.narration as string, upiRrn: b.upi_rrn as string | null }));
    const live = records.filter((r) => r.status !== 'rejected' && r.status !== 'cancelled');
    // Exact (reference) matches need no stored link; a stored link is one a person accepted or the history load found.
    const exact = exactMatches(live.map((r) => ({ id: r.id, status: r.status, amountPaise: Number(r.amount_paise), upiRef: r.upi_ref })), upiLines, bankLines);
    const stored = (r: Json) => Boolean(r.upi_line_id || r.bank_line_id);
    const unmatched = live.filter((r) => !stored(r) && !exact.links.has(r.id) && (r.kind === 'log' || r.status === 'approved' || r.status === 'paid'));
    // One link is enough: whichever side a record is linked on, the other is derived from the UPI row's join to its bank line.
    const derived = new Map(live.map((r) => [r.id as string, deriveLinks({ upiLineId: r.upi_line_id ?? exact.links.get(r.id)?.upiLineId ?? null, bankLineId: r.bank_line_id ?? exact.links.get(r.id)?.bankLineId ?? null }, upiLines) as { upiLineId: string | null; bankLineId: string | null }]));
    const claimedUpi = new Set<string>([...derived.values()].map((d) => d.upiLineId).filter(Boolean) as string[]);
    const claimedBank = new Set<string>([...derived.values()].map((d) => d.bankLineId).filter(Boolean) as string[]);
    const upiById = new Map(upiLines.map((u) => [u.id, u]));
    const bankById = new Map(bankLines.map((b) => [b.id, b]));
    const proposals = proposeMatches(
      unmatched.map((r) => ({ id: r.id, mode: r.mode, amountPaise: Number(r.amount_paise), partyName: r.party_id ? names.party.get(r.party_id) ?? null : null, recipientText: r.recipient_text, purpose: r.purpose, paidOn: r.paid_on, decidedOn: r.decided_at ? String(r.decided_at).slice(0, 10) : null, createdOn: String(r.created_at).slice(0, 10) })),
      upiLines, bankLines, { claimedUpi, claimedBank },
    ) as { recordId: string; type: 'upi' | 'bank'; targetId: string; score: number; reasons: string[] }[];
    const proposalsBy = new Map<string, Json[]>();
    for (const p of proposals) {
      const t = p.type === 'upi' ? upiById.get(p.targetId) : bankById.get(p.targetId);
      if (!t) continue;
      const view = p.type === 'upi' ? { date: (t as any).paidAt, who: [(t as any).counterparty, (t as any).remark ? `“${(t as any).remark}”` : ''].filter(Boolean).join(' · ') } : { date: (t as any).tranDate, who: (t as any).narration };
      proposalsBy.set(p.recordId, [...(proposalsBy.get(p.recordId) ?? []), { type: p.type, targetId: p.targetId, reasons: p.reasons, ...view }]);
    }
    const requesterIds = ent[0]?.requester_party_id ? [ent[0].requester_party_id as string] : [];
    const caps = capabilitiesForRole('finance', auth.staff.role) as string[];
    const out = shaped.map((s, i) => {
      const r = records[i];
      const link = exact.links.get(r.id);
      const matched = stored(r) ? 'accepted' : link ? 'reference' : null;
      const d = derived.get(r.id as string);
      return { ...s, matched, linked: d && (d.upiLineId || d.bankLineId) ? { upi: Boolean(d.upiLineId), bank: Boolean(d.bankLineId) } : null, mismatch: exact.mismatches.includes(r.id), proposals: proposalsBy.get(r.id) ?? [], ownParty: reviewFlag({ partyId: r.party_id }, requesterIds) === 'own_party' };
    });
    const aging = agingUnmatched(records.map((r) => ({ id: r.id, kind: r.kind, status: r.status, decidedOn: r.decided_at ? String(r.decided_at).slice(0, 10) : null, bankLineId: r.bank_line_id, upiLineId: r.upi_line_id })), todayIST()) as Json[];
    const mfa = caps.includes('approve') ? await mfaSummary(auth.staff.id) : null;
    const me = { id: auth.staff.id, ready: mfa?.ready ?? false, hasPasskey: mfa?.passkey ?? false, stepUpValid: stepUpIsValid(req, auth.staff.id) };
    return json({ me, can: { approve: caps.includes('approve'), allocate: caps.includes('allocate') }, records: out, agingCount: aging.length, today: todayIST() });
  } catch (err) {
    return serverError(err, 'list requests');
  }
}

// Accepting a suggested match. The row on the statement is read again here: the amount and direction are checked against it.
export async function matchRecord(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const b = await body(req);
  if (!b || (b.type !== 'upi' && b.type !== 'bank') || typeof b.targetId !== 'string' || !ID.test(b.targetId)) return fail('Choose a payment to match.');
  try {
    const [record] = await rows(`/fin_payment_requests?id=eq.${id}&select=${COLUMNS},entity_id`);
    if (!record) return fail('Not found', 404);
    if (record.upi_line_id || record.bank_line_id) return fail('This record is already matched. Unmatch it first.', 409);
    let target: Json | null = null;
    if (b.type === 'upi') {
      const [u] = await rows(`/fin_upi_lines?id=eq.${b.targetId}&select=id,paid_at,amount_paise,direction,bank_line_id`);
      if (u) target = { id: u.id, direction: u.direction, amountPaise: Number(u.amount_paise), date: u.paid_at, bankLineId: u.bank_line_id };
    } else {
      const [l] = await rows(`/fin_bank_lines?id=eq.${b.targetId}&select=id,tran_date,amount_paise,direction`);
      if (l) {
        const [u] = await rows(`/fin_upi_lines?bank_line_id=eq.${l.id}&select=id&limit=1`);
        target = { id: l.id, direction: l.direction, amountPaise: Number(l.amount_paise), date: l.tran_date, upiLineId: u?.id ?? null };
      }
    }
    if (!target) return fail('That payment was not found.', 404);
    // The payment is one payment: if the other side of it (the UPI row's bank line, or the bank line's UPI row) is already another
    // record's, so is this.
    const sides = [target.bankLineId && `bank_line_id=eq.${target.bankLineId}`, target.upiLineId && `upi_line_id=eq.${target.upiLineId}`, b.type === 'bank' && `bank_line_id=eq.${target.id}`, b.type === 'upi' && `upi_line_id=eq.${target.id}`].filter(Boolean) as string[];
    for (const side of sides) {
      const taken = await rows(`/fin_payment_requests?${side}&status=not.in.(rejected,cancelled)&id=neq.${id}&select=id&limit=1`);
      if (taken[0]) return fail('Another record is already matched to that payment.', 409);
    }
    const planned = planMatch({ record: { kind: record.kind, status: record.status, amountPaise: Number(record.amount_paise), bankLineId: record.bank_line_id, upiLineId: record.upi_line_id }, type: b.type, target: target as any, now: new Date().toISOString(), actorId: auth.staff.id });
    if (planned.error || !planned.patch) return fail(planned.error ?? 'Not allowed.');
    await logFinanceAction({ actorId: auth.staff.id, entityId: record.entity_id, action: 'finance.request_matched', target: id, detail: { to: b.type } });
    const res = await rest(`/fin_payment_requests?id=eq.${id}&upi_line_id=is.null&bank_line_id=is.null`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...planned.patch, updated_at: new Date().toISOString() }) });
    void res;
    return json({ ok: true });
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('Another record is already matched to that payment.', 409);
    return serverError(err, 'match');
  }
}

export async function unmatchRecord(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [record] = await rows(`/fin_payment_requests?id=eq.${id}&select=id,entity_id,kind,source,status,upi_line_id,bank_line_id`);
    if (!record) return fail('Not found', 404);
    if (!record.upi_line_id && !record.bank_line_id) return fail('This record is not matched.', 409);
    await logFinanceAction({ actorId: auth.staff.id, entityId: record.entity_id, action: 'finance.request_unmatched', target: id });
    // A request that was marked paid by the match goes back to approved; a log or a history row was always paid.
    const back = record.kind === 'request' && record.source === 'app' && record.status === 'paid' ? { status: 'approved', paid_on: null } : {};
    await rest(`/fin_payment_requests?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...back, upi_line_id: null, bank_line_id: null, matched_by: null, matched_at: null, updated_at: new Date().toISOString() }) });
    return json({ ok: true });
  } catch (err) {
    return serverError(err, 'unmatch');
  }
}

// Clearing the "payment to the requester's own party" flag: a person other than the requester looked at it.
export async function reviewRecord(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [record] = await rows(`/fin_payment_requests?id=eq.${id}&select=id,entity_id,requester_id,review_flag,reviewed_at`);
    if (!record) return fail('Not found', 404);
    if (!record.review_flag || record.reviewed_at) return fail('Nothing to review.', 409);
    if (record.requester_id === auth.staff.id) return fail('Someone else must review a payment you recorded.', 403);
    await logFinanceAction({ actorId: auth.staff.id, entityId: record.entity_id, action: 'finance.request_reviewed', target: id });
    await rest(`/fin_payment_requests?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ reviewed_by: auth.staff.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
    return json({ ok: true });
  } catch (err) {
    return serverError(err, 'review');
  }
}
