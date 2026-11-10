// The budget editor's routes (/internal/finance/budget/; docs/finance/FINANCE.md, "The budget editor"), on finance-admin.mts:
//   GET  /budget?fy=2026&v=<id>              a year's versions, the lines of one, the categories and projects to choose from, what each has
//                                            cost so far, and last year's live amounts. `finance` / `view`.
//   POST /budget/versions                    start a draft: { fy, from: 'live' | 'previous' | 'empty' }. `finance` / `configure`.
//   POST /budget/versions/:id/lines          replace a draft's lines: { lines, note }. `configure`.
//   POST /budget/versions/:id/approve        make a draft the live budget; the previous live version is superseded. `configure`.
//   POST /budget/versions/:id/discard        delete a draft. `configure`.
// Every write is written to fin_audit_log first (ids and counts only, never an amount or a label); if that fails nothing changes. The
// rules for a set of lines are scripts/lib/finance-budget.mjs, the same ones the page uses. The save and the copy are database
// functions (0099) so they either happen whole or not at all. A database without 0098/0099 answers `available: false` on reads.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { rowsAll } from './finance-ledger';
import { financialYearOf } from '../../../scripts/lib/finance-allocation.mjs';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { actualsByTarget } from '../../../scripts/lib/finance-metrics.mjs';
import { validateBudgetLines } from '../../../scripts/lib/finance-budget.mjs';

type Json = Record<string, any>;
export const BUDGET_ID = /^[0-9a-f-]{36}$/i;
const NOTE_MAX = 300;
const FIRST_YEAR = 2020;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (error: string, status = 400, extra: Json = {}) => json({ error, ...extra }, status);
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];
const rpc = async (name: string, body: Json) => (await rest(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();
const serverError = (err: unknown, what: string) => {
  console.error(`[finance-admin] budget: ${what} failed`, err);
  // A database function that does not exist answers 404 from /rpc/: the migration that adds it (0099) has not been applied.
  if (err instanceof Error && /\/rpc\/fin_(start_budget_draft|save_budget_lines)\b.*404/.test(err.message)) {
    return fail('The budget editor needs a database update that has not been applied yet (migration 0099). Ask a super admin to apply it.', 503);
  }
  return fail('Server error', 500);
};
async function readBody(req: Request): Promise<Json | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}
async function entityId(): Promise<string> {
  const [e] = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e) throw new Error('no entity');
  return e.id;
}
const audit = (actorId: string, entityId: string, action: string, target: string | undefined, detail: Json) => logFinanceAction({ actorId, action, entityId, target, detail });

async function loadCategories(): Promise<Json[]> {
  return rows('/fin_categories?select=id,name,type,head,is_salary,active&order=name.asc&limit=500').catch(() => rows('/fin_categories?select=id,name,type,active&order=name.asc&limit=500'));
}

export async function getBudget(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  const currentFy = financialYearOf(todayIST());
  const wanted = new URL(req.url).searchParams.get('fy');
  if (wanted !== null && !/^20\d\d$/.test(wanted)) return fail('Choose a financial year.');
  const fy = wanted ? Number(wanted) : currentFy;
  if (fy < FIRST_YEAR || fy > currentFy + 1) return fail('Choose a financial year from last year to next year.');
  const pick = new URL(req.url).searchParams.get('v');
  if (pick !== null && !BUDGET_ID.test(pick)) return fail('Choose a version.');

  try {
    const entity = await entityId();
    let versions: Json[];
    try {
      versions = await rows(`/fin_budget_years?select=id,version,status,approved_on,note,created_at&entity_id=eq.${entity}&financial_year=eq.${fy}&order=version.desc&limit=50`);
    } catch {
      return json({ available: false, fy, canConfigure: false });
    }
    const selected = (pick && versions.find((v) => v.id === pick)) || versions.find((v) => v.status === 'draft') || versions.find((v) => v.status === 'approved') || versions[0] || null;
    const [lines, categories, projects, prevYears, lineDirs, allocs] = await Promise.all([
      selected ? rows(`/fin_budget_lines?select=id,category_id,project_id,label,comment,annual_paise,sort_order&budget_year_id=eq.${selected.id}&order=sort_order.asc,id.asc&limit=500`) : Promise.resolve([]),
      loadCategories(),
      rows(`/fin_projects?select=id,name,kind,status&financial_year=eq.${fy}&order=name.asc&limit=200`),
      rows(`/fin_budget_years?select=id,version&entity_id=eq.${entity}&financial_year=eq.${fy - 1}&status=eq.approved&limit=1`),
      rowsAll('/fin_bank_lines?select=id,direction&order=id.asc'),
      rowsAll(`/fin_allocations?select=bank_line_id,category_id,project_id,amount_paise,period&posted_at=not.is.null&period=gte.${fy}-04-01&period=lt.${fy + 1}-04-01&order=id.asc`),
    ]);
    const dirOf = new Map(lineDirs.map((l) => [l.id, l.direction]));
    const actuals = actualsByTarget({ allocations: allocs.map((a) => ({ ...a, direction: dirOf.get(a.bank_line_id) ?? 'debit' })), categories, fy });
    let previous: Json | null = null;
    if (prevYears[0]) {
      const prevLines = await rows(`/fin_budget_lines?select=category_id,annual_paise&budget_year_id=eq.${prevYears[0].id}&category_id=not.is.null&limit=500`);
      previous = { fy: fy - 1, version: prevYears[0].version, byCategory: Object.fromEntries(prevLines.map((l) => [l.category_id, l.annual_paise])) };
    }
    return json({
      available: true, fy, currentFy, canConfigure: capabilitiesForRole('finance', auth.staff.role).includes('configure'),
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, approvedOn: v.approved_on, note: v.note, createdAt: v.created_at })),
      selected: selected ? { id: selected.id, version: selected.version, status: selected.status, approvedOn: selected.approved_on, note: selected.note } : null,
      lines: lines.map((l) => ({ id: l.id, categoryId: l.category_id, projectId: l.project_id, label: l.label, comment: l.comment, annualPaise: l.annual_paise })),
      categories: categories.map((c) => ({ id: c.id, name: c.name, type: c.type, head: c.head ?? null, isSalary: Boolean(c.is_salary), active: c.active })),
      projects: projects.filter((p) => p.status !== 'cancelled').map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      actuals, previous,
    });
  } catch (err) {
    return serverError(err, 'read');
  }
}

// The version a write is about, which must be a draft.
async function draftOf(id: string): Promise<{ year?: Json; response?: Response }> {
  const [year] = await rows(`/fin_budget_years?id=eq.${id}&select=id,entity_id,financial_year,version,status`);
  if (!year) return { response: fail('That budget version does not exist.', 404) };
  if (year.status !== 'draft') return { response: fail('Only a draft can be changed. Start a new version to change an approved budget.', 409) };
  return { year };
}

export async function startDraft(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  const currentFy = financialYearOf(todayIST());
  if (!body || !Number.isInteger(body.fy) || body.fy < FIRST_YEAR || body.fy > currentFy + 1) return fail('Choose a financial year from last year to next year.');
  if (!['live', 'previous', 'empty'].includes(body.from)) return fail('Say what to start from: the live budget, last year, or nothing.');
  try {
    const entity = await entityId();
    const [existing] = await rows(`/fin_budget_years?select=id&entity_id=eq.${entity}&financial_year=eq.${body.fy}&status=eq.draft&limit=1`);
    if (existing) return fail('There is already a draft for this year. Open it, or discard it first.', 409, { id: existing.id });
    let from: string | null = null;
    if (body.from !== 'empty') {
      const year = body.from === 'live' ? body.fy : body.fy - 1;
      const [source] = await rows(`/fin_budget_years?select=id&entity_id=eq.${entity}&financial_year=eq.${year}&status=eq.approved&limit=1`);
      if (!source) return fail(body.from === 'live' ? 'This year has no approved budget to copy.' : 'Last year has no approved budget to copy.', 409);
      from = source.id;
    }
    await audit(auth.staff.id, entity, 'finance.budget_draft_started', undefined, { fy: body.fy, from: body.from });
    const id = await rpc('fin_start_budget_draft', { p_entity: entity, p_fy: body.fy, p_from: from, p_actor: auth.staff.id });
    return json({ id }, 201);
  } catch (err) {
    if (err instanceof Error && /409|23505|duplicate/i.test(err.message)) return fail('There is already a draft for this year. Open it, or discard it first.', 409);
    return serverError(err, 'start draft');
  }
}

export async function saveLines(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > NOTE_MAX) return fail(`Keep the note to ${NOTE_MAX} characters.`);
  try {
    const { year, response } = await draftOf(id);
    if (response) return response;
    const [categories, projects] = await Promise.all([
      loadCategories(),
      rows(`/fin_projects?select=id,name,kind,status&financial_year=eq.${year!.financial_year}&limit=200`),
    ]);
    const checked = validateBudgetLines(body.lines, {
      categories: categories.map((c) => ({ id: c.id, name: c.name, active: c.active })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    });
    if (!checked.ok) return fail('Some lines need fixing.', 400, { errors: checked.errors });
    await audit(auth.staff.id, year!.entity_id, 'finance.budget_saved', id, { fy: year!.financial_year, version: year!.version, lines: checked.lines.length });
    const saved = Number(await rpc('fin_save_budget_lines', {
      p_year_id: id,
      p_lines: checked.lines.map((l: Json) => ({ category_id: l.categoryId, project_id: l.projectId, label: l.label, comment: l.comment, annual_paise: l.annualPaise, sort_order: l.sortOrder })),
      p_note: note || null,
      p_actor: auth.staff.id,
    }));
    return json({ saved });
  } catch (err) {
    return serverError(err, 'save lines');
  }
}

export async function approveDraft(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const { year, response } = await draftOf(id);
    if (response) return response;
    const anyLine = await rows(`/fin_budget_lines?select=id&budget_year_id=eq.${id}&limit=1`);
    if (!anyLine.length) return fail('Add at least one line before approving.', 409);
    await audit(auth.staff.id, year!.entity_id, 'finance.budget_approved', id, { fy: year!.financial_year, version: year!.version });
    await rpc('fin_approve_budget', { p_year_id: id, p_actor: auth.staff.id });
    return json({ ok: true });
  } catch (err) {
    return serverError(err, 'approve');
  }
}

export async function discardDraft(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const { year, response } = await draftOf(id);
    if (response) return response;
    await audit(auth.staff.id, year!.entity_id, 'finance.budget_discarded', id, { fy: year!.financial_year, version: year!.version });
    const res = await rest(`/fin_budget_years?id=eq.${id}&status=eq.draft`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    if (!((await res.json()) as Json[]).length) return fail('That draft was already gone.', 404);
    return json({ ok: true });
  } catch (err) {
    return serverError(err, 'discard');
  }
}
