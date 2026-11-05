// The ledger routes behind /api/finance-admin (docs/finance/sessions/05-ledger-and-review.md): bank lines and their
// allocations, the review queue, categorisation rules, categories and period close.
// Rules of the game live in scripts/lib/finance-allocation.mjs and finance-rules.mjs (pure, tested); the database repeats the
// money rules (supabase/migrations/0083_finance_ledger.sql) so a bug here cannot post a line that does not add up.
//
// What is audited: every save, review decision, rule change, category change and period close, with ids and counts only
// (never a name, narration or amount). The audit row is written BEFORE the change; if it cannot be written, nothing changes.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { financialYearOf, lineState, periodOf, periodWriteDecision, planPosting, planReversal } from '../../../scripts/lib/finance-allocation.mjs';
import { REVIEW_REASONS, guessPartyId, proposeAllocation, reviewReasons, validateRule } from '../../../scripts/lib/finance-rules.mjs';

type Json = Record<string, any>;
export const LEDGER_ID = /^[0-9a-f-]{36}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const CATEGORY_TYPES = ['opex', 'capex', 'revenue', 'member_contribution', 'sinking_fund', 'interest', 'tax', 'reimbursement', 'transfer'];
const PAGE = 100;
const BULK_MAX = 50;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (error: string, status = 400, extra: Json = {}) => jsonResponse({ error, ...extra }, status);
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];
const rpc = async (name: string, body: Json) => (await rest(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();

async function readBody(req: Request): Promise<Json | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}
async function entityId(): Promise<string> {
  const e = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}
const serverError = (err: unknown, what: string) => {
  console.error(`[finance-admin] ${what} failed`, err instanceof Error ? err.message : err);
  return jsonResponse({ error: 'Server error' }, 500);
};
const audit = (actorId: string, entity: string, action: string, target: string | undefined, detail?: Json) =>
  logFinanceAction({ actorId, entityId: entity, action, target, detail });

// Everything a screen needs to fill its pickers. Names only; no bank details.
async function lookups() {
  const [categories, parties, projects, entities, closed] = await Promise.all([
    rows('/fin_categories?select=id,name,type,active&order=type.asc,name.asc'),
    rows('/fin_parties?select=id,name,kind&active=eq.true&merged_into=is.null&order=name.asc'),
    rows('/fin_projects?select=id,name,kind,financial_year,status&order=financial_year.desc,name.asc'),
    rows('/fin_entities?select=id,requester_party_id&order=created_at.asc&limit=1'),
    rows('/fin_periods?select=month&status=eq.closed'),
  ]);
  return {
    categories,
    parties,
    projects,
    requesterPartyId: (entities[0]?.requester_party_id as string | null) ?? null,
    closedMonths: closed.map((p) => p.month as string),
  };
}

// ---------------------------------------------------------------- list
type LineRow = { id: string; bank_account_id: string; tran_date: string; narration: string; direction: string; amount_paise: number };

// The whole ledger is a few thousand lines, so state is worked out here instead of in SQL; the page is capped.
async function loadLedger(from: string | null, to: string | null) {
  const range = `${from ? `&tran_date=gte.${from}` : ''}${to ? `&tran_date=lte.${to}` : ''}`;
  const [lines, allocations] = await Promise.all([
    rows(`/fin_bank_lines?select=id,bank_account_id,tran_date,narration,direction,amount_paise&order=tran_date.desc,created_at.desc&limit=10000${range}`) as Promise<LineRow[]>,
    rows('/fin_allocations?select=bank_line_id,amount_paise,review_state,posted_at&limit=50000'),
  ]);
  const byLine = new Map<string, Json[]>();
  for (const a of allocations) byLine.set(a.bank_line_id, [...(byLine.get(a.bank_line_id) ?? []), a]);
  return { lines, byLine };
}

export async function listLedger(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const url = new URL(req.url);
    const filter = ['unallocated', 'review', 'all'].includes(url.searchParams.get('filter') ?? '') ? url.searchParams.get('filter')! : 'unallocated';
    const iso = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) ?? '') ? url.searchParams.get(k) : null);
    const q = (url.searchParams.get('q') ?? '').toLowerCase().trim().slice(0, 60);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const { lines, byLine } = await loadLedger(iso('from'), iso('to'));

    const summarise = (l: LineRow) => {
      const allocs = byLine.get(l.id) ?? [];
      const posted = allocs.some((a) => a.posted_at);
      return { state: posted ? 'allocated' : lineState(l, allocs), review: allocs.some((a) => a.review_state !== 'ok') };
    };
    const counts = { unallocated: 0, review: 0, all: lines.length };
    for (const l of lines) {
      const s = summarise(l);
      if (s.state !== 'allocated') counts.unallocated++;
      if (s.review) counts.review++;
    }
    const matched = lines.filter((l) => {
      const s = summarise(l);
      if (filter === 'unallocated' && s.state === 'allocated') return false;
      if (filter === 'review' && !s.review) return false;
      return !q || l.narration.toLowerCase().includes(q);
    });
    const page = matched.slice(offset, offset + PAGE);
    const ids = page.map((l) => l.id);
    const upi = ids.length ? await rows(`/fin_upi_lines?select=bank_line_id,counterparty,remarks,is_circle&bank_line_id=in.(${ids.join(',')})`) : [];
    const upiOf = new Map(upi.map((u) => [u.bank_line_id as string, u]));
    const accounts = await rows('/fin_bank_accounts?select=id,label');
    const accountLabel = new Map(accounts.map((a) => [a.id as string, a.label as string]));
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canAllocate: capabilities.includes('allocate'),
      canClose: capabilities.includes('close-period'),
      counts,
      total: matched.length,
      offset,
      lines: page.map((l) => ({
        id: l.id,
        date: l.tran_date,
        narration: l.narration,
        direction: l.direction,
        amountPaise: l.amount_paise,
        account: accountLabel.get(l.bank_account_id) ?? '',
        remark: upiOf.get(l.id)?.remarks ?? null,
        counterparty: upiOf.get(l.id)?.counterparty ?? null,
        isCircle: Boolean(upiOf.get(l.id)?.is_circle),
        allocatedPaise: (byLine.get(l.id) ?? []).reduce((n, a) => n + a.amount_paise, 0),
        ...summarise(l),
      })),
      lookups: await lookups(),
      reasons: REVIEW_REASONS,
    });
  } catch (err) {
    return serverError(err, 'ledger list');
  }
}

// ---------------------------------------------------------------- one line
// Posted allocations on lines going the other way, with how much of each is still unreversed: what a refund can undo.
async function reversibleFor(line: Json): Promise<Json[]> {
  const opposite = line.direction === 'debit' ? 'credit' : 'debit';
  const lineIds = (await rows(`/fin_bank_lines?select=id,tran_date&direction=eq.${opposite}&order=tran_date.desc&limit=3000`)) as Json[];
  if (!lineIds.length) return [];
  const dateOf = new Map(lineIds.map((l) => [l.id as string, l.tran_date as string]));
  const allocs = await rows('/fin_allocations?select=id,bank_line_id,party_id,category_id,amount_paise,nature,period,reverses_allocation_id&posted_at=not.is.null&limit=20000');
  const reversed = new Map<string, number>();
  for (const a of allocs) if (a.reverses_allocation_id) reversed.set(a.reverses_allocation_id, (reversed.get(a.reverses_allocation_id) ?? 0) + a.amount_paise);
  return allocs
    .filter((a) => dateOf.has(a.bank_line_id) && !a.reverses_allocation_id && a.amount_paise - (reversed.get(a.id) ?? 0) > 0)
    .map((a) => ({ id: a.id, date: dateOf.get(a.bank_line_id), partyId: a.party_id, categoryId: a.category_id, nature: a.nature, remainingPaise: a.amount_paise - (reversed.get(a.id) ?? 0) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 300);
}

// What the server would suggest for a line, and why it would need a person. Shared by the detail view and by save.
async function reviewContext(line: Json, upi: Json | null, ctx: Awaited<ReturnType<typeof lookups>>) {
  const [rules, allAccounts] = await Promise.all([
    rows('/fin_rules?select=id,priority,matcher,party_id,category_id,nature_template,needs_review,active&active=eq.true'),
    rows('/fin_party_accounts?select=party_id,status,retired_on&status=neq.superseded'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const stateOfParty = (partyId: string | null): 'verified' | 'unverified' | 'none' => {
    if (!partyId) return 'none';
    const live = allAccounts.filter((a) => a.party_id === partyId && !(a.retired_on && a.retired_on <= today));
    if (live.some((a) => a.status === 'verified')) return 'verified';
    return live.length ? 'unverified' : 'none';
  };
  const reimbursement = ctx.categories.find((c) => c.type === 'reimbursement' && c.active);
  return { rules, stateOfParty, reimbursementCategoryId: (reimbursement?.id as string | undefined) ?? null };
}

export async function ledgerLine(req: Request, lineId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [line] = await rows(`/fin_bank_lines?id=eq.${lineId}&select=id,bank_account_id,tran_date,narration,direction,amount_paise`);
    if (!line) return fail('That line does not exist.', 404);
    const [upi] = await rows(`/fin_upi_lines?bank_line_id=eq.${lineId}&select=counterparty,remarks,is_circle,upi_ref`);
    const allocations = await rows(`/fin_allocations?bank_line_id=eq.${lineId}&select=id,party_id,category_id,project_id,amount_paise,period,nature,remarks,source,rule_id,review_state,review_reason,reverses_allocation_id,reversal_reason,posted_at&order=created_at.asc`);
    const ctx = await lookups();
    const rc = await reviewContext(line, upi ?? null, ctx);
    const requesterIds = ctx.requesterPartyId ? [ctx.requesterPartyId] : [];
    const posted = allocations.some((a) => a.posted_at);
    let proposal = null as Json | null;
    let reasons: string[] = [];
    if (!posted && allocations.length === 0) {
      const partyId = guessPartyId(line, upi ?? null, ctx.parties);
      proposal = proposeAllocation(line, upi ?? null, rc.rules, { requesterPartyIds: requesterIds, partyId, reimbursementCategoryId: rc.reimbursementCategoryId });
      if (proposal) {
        const category = ctx.categories.find((c) => c.id === proposal!.categoryId);
        reasons = reviewReasons({ line, upi, proposal, requesterPartyIds: requesterIds, partyAccountState: rc.stateOfParty(proposal.partyId), categoryType: category?.type, hasVoucher: false });
      } else reasons = ['unexplained'];
    }
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canAllocate: capabilities.includes('allocate'),
      line: { id: line.id, date: line.tran_date, narration: line.narration, direction: line.direction, amountPaise: line.amount_paise },
      upi: upi ? { counterparty: upi.counterparty, remark: upi.remarks, isCircle: upi.is_circle } : null,
      state: posted ? 'allocated' : lineState(line, allocations),
      allocations: allocations.map((a) => ({
        id: a.id,
        partyId: a.party_id,
        categoryId: a.category_id,
        projectId: a.project_id,
        amountPaise: a.amount_paise,
        period: a.period,
        nature: a.nature,
        remarks: a.remarks,
        source: a.source,
        reviewState: a.review_state,
        reviewReason: a.review_reason,
        reversesAllocationId: a.reverses_allocation_id,
        reversalReason: a.reversal_reason,
        posted: Boolean(a.posted_at),
      })),
      proposal,
      reasons,
      reversible: capabilities.includes('allocate') && !posted ? await reversibleFor(line) : [],
      lookups: ctx,
      reasonLabels: REVIEW_REASONS,
    });
  } catch (err) {
    return serverError(err, 'ledger line');
  }
}

// ---------------------------------------------------------------- save
type SaveResult = { ok: true; saved: number; posted: boolean; override: boolean } | { ok: false; status: number; error: string };

// Validates a person's rows for one line, works out the review flags, writes the audit row, then saves through the database
// function (which checks the sums again). `input`: { rows, post, overrideReason }.
async function saveLine(staff: { id: string }, capabilities: string[], lineId: string, input: Json): Promise<SaveResult> {
  const [line] = await rows(`/fin_bank_lines?id=eq.${lineId}&select=id,entity_id,tran_date,direction,amount_paise`);
  if (!line) return { ok: false, status: 404, error: 'That line does not exist.' };
  const existing = await rows(`/fin_allocations?bank_line_id=eq.${lineId}&select=id,posted_at`);
  if (existing.some((a) => a.posted_at)) return { ok: false, status: 409, error: 'This line is already posted. Correct it with a refund or reversal, not by editing.' };
  const post = Boolean(input.post);
  const inputRows: Json[] = Array.isArray(input.rows) ? input.rows : [];
  if (inputRows.length > 40) return { ok: false, status: 400, error: 'That is too many rows for one line.' };

  const ctx = await lookups();
  const categoryById = new Map(ctx.categories.map((c) => [c.id as string, c]));
  const partyIds = new Set(ctx.parties.map((p) => p.id as string));
  const projectIds = new Set(ctx.projects.map((p) => p.id as string));
  const [upi] = await rows(`/fin_upi_lines?bank_line_id=eq.${lineId}&select=counterparty,remarks,is_circle`);
  const rc = await reviewContext(line, upi ?? null, ctx);
  const requesterIds = ctx.requesterPartyId ? [ctx.requesterPartyId] : [];

  // Reversal rows take their category and party from the allocation they undo.
  const prepared: Json[] = [];
  const reversalChecks: string[] = [];
  for (const [i, r] of inputRows.entries()) {
    if (r.reversesAllocationId) {
      if (!LEDGER_ID.test(String(r.reversesAllocationId))) return { ok: false, status: 400, error: `Row ${i + 1}: choose what to reverse.` };
      const [orig] = await rows(`/fin_allocations?id=eq.${r.reversesAllocationId}&select=id,party_id,category_id,project_id,amount_paise,nature,reverses_allocation_id,posted_at,bank_line_id`);
      if (!orig || !orig.posted_at) return { ok: false, status: 400, error: `Row ${i + 1}: that allocation cannot be reversed.` };
      const [origLine] = await rows(`/fin_bank_lines?id=eq.${orig.bank_line_id}&select=direction`);
      const prior = await rows(`/fin_allocations?reverses_allocation_id=eq.${orig.id}&select=amount_paise`);
      const siblings = prepared.filter((p) => p.reversesAllocationId === orig.id).reduce((n, p) => n + p.amountPaise, 0);
      const check = planReversal({ ...orig, direction: origLine?.direction }, [...prior, { amount_paise: siblings }], line, { amountPaise: r.amountPaise, reason: r.reversalReason });
      if (!check.ok) return { ok: false, status: 400, error: `Row ${i + 1}: ${check.errors[0]}` };
      reversalChecks.push(orig.id);
      prepared.push({ ...r, categoryId: orig.category_id, partyId: orig.party_id, projectId: orig.project_id, nature: String(r.nature ?? '').trim() || `Reversal: ${orig.nature}`, source: 'manual' });
    } else prepared.push({ ...r, source: ['manual', 'rule', 'upi_remark'].includes(r.source) ? r.source : 'manual' });
  }

  const plan = planPosting(line, prepared, { allowRemainder: !post });
  if (!plan.ok) return { ok: false, status: 400, error: plan.errors[0] };
  for (const [i, r] of plan.rows.entries()) {
    const category = categoryById.get(r.categoryId);
    if (!category || (!category.active && !r.reversesAllocationId)) return { ok: false, status: 400, error: `Row ${i + 1}: choose an active category.` };
    if (r.partyId && !partyIds.has(r.partyId) && !r.reversesAllocationId) return { ok: false, status: 400, error: `Row ${i + 1}: that party is not in the directory.` };
    if (r.projectId && !projectIds.has(r.projectId)) return { ok: false, status: 400, error: `Row ${i + 1}: that project does not exist.` };
  }

  // A closed month needs close-period and a reason.
  const months = [...new Set(plan.rows.map((r) => r.period))];
  const closed = new Set(ctx.closedMonths.map((m) => String(m).slice(0, 10)));
  let override = false;
  for (const m of months) {
    const d = periodWriteDecision(closed.has(m) ? 'closed' : 'open', capabilities, String(input.overrideReason ?? ''));
    if (!d.ok) return { ok: false, status: 403, error: d.error ?? 'That month is closed.' };
    if (d.override) override = true;
  }

  // Review flags per row, from the same pure rules the screen showed.
  const reasonCounts: Record<string, number> = {};
  const dbRows = plan.rows.map((r) => {
    let reasons: string[] = [];
    if (!r.reversesAllocationId) {
      const rule = r.ruleId ? rc.rules.find((x) => x.id === r.ruleId) : null;
      reasons = reviewReasons({
        line,
        upi: upi ?? null,
        proposal: { partyId: r.partyId ?? null, categoryId: r.categoryId, source: r.source, needsReview: Boolean(rule?.needs_review) },
        requesterPartyIds: requesterIds,
        partyAccountState: rc.stateOfParty(r.partyId ?? null),
        categoryType: categoryById.get(r.categoryId)?.type,
        hasVoucher: false,
      });
    }
    for (const x of reasons) reasonCounts[x] = (reasonCounts[x] ?? 0) + 1;
    return {
      party_id: r.partyId ?? null,
      category_id: r.categoryId,
      project_id: r.projectId ?? null,
      amount_paise: r.amountPaise,
      period: r.period,
      nature: r.nature,
      remarks: r.remarks ? String(r.remarks).slice(0, 300) : null,
      source: r.source,
      rule_id: r.source === 'rule' && r.ruleId && LEDGER_ID.test(r.ruleId) ? r.ruleId : null,
      review_state: reasons.length ? 'needs_review' : 'ok',
      review_reason: reasons.length ? reasons.join(',') : null,
      reverses_allocation_id: r.reversesAllocationId ?? null,
      reversal_reason: r.reversesAllocationId ? r.reason ?? r.reversalReason : null,
    };
  });

  await audit(staff.id, line.entity_id, post ? 'finance.allocations_posted' : 'finance.allocations_drafted', lineId, {
    rows: dbRows.length,
    reversals: reversalChecks.length,
    override,
    reviewReasons: reasonCounts,
    periods: months,
  });
  try {
    await rpc('fin_save_allocations', { p_line_id: lineId, p_rows: dbRows, p_actor: staff.id, p_post: post, p_override: override });
  } catch (err) {
    console.error('[finance-admin] save allocations failed', err instanceof Error ? err.message : err);
    return { ok: false, status: 409, error: 'This line changed while you were editing it, or does not add up. Reload and try again.' };
  }
  for (const id of new Set(dbRows.map((r) => r.rule_id).filter(Boolean))) {
    if (post) {
      const [rule] = await rows(`/fin_rules?id=eq.${id}&select=hit_count`);
      if (rule) await rest(`/fin_rules?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ hit_count: rule.hit_count + 1 }) });
    }
  }
  return { ok: true, saved: dbRows.length, posted: post, override };
}

export async function saveAllocations(req: Request, lineId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const result = await saveLine(auth.staff, capabilitiesForRole('finance', auth.staff.role) as string[], lineId, body);
    return result.ok ? jsonResponse({ saved: result.saved, posted: result.posted }) : fail(result.error, result.status);
  } catch (err) {
    return serverError(err, 'save allocations');
  }
}

// One category, party and nature applied to many lines, each in full. Lines that already have rows are skipped and listed.
export async function bulkAllocate(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  const lineIds: string[] = Array.isArray(body?.lineIds) ? body!.lineIds : [];
  if (!body || !lineIds.length || lineIds.length > BULK_MAX || !lineIds.every((id) => LEDGER_ID.test(String(id)))) {
    return fail(`Choose between 1 and ${BULK_MAX} lines.`);
  }
  try {
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const t = (body.row ?? {}) as Json;
    const failed: { lineId: string; error: string }[] = [];
    let saved = 0;
    for (const lineId of lineIds) {
      const [line] = await rows(`/fin_bank_lines?id=eq.${lineId}&select=amount_paise,tran_date`);
      if (!line) {
        failed.push({ lineId, error: 'No such line.' });
        continue;
      }
      const result = await saveLine(auth.staff, capabilities, lineId, {
        post: true,
        overrideReason: body.overrideReason,
        rows: [{ amountPaise: line.amount_paise, categoryId: t.categoryId, partyId: t.partyId || null, projectId: t.projectId || null, nature: t.nature, remarks: t.remarks, period: t.period || undefined, source: 'manual' }],
      });
      if (result.ok) saved++;
      else failed.push({ lineId, error: result.error });
    }
    return jsonResponse({ saved, failed });
  } catch (err) {
    return serverError(err, 'bulk allocate');
  }
}

// ---------------------------------------------------------------- review
export async function reviewAllocation(req: Request, allocationId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body || !['resolve', 'flag'].includes(body.action)) return fail('Say whether to resolve or flag it.');
  try {
    const [a] = await rows(`/fin_allocations?id=eq.${allocationId}&select=id,entity_id,review_state,review_reason,posted_at,created_by`);
    if (!a) return fail('That allocation does not exist.', 404);
    if (body.action === 'resolve' && a.review_state === 'ok') return fail('Nothing to resolve: it is already clear.', 409);
    // Whoever saved the allocation does not clear its review (maker is not checker), unless they are a director.
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    if (body.action === 'resolve' && a.created_by === auth.staff.id && !capabilities.includes('approve')) {
      return fail('Someone else needs to review this. You entered it.', 403);
    }
    await audit(auth.staff.id, a.entity_id, body.action === 'resolve' ? 'finance.review_resolved' : 'finance.review_flagged', allocationId, { was: a.review_state });
    const patch = body.action === 'resolve'
      ? { review_state: 'ok', reviewed_by: auth.staff.id, reviewed_at: new Date().toISOString() }
      : { review_state: 'flagged', review_reason: a.review_reason ?? 'manual', reviewed_by: null, reviewed_at: null };
    await rest(`/fin_allocations?id=eq.${allocationId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'review');
  }
}

// ---------------------------------------------------------------- rules
const ruleForResponse = (r: Json) => ({
  id: r.id, priority: r.priority, matcher: r.matcher, partyId: r.party_id, categoryId: r.category_id,
  natureTemplate: r.nature_template, needsReview: r.needs_review, hitCount: r.hit_count, active: r.active,
});

export async function listRules(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const rules = await rows('/fin_rules?select=id,priority,matcher,party_id,category_id,nature_template,needs_review,hit_count,active&order=priority.asc,created_at.asc');
    return jsonResponse({ canConfigure: capabilities.includes('configure'), rules: rules.map(ruleForResponse), lookups: await lookups() });
  } catch (err) {
    return serverError(err, 'rules list');
  }
}

function ruleFromBody(body: Json) {
  const m = (body.matcher ?? {}) as Json;
  const matcher: Json = {};
  if (String(m.narrationContains ?? '').trim()) matcher.narrationContains = String(m.narrationContains).trim();
  const keywords = (Array.isArray(m.remarkKeywords) ? m.remarkKeywords : []).map((k: unknown) => String(k).trim()).filter(Boolean);
  if (keywords.length) matcher.remarkKeywords = keywords;
  if (m.direction) matcher.direction = m.direction;
  if (m.minPaise != null && m.minPaise !== '') matcher.minPaise = m.minPaise;
  if (m.maxPaise != null && m.maxPaise !== '') matcher.maxPaise = m.maxPaise;
  return { matcher, categoryId: body.categoryId, partyId: body.partyId || null, natureTemplate: String(body.natureTemplate ?? '').slice(0, 200), needsReview: Boolean(body.needsReview), priority: body.priority == null ? 100 : Number(body.priority) };
}

export async function saveRule(req: Request, ruleId: string | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const entity = await entityId();
    if (ruleId && body.active !== undefined && Object.keys(body).length === 1) {
      await audit(auth.staff.id, entity, body.active ? 'finance.rule_enabled' : 'finance.rule_disabled', ruleId);
      await rest(`/fin_rules?id=eq.${ruleId}`, { method: 'PATCH', body: JSON.stringify({ active: Boolean(body.active) }) });
      return jsonResponse({ ok: true });
    }
    const r = ruleFromBody(body);
    const checked = validateRule(r);
    if (!checked.ok) return fail(checked.errors[0]);
    const ctx = await lookups();
    if (!ctx.categories.some((c) => c.id === r.categoryId && c.active)) return fail('Choose an active category.');
    if (r.partyId && !ctx.parties.some((p) => p.id === r.partyId)) return fail('That party is not in the directory.');
    const row = { matcher: r.matcher, category_id: r.categoryId, party_id: r.partyId, nature_template: r.natureTemplate, needs_review: r.needsReview, priority: r.priority };
    if (ruleId) {
      await audit(auth.staff.id, entity, 'finance.rule_changed', ruleId);
      await rest(`/fin_rules?id=eq.${ruleId}`, { method: 'PATCH', body: JSON.stringify(row) });
      return jsonResponse({ id: ruleId });
    }
    await audit(auth.staff.id, entity, 'finance.rule_added', undefined);
    const res = await rest('/fin_rules', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, entity_id: entity, created_by: auth.staff.id }) });
    const [created] = (await res.json()) as Json[];
    return jsonResponse({ id: created.id }, 201);
  } catch (err) {
    return serverError(err, 'save rule');
  }
}

// ---------------------------------------------------------------- categories and settings
export async function saveCategory(req: Request, categoryId: string | null, action: 'merge' | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const entity = await entityId();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!categoryId) {
      if (name.length < 3 || name.length > 60) return fail('Give the category a name of 3 to 60 characters.');
      if (!CATEGORY_TYPES.includes(body.type)) return fail('Choose what kind of category it is.');
      await audit(auth.staff.id, entity, 'finance.category_added', undefined, { type: body.type });
      const res = await rest('/fin_categories', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, name, type: body.type, budget_head: body.type !== 'transfer' }) });
      const [created] = (await res.json()) as Json[];
      return jsonResponse({ id: created.id }, 201);
    }
    if (action === 'merge') {
      if (!LEDGER_ID.test(String(body.into))) return fail('Choose the category to merge into.');
      const [from] = await rows(`/fin_categories?id=eq.${categoryId}&select=id,type`);
      const [into] = await rows(`/fin_categories?id=eq.${body.into}&select=id,type,active`);
      if (!from || !into) return fail('That category does not exist.', 404);
      if (from.id === into.id) return fail('Choose two different categories.');
      if (from.type !== into.type) return fail('Only categories of the same type can be merged, so no budget figure changes.', 409);
      if (!into.active) return fail('Merge into an active category.', 409);
      await audit(auth.staff.id, entity, 'finance.category_merged', categoryId, { into: body.into });
      const moved = Number(await rpc('fin_merge_category', { p_from: categoryId, p_to: body.into, p_actor: auth.staff.id }));
      return jsonResponse({ moved });
    }
    const patch: Json = {};
    if (name) {
      if (name.length < 3 || name.length > 60) return fail('Give the category a name of 3 to 60 characters.');
      patch.name = name;
    }
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (!Object.keys(patch).length) return fail('Nothing to change.');
    await audit(auth.staff.id, entity, 'finance.category_changed', categoryId, { fields: Object.keys(patch) });
    const res = await rest(`/fin_categories?id=eq.${categoryId}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!((await res.json()) as Json[]).length) return fail('That category does not exist.', 404);
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof Error && /409/.test(err.message)) return fail('A category with that name already exists.', 409);
    return serverError(err, 'save category');
  }
}

// Move chosen posted allocations to another category (splitting a category). A change of type moves them between budget
// buckets, so it needs `confirmTypeChange`.
export async function recategorise(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  const ids: string[] = Array.isArray(body?.allocationIds) ? body!.allocationIds : [];
  if (!body || !ids.length || ids.length > 500 || !ids.every((i) => LEDGER_ID.test(String(i))) || !LEDGER_ID.test(String(body.to))) return fail('Choose the allocations and the category to move them to.');
  try {
    const entity = await entityId();
    const [to] = await rows(`/fin_categories?id=eq.${body.to}&select=id,type,active`);
    if (!to || !to.active) return fail('Choose an active category.');
    const current = await rows(`/fin_allocations?id=in.(${ids.join(',')})&select=category_id`);
    const types = new Map((await rows('/fin_categories?select=id,type')).map((c) => [c.id as string, c.type as string]));
    const changesType = current.some((a) => types.get(a.category_id) !== to.type);
    if (changesType && !body.confirmTypeChange) return fail('That changes the budget bucket of some of them. Confirm to go ahead.', 409, { needsConfirmation: true });
    await audit(auth.staff.id, entity, 'finance.allocations_recategorised', body.to, { count: ids.length, changesType });
    const moved = Number(await rpc('fin_recategorise_allocations', { p_ids: ids, p_to: body.to, p_actor: auth.staff.id }));
    return jsonResponse({ moved });
  } catch (err) {
    return serverError(err, 'recategorise');
  }
}

export async function setRequester(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body || (body.partyId !== null && !LEDGER_ID.test(String(body.partyId)))) return fail('Choose a party, or none.');
  try {
    const entity = await entityId();
    if (body.partyId && !(await lookups()).parties.some((p) => p.id === body.partyId)) return fail('That party is not in the directory.');
    await audit(auth.staff.id, entity, 'finance.requester_set', body.partyId ?? undefined);
    await rest(`/fin_entities?id=eq.${entity}`, { method: 'PATCH', body: JSON.stringify({ requester_party_id: body.partyId }) });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'set requester');
  }
}

// ---------------------------------------------------------------- periods
export async function listPeriods(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const { lines, byLine } = await loadLedger(null, null);
    const periods = await rows('/fin_periods?select=month,status,closed_at');
    const allocations = await rows('/fin_allocations?select=period,review_state&review_state=neq.ok&limit=50000');
    const status = new Map(periods.map((p) => [String(p.month).slice(0, 10), p]));
    const months = new Map<string, { unallocated: number; review: number }>();
    const slot = (m: string) => months.get(m) ?? (months.set(m, { unallocated: 0, review: 0 }), months.get(m)!);
    for (const l of lines) {
      const allocs = byLine.get(l.id) ?? [];
      const m = periodOf(l.tran_date);
      slot(m);
      if (!allocs.some((a) => a.posted_at)) slot(m).unallocated++;
    }
    for (const a of allocations) slot(String(a.period).slice(0, 10)).review++;
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canClose: capabilities.includes('close-period'),
      months: [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, c]) => ({ month, financialYear: financialYearOf(month), status: status.get(month)?.status ?? 'open', closedAt: status.get(month)?.closed_at ?? null, ...c })),
    });
  } catch (err) {
    return serverError(err, 'periods list');
  }
}

export async function closePeriod(req: Request, month: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'close-period');
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!MONTH.test(month)) return fail('That is not a month.');
  try {
    const entity = await entityId();
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const [lines, review] = await Promise.all([
      rows(`/fin_bank_lines?select=id&tran_date=gte.${month}&tran_date=lt.${next}&limit=5000`),
      rows(`/fin_allocations?select=id&period=eq.${month}&review_state=neq.ok&limit=5000`),
    ]);
    const posted = lines.length ? await rows(`/fin_allocations?select=bank_line_id&bank_line_id=in.(${lines.map((l) => l.id).join(',')})&posted_at=not.is.null&limit=50000`) : [];
    const done = new Set(posted.map((a) => a.bank_line_id));
    const unallocated = lines.filter((l) => !done.has(l.id)).length;
    if (unallocated > 0 || review.length > 0) {
      return fail('This month is not ready to close.', 409, { unallocated, needsReview: review.length });
    }
    await audit(auth.staff.id, entity, 'finance.period_closed', month);
    await rpc('fin_close_period', { p_entity: entity, p_month: month, p_actor: auth.staff.id });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'close period');
  }
}
